import type { Pool } from "pg";
import { toDocument, type DocumentRow } from "../documents/repository.js";
import type { SearchResult } from "./schema.js";

/**
 * Retrieval, as one statement (ADR-0003: raw SQL, no ORM).
 *
 * Three things are happening here, in this order, and each one is an
 * acceptance criterion of NBK-9:
 *
 * 1. `searchable` picks, per Document, the **latest** non-deleted Version —
 *    and keeps it only if that Version is `ready`. Both filters are in
 *    GLOSSARY.md: "only a Document's latest Version is searched", and
 *    `ready` "is the end of the pipeline and the only status that means a
 *    Document is safe to rely on". Note the order: the `ready` test is
 *    applied *after* the latest Version is chosen, never as part of
 *    choosing it, so a Document whose newest Version is still ingesting is
 *    absent rather than silently answering from its previous Version's
 *    Chunks — which would serve content the user has already replaced.
 *
 * 2. `scored` ranks Chunks and **rolls them up to their Version** with
 *    `MIN(distance)`: a Document's score is its single best Chunk, not an
 *    average, because one strongly matching passage is exactly what makes a
 *    long document worth opening. Grouping is what makes a Document appear
 *    once however many of its Chunks matched.
 *
 * 3. The outer select rebuilds the Document card — including its Abstract,
 *    which per GLOSSARY.md is the artifact "used in search results,
 *    search-result previews, and document cards".
 *
 * **Why `<=>` (cosine distance) and not `<#>` (negative inner product).**
 * Qwen3-Embedding-4B returns L2-normalised vectors (‖v‖ = 1, measured — see
 * `docs/ingestion-embeddings.md`), so for this data the two operators rank
 * identically and the choice is about everything other than ordering.
 * Cosine wins twice: it is bounded in [0, 2] regardless of magnitude, so
 * `1 - distance` is a similarity a human and a UI can both read, whereas
 * `<#>` returns a *negative* dot product whose range depends on the vectors;
 * and it stays correct if a future embedding model (or an
 * `OPENROUTER_MODEL_EMBEDDING` override) returns vectors that are not
 * normalised, where inner product would quietly start ranking by length.
 *
 * There is no ANN index on `chunks.embedding` — pgvector refuses HNSW and
 * ivfflat above 2000 dimensions and these are 2560 (see migration `0007`) —
 * so this is an exact scan, bounded to one Notebook's latest ready Versions
 * by the join. `docs/search.md` records the latency measured on a realistic
 * corpus and why that is left as is for now.
 */
const SEARCH_NOTEBOOK_SQL = `
  WITH searchable AS (
    SELECT
      d.id,
      d.notebook_id,
      d.filename,
      d.created_at,
      v.id AS version_id,
      v.version_number,
      v.mime_type,
      v.size_bytes,
      v.version_created_at,
      v.ingestion_status,
      v.abstract
    FROM documents d
    JOIN LATERAL (
      SELECT
        id,
        version_number,
        mime_type,
        size_bytes,
        created_at AS version_created_at,
        ingestion_status,
        abstract
      FROM document_versions
      WHERE document_id = d.id AND deleted_at IS NULL
      ORDER BY version_number DESC
      LIMIT 1
    ) v ON true
    WHERE d.notebook_id = $1
      AND d.deleted_at IS NULL
      AND v.ingestion_status = 'ready'
  ),
  scored AS (
    SELECT s.version_id, MIN(c.embedding <=> $2::vector) AS distance
    FROM searchable s
    JOIN chunks c ON c.document_version_id = s.version_id
    GROUP BY s.version_id
  )
  SELECT searchable.*, 1 - scored.distance AS score
  FROM scored
  JOIN searchable ON searchable.version_id = scored.version_id
  -- Ties broken by age, oldest first, so an identical query twice running
  -- never shuffles its own results.
  ORDER BY scored.distance ASC, searchable.created_at ASC, searchable.id ASC
  LIMIT $3
`;

/** pgvector's text input format. `[1,2,3]` — not a Postgres array literal. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Searches one Notebook's Documents by the query's embedding, best match
 * first. Per ADR-0001 there is no ownership check.
 */
export async function searchNotebook(
  pool: Pool,
  notebookId: string,
  queryEmbedding: number[],
  limit: number,
): Promise<SearchResult[]> {
  const { rows } = await pool.query<DocumentRow & { score: string }>(SEARCH_NOTEBOOK_SQL, [
    notebookId,
    toVectorLiteral(queryEmbedding),
    limit,
  ]);
  // `score` arrives as a string: it is a `numeric` expression over pgvector's
  // double, and node-postgres hands numerics over as text to avoid losing
  // precision it can't represent.
  return rows.map((row) => ({ ...toDocument(row), score: Number(row.score) }));
}
