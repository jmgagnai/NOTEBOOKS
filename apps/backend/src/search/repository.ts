import type { Pool } from 'pg';
import { toVectorLiteral } from '../db/vector.js';
import { locateChunkRanges } from '../documents/chunk-ranges.js';
import { toDocument, type DocumentRow } from '../documents/repository.js';
import { SEARCHABLE_VERSIONS_CTE } from '../documents/searchable-versions.js';
import type { SearchResult } from './schema.js';

/**
 * Retrieval, as one statement (ADR-0003: raw SQL, no ORM).
 *
 * Three things are happening here, in this order, and each one is an
 * acceptance criterion of NBK-9:
 *
 * 1. `searchable_versions` narrows the Notebook to the Documents retrieval
 *    may read: each one's latest non-deleted Version, kept only if that
 *    Version is `ready`, with the `ready` test applied *after* the Version is
 *    chosen. Both rules are GLOSSARY.md's and both are shared with chat
 *    retrieval, so they live in one place —
 *    `documents/searchable-versions.ts`, which is also where the reasoning
 *    is written down. It consumes `$1` (the Notebook id), so this query's own
 *    parameters start at `$2`.
 *
 * 2. `scored` ranks Chunks and **rolls them up to their Version**, keeping
 *    the closest (`DISTINCT ON`): a Document's score is its single best Chunk, not an
 *    average, because one strongly matching Chunk is exactly what makes a
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
  WITH ${SEARCHABLE_VERSIONS_CTE},
  scored AS (
    -- One row per Version: its best Chunk and that Chunk's distance. Same
    -- score as \`MIN(distance) ... GROUP BY\` gave, but the Chunk comes
    -- with it (NBK-96); ties fall to the earlier Chunk.
    SELECT DISTINCT ON (s.version_id)
      s.version_id, c.id AS chunk_id, c.embedding <=> $2::vector AS distance
    FROM searchable_versions s
    JOIN chunks c ON c.document_version_id = s.version_id
    ORDER BY s.version_id, distance ASC, c.chunk_index ASC
  )
  -- Aliased back to the column names a Document card is built from, so one
  -- row maps through \`toDocument\` exactly as a listed Document does.
  SELECT
    s.document_id AS id,
    s.notebook_id,
    s.filename,
    s.document_created_at AS created_at,
    s.version_id,
    s.version_number,
    s.mime_type,
    s.size_bytes,
    s.version_created_at,
    s.ingestion_status,
    -- Only \`ready\` Versions are searchable, so there is never a failure
    -- reason to report.
    NULL AS failure_reason,
    NULL AS failed_at,
    s.abstract,
    scored.chunk_id AS match_chunk_id,
    1 - scored.distance AS score
  FROM scored
  JOIN searchable_versions s ON s.version_id = scored.version_id
  -- Ties broken by age, oldest first, so an identical query twice running
  -- never shuffles its own results.
  ORDER BY scored.distance ASC, s.document_created_at ASC, s.document_id ASC
  LIMIT $3
`;

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
  const { rows } = await pool.query<DocumentRow & { score: string; match_chunk_id: string }>(
    SEARCH_NOTEBOOK_SQL,
    [notebookId, toVectorLiteral(queryEmbedding), limit],
  );
  // Each result's best Chunk located in its Version's Converted Markdown, so
  // the result opens at that passage (NBK-96). Read per query: one pass over
  // the results' Versions (see `docs/search.md`).
  const ranges = await locateChunkRanges(
    pool,
    rows.map((row) => row.version_id),
  );
  // `score` arrives as a string: it is a `numeric` expression over pgvector's
  // double, and node-postgres hands numerics over as text to avoid losing
  // precision it can't represent.
  return rows.map((row) => {
    const range = ranges.get(row.match_chunk_id);
    return {
      ...toDocument(row),
      match: {
        versionId: row.version_id,
        chunkId: row.match_chunk_id,
        charStart: range?.charStart ?? null,
        charEnd: range?.charEnd ?? null,
      },
      score: Number(row.score),
    };
  });
}
