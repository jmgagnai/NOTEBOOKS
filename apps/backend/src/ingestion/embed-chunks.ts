import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { publishAppEvent } from "../events/bus.js";
import { notebookTopic } from "../events/schema.js";
import type { DocumentStatus } from "../documents/schema.js";
import { EMBEDDING_DIMENSIONS } from "../llm/models.js";
import type { Embedder } from "../llm/embeddings.js";
import { DOCUMENT_VERSION_STATUS_CHANGED } from "./convert-to-markdown.js";
import { chunkMarkdown, type DocumentChunk } from "./chunking.js";

/**
 * The pg_boss queue name for ingestion stage 3 — chunking and embeddings
 * (NBK-8). Its own queue, chained off stage 2, so per ADR-0004 it retries
 * independently: a rate-limited embeddings call never re-runs a Docling
 * conversion or regenerates the three summaries.
 */
export const EMBED_CHUNKS_QUEUE = "embed-chunks";

/** Ids only, same as stages 1 and 2: the job re-reads current truth on every retry. */
export const embedChunksPayloadSchema = z.object({
  documentId: z.string().uuid(),
  versionId: z.string().uuid(),
});
export type EmbedChunksPayload = z.infer<typeof embedChunksPayloadSchema>;

export interface EmbedChunksDeps {
  pool: Pool;
  /** The OpenRouter embeddings boundary. Seam-2 tests stub the `fetch` underneath it. */
  embed: Embedder;
  /** Overrides the chunk size / overlap. Defaults to NBK-1's 1000 / 150. */
  chunking?: { chunkSize?: number; chunkOverlap?: number };
}

export interface EmbedChunksInvocation {
  payload: EmbedChunksPayload;
  /**
   * Whether pg_boss still has a retry left. Same contract as stages 1 and 2:
   * with a retry pending the Version goes back to the status stage 3
   * *consumes* ("summarized") rather than forward or to "failed", so a retry
   * finds exactly the state it expects and the UI shows work still owed
   * rather than a failure that hasn't happened yet.
   */
  willRetry: boolean;
}

interface VersionRow {
  notebook_id: string;
  filename: string;
  markdown: string | null;
}

/**
 * Updates a Document Version's ingestion status and announces the change, in
 * one transaction. `pg_notify` is transactional, so a status nobody committed
 * is never announced.
 *
 * Mirrors stages 1 and 2 deliberately — this is the same lifecycle contract,
 * extended one stage further. Unlike theirs it writes no content columns:
 * stage 3's output is rows in `chunks`, which `replaceChunks` writes in its
 * own transaction before the Version is moved to "ready".
 */
async function transitionTo(
  pool: Pool,
  version: VersionRow & { documentId: string; versionId: string },
  status: DocumentStatus,
  fields: { error?: string | null } = {},
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE document_versions
       SET ingestion_status = $2,
           ingestion_error = $3,
           embedded_at = CASE WHEN $2 = 'ready' THEN now() ELSE embedded_at END
       WHERE id = $1`,
      [version.versionId, status, fields.error ?? null],
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

/** pgvector's text input format. `[1,2,3]` — not a Postgres array literal. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Replaces this Version's chunks with `chunks`, in one transaction.
 *
 * Delete-then-insert, not an upsert: a retry (or a re-run after the chunker
 * itself changed) can legitimately produce *fewer* chunks than the attempt
 * before it, and an upsert would leave the surplus behind — stale passages
 * that a Citation could still point at. One transaction so a reader never
 * sees a Version with half its chunks.
 */
async function replaceChunks(pool: Pool, versionId: string, chunks: DocumentChunk[], vectors: number[][]): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM chunks WHERE document_version_id = $1", [versionId]);
    for (const [i, chunk] of chunks.entries()) {
      await client.query(
        `INSERT INTO chunks (document_version_id, chunk_index, heading_path, text, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [versionId, chunk.index, chunk.headingPath, chunk.text, toVectorLiteral(vectors[i])],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Ingestion stage 3 (NBK-8): split one summarized Document Version's
 * Converted Markdown into chunks, embed every chunk, and store both — which
 * is what makes the Version searchable and so what moves it to "ready".
 *
 * Like stage 2 it reads the Converted Markdown off the Version and nothing
 * else: per GLOSSARY.md that is "the single input every later Stage ... reads
 * from", so object storage is not in this stage's path.
 *
 * Throws on failure (after recording it) so pg_boss sees the attempt fail and
 * applies its retry policy.
 */
export async function runEmbedChunksJob(
  deps: EmbedChunksDeps,
  { payload, willRetry }: EmbedChunksInvocation,
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
    // chunk and nothing to retry, so don't make pg_boss keep trying.
    return;
  }

  const version = { ...row, documentId: payload.documentId, versionId: payload.versionId };

  if (row.markdown === null || row.markdown.trim() === "") {
    // Stage 3's input is missing, which means stage 1 either hasn't run or
    // produced nothing. Recorded and thrown so it retries — a re-enqueued
    // earlier stage can still fill this in.
    const message = "Stage 3 found no Converted Markdown on this Document Version.";
    await transitionTo(pool, version, willRetry ? "summarized" : "failed", { error: message });
    throw new Error(message);
  }

  await transitionTo(pool, version, "indexing");

  try {
    const chunks = chunkMarkdown(row.markdown, deps.chunking ?? {});
    const vectors = await deps.embed(chunks.map((chunk) => chunk.text));

    if (vectors.length !== chunks.length) {
      throw new Error(`Expected ${chunks.length} embeddings for this Document Version, got ${vectors.length}.`);
    }
    for (const vector of vectors) {
      // Checked here rather than left to Postgres so the error names the
      // actual problem — a model whose output dimension doesn't match the
      // column (see EMBEDDING_DIMENSIONS) — instead of a type error from the
      // insert. Changing the embedding model is a migration, not a config
      // change (ADR-0002).
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedding model returned a ${vector.length}-dimension vector; ` +
            `chunks.embedding is vector(${EMBEDDING_DIMENSIONS}).`,
        );
      }
    }

    await replaceChunks(pool, version.versionId, chunks, vectors);
    await transitionTo(pool, version, "ready", { error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await transitionTo(pool, version, willRetry ? "summarized" : "failed", { error: message });
    throw err;
  }
}
