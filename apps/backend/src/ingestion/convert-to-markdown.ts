import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';
import { inTransaction } from '../db/transaction.js';
import { publishAppEvent } from '../events/bus.js';
import { getObject } from '../storage/s3-client.js';
import type { DocumentStatus } from '../documents/schema.js';
import { markdownOutputPath, type MarkdownConverter } from './docling.js';
import {
  attemptFailed,
  documentVersionRefSchema,
  versionStatusChanged,
  type AttemptFailure,
  type DocumentVersionRef,
  type IngestionVersion,
} from './stage.js';

/**
 * The pg_boss queue name for ingestion stage 1. Each pipeline stage gets its
 * own queue so each is retried independently and a stage can enqueue the
 * next on success (NBK-6); hyphens only, because pg_boss rejects anything
 * outside `[\w-]`.
 */
export const CONVERT_TO_MARKDOWN_QUEUE = 'convert-to-markdown';

// Re-exported from `stage.ts`, where the three Stages' shared job payload and
// event envelope live.
export { DOCUMENT_VERSION_STATUS_CHANGED } from './stage.js';

/** A convert job's payload: the Document Version to convert, and nothing else. */
export const convertToMarkdownPayloadSchema = documentVersionRefSchema;
export type ConvertToMarkdownPayload = DocumentVersionRef;

export interface ConvertToMarkdownDeps {
  pool: Pool;
  s3: S3Client;
  documentsBucket: string;
  /** The Docling boundary (see docling.ts) — stubbed in seam-2 tests. */
  convertToMarkdown: MarkdownConverter;
  /** Parent directory for this job's scratch files. Defaults to the OS temp dir. */
  tempDir?: string;
  /**
   * Hands this Document Version to ingestion stage 2 (NBK-7). This is the
   * chaining ADR-0004 describes — "each stage ... on success enqueues the
   * next" — and it is a plain callback rather than a `JobQueue` because
   * `startJobQueue` builds the queue *from* these deps, so depending on the
   * queue here would be circular.
   *
   * Omitted, conversion still succeeds and the Version simply stays
   * "converted" — which is what keeps this handler testable without stage 2
   * in the picture.
   */
  enqueueSummarizeDocument?: (payload: { documentId: string; versionId: string }) => Promise<void>;
}

export interface ConvertToMarkdownInvocation {
  payload: ConvertToMarkdownPayload;
  /**
   * Whether pg_boss still has a retry left for this job. It decides whether a
   * failure is terminal: with a retry pending the Version goes back to
   * "queued", and only the last attempt marks it "failed". Passed in rather
   * than read off a pg_boss job object so the handler stays directly callable
   * from a seam-2 test.
   */
  willRetry: boolean;
}

/** Stage 1's own input: where in object storage the raw upload is. */
interface VersionRow {
  storage_key: string;
}

/**
 * Updates a Document Version's ingestion status and announces it, in one
 * transaction. `pg_notify` is transactional, so a status nobody committed is
 * never announced — and an announcement is never lost after a commit.
 *
 * Stage 1's own `UPDATE`: the Converted Markdown and `converted_at` are
 * columns no other Stage writes. The transaction wrapper and the event
 * envelope are shared (`db/transaction.ts`, `stage.ts`); which *status* to
 * move to is decided by the caller below, which is where a reader of this
 * Stage can see it.
 */
async function transitionTo(
  pool: Pool,
  version: IngestionVersion,
  status: DocumentStatus,
  fields: { markdown?: string } & Partial<AttemptFailure> = {},
): Promise<void> {
  await inTransaction(pool, async (client) => {
    await client.query(
      `UPDATE document_versions
       SET ingestion_status = $2,
           markdown = COALESCE($3, markdown),
           ingestion_error = $4,
           failure_reason = $5,
           failed_at = $6,
           converted_at = CASE WHEN $2 = 'converted' THEN now() ELSE converted_at END
       WHERE id = $1`,
      [
        version.versionId,
        status,
        fields.markdown ?? null,
        fields.error ?? null,
        fields.failure?.reason ?? null,
        fields.failure?.failedAt ?? null,
      ],
    );
    await publishAppEvent(client, versionStatusChanged(version, status, fields.failure));
  });
}

/**
 * Converts one uploaded Document Version to Markdown — ingestion stage 1
 * (NBK-6).
 *
 * The whole flow is: download the raw bytes from object storage to a temp
 * file, hand Docling that path plus a second temp path to write to, read the
 * Markdown back out of that output file, and store it on the Version. The
 * raw upload in object storage is never touched, so a failure at any point
 * loses nothing but the scratch files — which is what makes the job safe for
 * pg_boss to retry.
 *
 * Throws on failure (after recording it) so pg_boss sees the attempt fail
 * and applies its retry policy.
 */
export async function runConvertToMarkdownJob(
  deps: ConvertToMarkdownDeps,
  { payload, willRetry }: ConvertToMarkdownInvocation,
): Promise<void> {
  const { pool, s3, documentsBucket, convertToMarkdown } = deps;

  const { rows } = await pool.query<VersionRow & { notebook_id: string; filename: string }>(
    `SELECT d.notebook_id, d.filename, v.storage_key
     FROM document_versions v
     JOIN documents d ON d.id = v.document_id
     WHERE v.id = $1 AND v.document_id = $2 AND v.deleted_at IS NULL`,
    [payload.versionId, payload.documentId],
  );
  const row = rows[0];
  if (!row) {
    // The Version was hard-deleted (or never existed) between enqueue and
    // now. Nothing to convert and nothing to retry — swallow it so pg_boss
    // doesn't keep retrying a job that can never succeed.
    return;
  }

  const version: IngestionVersion = {
    notebookId: row.notebook_id,
    filename: row.filename,
    documentId: payload.documentId,
    versionId: payload.versionId,
  };
  await transitionTo(pool, version, 'converting');

  const workDir = await mkdtemp(join(deps.tempDir ?? tmpdir(), 'nbk-convert-'));
  try {
    // Keep the original extension: Docling picks its conversion backend from
    // it, so a .pdf must still look like a .pdf on disk. `basename` strips any
    // path the filename might carry.
    const inputPath = join(workDir, basename(version.filename));
    const outputPath = markdownOutputPath(workDir);

    const stored = await getObject(s3, documentsBucket, row.storage_key);
    await pipeline(stored.body, createWriteStream(inputPath));

    await convertToMarkdown({ inputPath, outputPath });

    const markdown = await readFile(outputPath, 'utf8');
    await transitionTo(pool, version, 'converted', { markdown });

    // Enqueued after the Converted Markdown is committed, never before: a
    // stage-2 job that out-ran its own input would find nothing to read.
    //
    // A failure to hand over is thrown rather than logged, unlike the upload
    // route's enqueue (see documents/routes.ts). There, swallowing it was
    // right because the caller was a user's HTTP request and the Version's
    // "queued" status recorded the work still owed. Here the caller is
    // already a retryable job, and a swallowed failure would leave the
    // Version sitting at "converted" with nothing coming for it. Re-running
    // the conversion on the retry is wasted work; a silently stalled
    // pipeline is a bug.
    if (deps.enqueueSummarizeDocument) {
      await deps.enqueueSummarizeDocument({
        documentId: payload.documentId,
        versionId: payload.versionId,
      });
    }
  } catch (err) {
    await transitionTo(
      pool,
      version,
      willRetry ? 'queued' : 'failed',
      attemptFailed(err, { willRetry, failedAt: 'converting' }),
    );
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
