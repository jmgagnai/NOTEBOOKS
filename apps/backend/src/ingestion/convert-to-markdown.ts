import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Pool } from "pg";
import { z } from "zod";
import { publishAppEvent } from "../events/bus.js";
import { notebookTopic } from "../events/schema.js";
import { getObject } from "../storage/s3-client.js";
import type { DocumentStatus } from "../documents/schema.js";
import { markdownOutputPath, type MarkdownConverter } from "./docling.js";

/**
 * The pg_boss queue name for ingestion stage 1. Each pipeline stage gets its
 * own queue so each is retried independently and a stage can enqueue the
 * next on success (NBK-6); hyphens only, because pg_boss rejects anything
 * outside `[\w-]`.
 */
export const CONVERT_TO_MARKDOWN_QUEUE = "convert-to-markdown";

/** The app-event type every Document Version lifecycle change is published as. */
export const DOCUMENT_VERSION_STATUS_CHANGED = "document-version-status-changed";

/**
 * A convert job carries ids only, never the file or its bytes: the job table
 * is not a place to park a 200-page document, and ids re-read the current
 * truth on every retry.
 */
export const convertToMarkdownPayloadSchema = z.object({
  documentId: z.string().uuid(),
  versionId: z.string().uuid(),
});
export type ConvertToMarkdownPayload = z.infer<typeof convertToMarkdownPayloadSchema>;

export interface ConvertToMarkdownDeps {
  pool: Pool;
  s3: S3Client;
  documentsBucket: string;
  /** The Docling boundary (see docling.ts) — stubbed in seam-2 tests. */
  convertToMarkdown: MarkdownConverter;
  /** Parent directory for this job's scratch files. Defaults to the OS temp dir. */
  tempDir?: string;
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

interface VersionRow {
  notebook_id: string;
  filename: string;
  storage_key: string;
}

/**
 * Updates a Document Version's ingestion status and announces it, in one
 * transaction. `pg_notify` is transactional, so a status nobody committed is
 * never announced — and an announcement is never lost after a commit.
 */
async function transitionTo(
  pool: Pool,
  version: VersionRow & { documentId: string; versionId: string },
  status: DocumentStatus,
  fields: { markdown?: string; error?: string | null } = {},
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE document_versions
       SET ingestion_status = $2,
           markdown = COALESCE($3, markdown),
           ingestion_error = $4,
           converted_at = CASE WHEN $2 = 'converted' THEN now() ELSE converted_at END
       WHERE id = $1`,
      [version.versionId, status, fields.markdown ?? null, fields.error ?? null],
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

  const { rows } = await pool.query<VersionRow>(
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

  const version = { ...row, documentId: payload.documentId, versionId: payload.versionId };
  await transitionTo(pool, version, "converting");

  const workDir = await mkdtemp(join(deps.tempDir ?? tmpdir(), "nbk-convert-"));
  try {
    // Keep the original extension: Docling picks its conversion backend from
    // it, so a .pdf must still look like a .pdf on disk. `basename` strips any
    // path the filename might carry.
    const inputPath = join(workDir, basename(version.filename));
    const outputPath = markdownOutputPath(workDir);

    const stored = await getObject(s3, documentsBucket, version.storage_key);
    await pipeline(stored.body, createWriteStream(inputPath));

    await convertToMarkdown({ inputPath, outputPath });

    const markdown = await readFile(outputPath, "utf8");
    await transitionTo(pool, version, "converted", { markdown, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await transitionTo(pool, version, willRetry ? "queued" : "failed", { error: message });
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
