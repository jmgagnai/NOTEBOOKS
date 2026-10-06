import type { Pool } from "pg";

/**
 * One Chunk retrieved for a question, with everything the answer path needs
 * about where it came from.
 *
 * `chunkId` and `documentVersionId` are both carried because a Citation is,
 * per GLOSSARY.md, "a pointer into one specific Document Version at one
 * specific chunk" — and the Version a Citation pins is the one retrieval
 * chose here, not whatever is latest when someone later follows it (NBK-12).
 * That is why the Version id travels out of retrieval rather than being
 * looked up again downstream.
 */
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  /** The Document's filename — what a reader recognises a source by. */
  filename: string;
  /** The enclosing Markdown headings, outermost first. */
  headingPath: string[];
  /** A verbatim slice of the Converted Markdown (GLOSSARY.md: Chunk). */
  text: string;
  /**
   * The Chat Snippet of the Document Version this Chunk belongs to — the
   * 150-300 word artifact GLOSSARY.md describes as "written to be injected
   * into the LLM's chat context as grounding about that source". Null if
   * ingestion stage 2 produced none.
   */
  chatSnippet: string | null;
  /** Cosine similarity to the question, in [-1, 1]. Higher is closer. */
  similarity: number;
}

/**
 * How many Chunks one question retrieves.
 *
 * Chunks are ~1000 characters (NBK-1's chunking defaults), so twelve of them
 * is roughly 12k characters of verbatim grounding plus one Chat Snippet per
 * distinct source — comfortable for any model this app targets, and wide
 * enough that a question whose answer is spread over several documents still
 * sees all of them.
 */
export const DEFAULT_RETRIEVAL_LIMIT = 12;

interface RetrievedChunkRow {
  chunk_id: string;
  document_id: string;
  document_version_id: string;
  filename: string;
  heading_path: string[];
  text: string;
  chat_snippet: string | null;
  similarity: number;
}

/**
 * The Chunks in a Notebook a question should be answered from, closest first.
 *
 * Two rules from GLOSSARY.md are enforced in SQL rather than left to a
 * caller, because getting either wrong is silent and wrong answers are the
 * symptom:
 *
 * - **Latest Version only.** "Only a Document's latest Version is searched in
 *   chat." The `DISTINCT ON` picks each Document's highest non-deleted
 *   Version *before* anything else filters, so a superseded Version is never
 *   a candidate — even though its Chunks still exist, because a Citation has
 *   to be able to reach them.
 * - **`ready` only.** "'ready' is the end of the pipeline and the only status
 *   that means a Document is safe to rely on for chat." The status is checked
 *   on that latest Version, after it was chosen — so a Document mid-re-ingest
 *   contributes nothing rather than falling back to its previous Version's
 *   content.
 *
 * Similarity is `1 - (embedding <=> query)`, pgvector's cosine distance.
 * Embeddings are L2-normalised (Qwen3-Embedding-4B, verified live in NBK-8),
 * so cosine and inner product rank identically; cosine is used because its
 * value is directly readable as a similarity.
 *
 * This is an exact scan over one Notebook's Chunks. That is not an oversight:
 * pgvector caps HNSW and ivfflat at 2000 dimensions and these vectors are
 * 2560, so no ANN index can be built on the column (see migration 0007).
 *
 * Raw SQL per ADR-0003 — `<=>` is exactly the operator the ADR says an ORM
 * would wrap with friction.
 */
export async function retrieveChunks(
  pool: Pool,
  notebookId: string,
  queryEmbedding: number[],
  limit: number = DEFAULT_RETRIEVAL_LIMIT,
): Promise<RetrievedChunk[]> {
  const { rows } = await pool.query<RetrievedChunkRow>(
    `WITH latest_versions AS (
       SELECT DISTINCT ON (d.id)
         d.id AS document_id,
         d.filename,
         v.id AS version_id,
         v.ingestion_status,
         v.chat_snippet
       FROM documents d
       JOIN document_versions v ON v.document_id = d.id AND v.deleted_at IS NULL
       WHERE d.notebook_id = $1 AND d.deleted_at IS NULL
       ORDER BY d.id, v.version_number DESC
     )
     SELECT
       c.id AS chunk_id,
       l.document_id,
       l.version_id AS document_version_id,
       l.filename,
       c.heading_path,
       c.text,
       l.chat_snippet,
       1 - (c.embedding <=> $2::vector) AS similarity
     FROM chunks c
     JOIN latest_versions l ON l.version_id = c.document_version_id
     WHERE l.ingestion_status = 'ready'
     ORDER BY c.embedding <=> $2::vector, c.id
     LIMIT $3`,
    [notebookId, `[${queryEmbedding.join(",")}]`, limit],
  );

  return rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    filename: row.filename,
    headingPath: row.heading_path,
    text: row.text,
    chatSnippet: row.chat_snippet,
    similarity: Number(row.similarity),
  }));
}
