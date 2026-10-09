import type { Pool } from 'pg';
import { storeChunkRanges } from '../documents/chunk-ranges.js';
import { SEARCHABLE_VERSIONS_CTE } from '../documents/searchable-versions.js';
import {
  excerpt,
  type Found,
  headlineOptions,
  NOTHING_FOUND,
  namesAWord,
  TEXT_SEARCH_CONFIG,
  withoutTags,
} from './keywords.js';
import { plainText } from './plain-text.js';
import type { DocumentSearchResult } from './schema.js';

/** The most Chunks one Documents search returns (NBK-104). */
export const DOCUMENT_RESULT_LIMIT = 20;

/**
 * Keyword search over a Notebook's Documents (NBK-104), as one statement
 * (ADR-0003: raw SQL, no ORM). One row per matching **Chunk**: a reader
 * looks for the places a word occurs, so the same Document comes back once
 * per Chunk that holds it, ranked by full-text rank.
 *
 * `searchable_versions` narrows the Notebook to what retrieval may read —
 * each Document's latest non-deleted Version, only when it is `ready` —
 * rules shared with chat retrieval and explained in
 * `documents/searchable-versions.ts`. It consumes `$1`.
 *
 * The match runs on `chunks.search_vector`, the Chunk's text as
 * `simple_unaccent` reads it, stored and indexed (migration 0017): accents
 * and case ignored, no stemming, the query in web-search syntax (quoted
 * phrases, `-word`, `or`). Stored, not recomputed per match: ranking every
 * match of a common word recomputed it 43,000 times (NBK-106).
 */
const SEARCH_CHUNKS_SQL = `
  WITH ${SEARCHABLE_VERSIONS_CTE},
  q AS (
    SELECT websearch_to_tsquery('${TEXT_SEARCH_CONFIG}', $2) AS query,
           websearch_to_tsquery('${TEXT_SEARCH_CONFIG}', $4) AS typed
  )
  SELECT
    s.document_id, s.filename, s.version_id,
    c.id AS chunk_id, c.heading_path, c.text,
    r.char_start, r.char_end, v.chunk_ranges_located_at IS NOT NULL AS located,
    NULLIF(v.metadata ->> 'title', '') AS title,
    -- Every match, counted before LIMIT keeps the best: the ranking has to
    -- see them all anyway, so knowing how many costs nothing more.
    COUNT(*) OVER () AS total
  FROM searchable_versions s
  JOIN chunks c ON c.document_version_id = s.version_id
  JOIN document_versions v ON v.id = s.version_id
  LEFT JOIN chunk_ranges r ON r.chunk_id = c.id
  CROSS JOIN q
  WHERE c.search_vector @@ q.query
  -- What matched as typed first (NBK-105), then by rank; ties broken by
  -- age and position, so the same query twice never shuffles its results.
  ORDER BY c.search_vector @@ q.typed DESC,
           ts_rank(c.search_vector, q.query) DESC,
           s.document_created_at ASC, c.chunk_index ASC
  LIMIT $3
`;

/**
 * Each Chunk's Excerpt, cut from its text with the Markdown markers already
 * stripped (`plainText`), so the excerpt reads as prose: one fragment of
 * about two lines around the matches — `MaxFragments`, since the default
 * mode starts at the first match with nothing before it. `ShortWord=0`, or
 * a fragment never starts or ends on a word of three letters or fewer ("A
 * year…", "…in the sea"). `excerpt` frames the fragment and puts back the
 * punctuation it drops at its ends.
 */
const EXCERPTS_SQL = `
  SELECT ts_headline('${TEXT_SEARCH_CONFIG}', ${withoutTags('t')},
                     websearch_to_tsquery('${TEXT_SEARCH_CONFIG}', $2), $3) AS excerpt
  FROM unnest($1::text[]) WITH ORDINALITY AS u(t, i)
  ORDER BY i
`;
const EXCERPT_HEADLINE = headlineOptions('MaxFragments=1, MaxWords=30, MinWords=15, ShortWord=0');

interface ChunkRow {
  document_id: string;
  filename: string;
  version_id: string;
  chunk_id: string;
  heading_path: string[];
  text: string;
  char_start: number | null;
  char_end: number | null;
  located: boolean;
  title: string | null;
  total: string;
}

/**
 * Searches one Notebook's Documents by keyword for `query` — the one typed,
 * or its correction (NBK-105), in which case what matches `typed` as it was
 * typed ranks first. A blank query finds nothing. Per ADR-0001 there is no
 * ownership check.
 */
export async function searchChunks(
  pool: Pool,
  notebookId: string,
  query: string,
  typed: string = query,
): Promise<Found<DocumentSearchResult>> {
  if (!(await namesAWord(pool, query))) return NOTHING_FOUND;
  const { rows } = await pool.query<ChunkRow>(SEARCH_CHUNKS_SQL, [
    notebookId,
    query,
    DOCUMENT_RESULT_LIMIT,
    typed,
  ]);
  if (rows.length === 0) return NOTHING_FOUND;

  const texts = rows.map((row) => plainText(row.text));
  const { rows: excerpts } = await pool.query<{ excerpt: string }>(EXCERPTS_SQL, [
    texts,
    query,
    EXCERPT_HEADLINE,
  ]);
  // Each Chunk's place in its Version's Converted Markdown, so the result
  // opens at it as a Citation does (NBK-96): stored with the Chunk
  // (NBK-107), and found once, then stored, for a Version written before
  // ranges were.
  const ranges = await storeChunkRanges(
    pool,
    rows.filter((row) => !row.located).map((row) => row.version_id),
  );
  const results = rows.map((row, i) => {
    const range = row.located
      ? row.char_start === null
        ? undefined
        : { charStart: row.char_start, charEnd: row.char_end! }
      : ranges.get(row.chunk_id);
    return {
      documentId: row.document_id,
      filename: row.filename,
      title: row.title,
      headingPath: row.heading_path,
      match: {
        versionId: row.version_id,
        chunkId: row.chunk_id,
        charStart: range?.charStart ?? null,
        charEnd: range?.charEnd ?? null,
      },
      excerpt: excerpt(excerpts[i].excerpt, texts[i]),
    };
  });
  return { results, total: Number(rows[0].total) };
}
