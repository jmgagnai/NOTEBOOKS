import type { Pool } from "pg";
import { z } from "zod";
import { publishAppEvent } from "../events/bus.js";
import { notebookTopic } from "../events/schema.js";
import type { DocumentStatus } from "../documents/schema.js";
import { resolveTaskModels, type TaskModels } from "../llm/models.js";
import type { ChatCompleter } from "../llm/openrouter.js";
import { DOCUMENT_VERSION_STATUS_CHANGED } from "./convert-to-markdown.js";
import { generateArtifacts, type DocumentMetadata, type GeneratedArtifacts } from "./generated-artifacts.js";

/**
 * The pg_boss queue name for ingestion stage 2 — metadata extraction and the
 * three Generated document artifacts (NBK-7). Its own queue, chained off
 * stage 1, so per ADR-0004 it retries independently: a rate-limited
 * OpenRouter call never re-runs a Docling conversion.
 */
export const SUMMARIZE_DOCUMENT_QUEUE = "summarize-document";

/** Ids only, same as stage 1: the job re-reads current truth on every retry. */
export const summarizeDocumentPayloadSchema = z.object({
  documentId: z.string().uuid(),
  versionId: z.string().uuid(),
});
export type SummarizeDocumentPayload = z.infer<typeof summarizeDocumentPayloadSchema>;

export interface SummarizeDocumentDeps {
  pool: Pool;
  /** The OpenRouter boundary. Seam-2 tests stub the `fetch` underneath it. */
  complete: ChatCompleter;
  /** Fixed model per task type. Defaults to the server-side configuration. */
  models?: TaskModels;
  /** Parallel map-pass calls. Defaults to the generation module's own default. */
  mapConcurrency?: number;
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

interface VersionRow {
  notebook_id: string;
  filename: string;
  markdown: string | null;
}

interface TransitionFields {
  metadata?: DocumentMetadata;
  artifacts?: GeneratedArtifacts;
  error?: string | null;
}

/**
 * Updates a Document Version's ingestion status (and, on success, its
 * metadata and three artifacts) and announces the change, in one
 * transaction. `pg_notify` is transactional, so a status nobody committed is
 * never announced. Mirrors stage 1's `transitionTo` deliberately — the
 * lifecycle contract is the same one, extended.
 */
async function transitionTo(
  pool: Pool,
  version: VersionRow & { documentId: string; versionId: string },
  status: DocumentStatus,
  fields: TransitionFields = {},
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE document_versions
       SET ingestion_status = $2,
           metadata = COALESCE($3::jsonb, metadata),
           chat_snippet = COALESCE($4, chat_snippet),
           executive_summary = COALESCE($5, executive_summary),
           abstract = COALESCE($6, abstract),
           ingestion_error = $7,
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
      ],
    );
    await publishAppEvent(client, {
      type: DOCUMENT_VERSION_STATUS_CHANGED,
      topic: notebookTopic(version.notebook_id),
      data: {
        notebookId: version.notebook_id,
        documentId: version.documentId,
        versionId: version.versionId,
        filename: version.filename,
        status,
        ...(fields.error ? { error: fields.error } : {}),
      },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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

  const { rows } = await pool.query<VersionRow>(
    `SELECT d.notebook_id, d.filename, v.markdown
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

  const version = { ...row, documentId: payload.documentId, versionId: payload.versionId };

  if (row.markdown === null || row.markdown.trim() === "") {
    // Stage 2's input is missing, which means stage 1 either hasn't run or
    // produced nothing. Recorded as an error and thrown so it retries — a
    // re-enqueued stage 1 can still fill this in.
    const message = "Stage 2 found no Converted Markdown on this Document Version.";
    await transitionTo(pool, version, willRetry ? "converted" : "failed", { error: message });
    throw new Error(message);
  }

  await transitionTo(pool, version, "summarizing");

  try {
    const result = await generateArtifacts(
      {
        complete: deps.complete,
        models: deps.models ?? resolveTaskModels(),
        ...(deps.mapConcurrency === undefined ? {} : { mapConcurrency: deps.mapConcurrency }),
      },
      { filename: row.filename, markdown: row.markdown },
    );
    await transitionTo(pool, version, "summarized", {
      metadata: result.metadata,
      artifacts: result.artifacts,
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await transitionTo(pool, version, willRetry ? "converted" : "failed", { error: message });
    throw err;
  }
}
