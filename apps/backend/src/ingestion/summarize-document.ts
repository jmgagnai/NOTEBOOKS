import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { inTransaction } from '../db/transaction.js';
import { publishAppEvent } from '../events/bus.js';
import type { DocumentStatus } from '../documents/schema.js';
import { resolveTaskModels, type TaskModels } from '../llm/models.js';
import type { ChatCompleter } from '../llm/openrouter.js';
import {
  generateArtifacts,
  type ArtifactWarning,
  type DocumentMetadata,
  type GeneratedArtifacts,
  type SectionSummaryStore,
} from './generated-artifacts.js';
import {
  documentVersionRefSchema,
  versionStatusChanged,
  type DocumentVersionRef,
  type IngestionVersion,
} from './stage.js';

/**
 * The pg_boss queue name for ingestion stage 2 — metadata extraction and the
 * three Generated document artifacts (NBK-7). Its own queue, chained off
 * stage 1, so per ADR-0004 it retries independently: a rate-limited
 * OpenRouter call never re-runs a Docling conversion.
 */
export const SUMMARIZE_DOCUMENT_QUEUE = 'summarize-document';

/** Ids only, same as stage 1: the job re-reads current truth on every retry. */
export const summarizeDocumentPayloadSchema = documentVersionRefSchema;
export type SummarizeDocumentPayload = DocumentVersionRef;

export interface SummarizeDocumentDeps {
  pool: Pool;
  /** The OpenRouter boundary. Seam-2 tests stub the `fetch` underneath it. */
  complete: ChatCompleter;
  /** Fixed model per task type. Defaults to the server-side configuration. */
  models?: TaskModels;
  /** Parallel map-pass calls. Defaults to the generation module's own default. */
  mapConcurrency?: number;
  /**
   * Hands this Document Version to ingestion stage 3 (NBK-8). The same
   * chaining, and for the same reason, as stage 1's `enqueueSummarizeDocument`
   * (see convert-to-markdown.ts): a plain callback rather than the `JobQueue`,
   * because `startJobQueue` builds the queue *from* these deps.
   *
   * Omitted, stage 2 still succeeds and the Version simply stays
   * "summarized" — which is what keeps this handler testable without stage 3
   * in the picture.
   */
  enqueueEmbedChunks?: (payload: { documentId: string; versionId: string }) => Promise<void>;
}

export interface SummarizeDocumentInvocation {
  payload: SummarizeDocumentPayload;
  /**
   * Whether pg_boss still has a retry left. Same contract as stage 1: with a
   * retry pending the Version goes back to the status stage 2 *consumes*
   * ("converted") rather than forward or to "failed", so a retry finds exactly
   * the state it expects and the UI shows work still owed rather than a
   * failure that hasn't happened yet.
   */
  willRetry: boolean;
}

/** Stage 2's own input: the Converted Markdown, and any resumable progress. */
interface VersionRow {
  markdown: string | null;
  section_summaries: CachedSectionSummaries | null;
}

interface TransitionFields {
  metadata?: DocumentMetadata;
  artifacts?: GeneratedArtifacts;
  error?: string | null;
  /**
   * Artifacts that shipped outside their required size. `undefined` leaves
   * the column alone; an empty array clears it. See migration 0011.
   */
  warnings?: ArtifactWarning[];
  /** Given, clears the resumable section-summary cache (see below). */
  clearSectionSummaries?: boolean;
}

/**
 * What `document_versions.section_summaries` holds between attempts: the
 * fingerprint of the Converted Markdown the summaries were derived from, and
 * the summaries themselves keyed by section index.
 *
 * Keyed by index, in an object rather than an array, because the map pass
 * writes four summaries concurrently and each write is a `jsonb_set` of its
 * own key — two concurrent read-modify-writes of one array would lose one.
 */
interface CachedSectionSummaries {
  fingerprint: string;
  summaries: Record<string, string>;
}

/**
 * Identifies the exact Converted Markdown a cache of section summaries was
 * built from.
 *
 * Section indexes only mean anything against the text they were derived from,
 * and stage 1 can legitimately re-run against the same Version id and leave
 * different Markdown behind. Without this, a retry after such a re-conversion
 * would reduce last attempt's summaries of text that is no longer in the
 * document — the worst kind of wrong, because every status says `summarized`
 * and only the content is a lie.
 */
function fingerprintOf(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

/**
 * The resumable half of stage 2 (NBK-1's operator story; see ADR-0006 and
 * migration 0011), backed by one JSONB column.
 *
 * Reads the cache once up front and writes each new summary as it completes.
 * A cache whose fingerprint does not match the Markdown in hand is treated as
 * absent, so the only way to reuse a summary is for it to describe the text
 * actually being summarized.
 */
function sectionSummaryStore(
  pool: Pool,
  versionId: string,
  markdown: string,
  cached: CachedSectionSummaries | null,
): SectionSummaryStore {
  const fingerprint = fingerprintOf(markdown);
  const completed = new Map<number, string>();
  if (cached?.fingerprint === fingerprint) {
    for (const [index, summary] of Object.entries(cached.summaries ?? {})) {
      completed.set(Number(index), summary);
    }
  }

  return {
    completed,
    async record(index, summary) {
      // One statement per summary, and `jsonb_set` rather than a read-modify-
      // write, so concurrent map-pass runners cannot overwrite each other's
      // keys. Dozens of tiny UPDATEs over several minutes is nothing next to
      // the OpenRouter calls they are protecting.
      //
      // The whole value is replaced when the stored fingerprint is stale (or
      // absent), which is what makes the first write of an attempt against
      // changed Markdown discard the previous attempt's summaries wholesale.
      await pool.query(
        `UPDATE document_versions
         SET section_summaries = jsonb_set(
               CASE
                 WHEN section_summaries ->> 'fingerprint' = $2
                   THEN section_summaries
                 ELSE jsonb_build_object('fingerprint', $2::text, 'summaries', '{}'::jsonb)
               END,
               ARRAY['summaries', $3::text],
               to_jsonb($4::text),
               true
             )
         WHERE id = $1`,
        [versionId, fingerprint, String(index), summary],
      );
    },
  };
}

/**
 * Updates a Document Version's ingestion status (and, on success, its
 * metadata and three artifacts) and announces the change, in one
 * transaction. `pg_notify` is transactional, so a status nobody committed is
 * never announced.
 *
 * Stage 2's own `UPDATE`: the extracted metadata, the three Generated
 * document artifacts, `summarized_at`, and the two operational columns of
 * migration 0011 are all columns no other Stage writes. The transaction
 * wrapper and the event envelope are shared (`db/transaction.ts`,
 * `stage.ts`); which *status* to move to is decided by the caller below.
 */
async function transitionTo(
  pool: Pool,
  version: IngestionVersion,
  status: DocumentStatus,
  fields: TransitionFields = {},
): Promise<void> {
  await inTransaction(pool, async (client) => {
    await client.query(
      `UPDATE document_versions
       SET ingestion_status = $2,
           metadata = COALESCE($3::jsonb, metadata),
           chat_snippet = COALESCE($4, chat_snippet),
           executive_summary = COALESCE($5, executive_summary),
           abstract = COALESCE($6, abstract),
           ingestion_error = $7,
           -- NULL for "nothing to report", so an operator querying this
           -- column never has to tell NULL and [] apart. $8 is NULL both
           -- when no artifacts were generated on this transition and when
           -- all three fitted.
           artifact_warnings = CASE WHEN $9 THEN $8::jsonb ELSE artifact_warnings END,
           -- The resumable cache is scratch space, dropped once its
           -- summaries have been reduced into the three artifacts.
           section_summaries = CASE WHEN $10 THEN NULL ELSE section_summaries END,
           summarized_at = CASE WHEN $2 = 'summarized' THEN now() ELSE summarized_at END
       WHERE id = $1`,
      [
        version.versionId,
        status,
        fields.metadata ? JSON.stringify(fields.metadata) : null,
        fields.artifacts?.chatSnippet ?? null,
        fields.artifacts?.executiveSummary ?? null,
        fields.artifacts?.abstract ?? null,
        fields.error ?? null,
        fields.warnings && fields.warnings.length > 0 ? JSON.stringify(fields.warnings) : null,
        fields.warnings !== undefined,
        fields.clearSectionSummaries === true,
      ],
    );
    await publishAppEvent(client, versionStatusChanged(version, status, fields.error));
  });
}

/**
 * Ingestion stage 2 (NBK-7): extract metadata, then generate the Chat
 * Snippet, Executive Summary and Abstract for one converted Document
 * Version.
 *
 * It reads the Converted Markdown off the Version and nothing else — per
 * GLOSSARY.md that is "the single input every later Stage and every Generated
 * document artifact reads from", so object storage is not in this stage's
 * path at all.
 *
 * Summarization is map-reduce (NBK-1): every header-delimited section is
 * summarized on its own, and those section summaries are reduced into each of
 * the three artifacts. A Document can run past 200 pages, so no step here
 * ever puts a whole document in one prompt.
 *
 * Throws on failure (after recording it) so pg_boss sees the attempt fail and
 * applies its retry policy.
 */
export async function runSummarizeDocumentJob(
  deps: SummarizeDocumentDeps,
  { payload, willRetry }: SummarizeDocumentInvocation,
): Promise<void> {
  const { pool } = deps;

  const { rows } = await pool.query<VersionRow & { notebook_id: string; filename: string }>(
    `SELECT d.notebook_id, d.filename, v.markdown, v.section_summaries
     FROM document_versions v
     JOIN documents d ON d.id = v.document_id
     WHERE v.id = $1 AND v.document_id = $2 AND v.deleted_at IS NULL`,
    [payload.versionId, payload.documentId],
  );
  const row = rows[0];
  if (!row) {
    // Hard-deleted (or never existed) between enqueue and now: nothing to
    // summarize and nothing to retry, so don't make pg_boss keep trying.
    return;
  }

  const version: IngestionVersion = {
    notebookId: row.notebook_id,
    filename: row.filename,
    documentId: payload.documentId,
    versionId: payload.versionId,
  };

  if (row.markdown === null || row.markdown.trim() === '') {
    // Stage 2's input is missing, which means stage 1 either hasn't run or
    // produced nothing. Recorded as an error and thrown so it retries — a
    // re-enqueued stage 1 can still fill this in.
    const message = 'Stage 2 found no Converted Markdown on this Document Version.';
    await transitionTo(pool, version, willRetry ? 'converted' : 'failed', { error: message });
    throw new Error(message);
  }

  await transitionTo(pool, version, 'summarizing');

  try {
    const result = await generateArtifacts(
      {
        complete: deps.complete,
        models: deps.models ?? resolveTaskModels(),
        ...(deps.mapConcurrency === undefined ? {} : { mapConcurrency: deps.mapConcurrency }),
        // What makes a retry cost three calls instead of forty, for a stage
        // whose map pass is essentially its whole bill. See ADR-0006.
        sectionSummaries: sectionSummaryStore(
          pool,
          version.versionId,
          row.markdown,
          row.section_summaries,
        ),
      },
      { filename: row.filename, markdown: row.markdown },
    );
    await transitionTo(pool, version, 'summarized', {
      metadata: result.metadata,
      artifacts: result.artifacts,
      error: null,
      warnings: result.warnings,
      clearSectionSummaries: true,
    });

    // Enqueued only after the summaries are committed, and thrown rather than
    // logged if it fails — the same contract as stage 1's hand-over, for the
    // same reason: this caller is already a retryable job, and a swallowed
    // failure would leave the Version sitting at "summarized" with nothing
    // coming for it. Re-running the summaries on the retry costs OpenRouter
    // calls; a silently stalled pipeline is a bug.
    if (deps.enqueueEmbedChunks) {
      await deps.enqueueEmbedChunks({
        documentId: payload.documentId,
        versionId: payload.versionId,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await transitionTo(pool, version, willRetry ? 'converted' : 'failed', { error: message });
    throw err;
  }
}
