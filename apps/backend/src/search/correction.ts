import type { Pool } from 'pg';
import { TEXT_SEARCH_CONFIG } from './keywords.js';

/** Words shorter than this are never corrected: too many neighbours to pick from. */
const MIN_CORRECTED_LENGTH = 4;

/**
 * How alike (`pg_trgm` similarity, 0 to 1) a word of the Notebook must be to
 * stand in for a query word. Below it the query word is kept as typed, and
 * so finds nothing, rather than something unrelated.
 */
const MIN_SIMILARITY = 0.4;

/** The words of a query, in web-search syntax or not: runs of letters and digits. */
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * For each query word, the lexeme the search would match it as, whether the
 * Notebook holds it, and else the Notebook's most similar word. The `%`
 * operator lets the trigram index (migration 0016) find the candidates at
 * `pg_trgm`'s own threshold; `MIN_SIMILARITY` then keeps only close ones.
 */
const CORRECTIONS_SQL = `
  SELECT t.i, l.lexeme,
    EXISTS (SELECT 1 FROM notebook_words w WHERE w.notebook_id = $1 AND w.word = l.lexeme) AS known,
    (SELECT w.word FROM notebook_words w
     WHERE w.notebook_id = $1 AND w.word % l.lexeme AND similarity(w.word, l.lexeme) >= $3
     ORDER BY similarity(w.word, l.lexeme) DESC, w.word
     LIMIT 1) AS closest
  FROM unnest($2::text[]) WITH ORDINALITY AS t(word, i)
  CROSS JOIN LATERAL (
    SELECT (tsvector_to_array(to_tsvector('${TEXT_SEARCH_CONFIG}', t.word)))[1] AS lexeme
  ) l
`;

export interface Correction {
  /** The query to search: the one typed, its misspelt words replaced. */
  searched: string;
  /** That query when it differs from the one typed; null when nothing was corrected. */
  correctedQuery: string | null;
}

/**
 * Corrects a query's misspelt words (NBK-105): a word the Notebook does not
 * hold — the word list holds every word of its Chunks and chat messages —
 * becomes the Notebook's most similar word, if one is close enough. The
 * query's web-search syntax is left as it is around the words, and a word
 * excluded with `-` is never corrected: excluding a near miss excludes
 * nothing.
 */
export async function correct(pool: Pool, notebookId: string, query: string): Promise<Correction> {
  const words = [...query.matchAll(WORD)].filter(
    (m) => m[0].length >= MIN_CORRECTED_LENGTH && query[m.index - 1] !== '-',
  );
  if (words.length === 0) return { searched: query, correctedQuery: null };

  const { rows } = await pool.query<{ i: string; known: boolean; closest: string | null }>(
    CORRECTIONS_SQL,
    [notebookId, words.map((m) => m[0]), MIN_SIMILARITY],
  );
  let searched = query;
  // From the end, so each replacement leaves the earlier positions valid.
  for (const row of [...rows].sort((a, b) => Number(b.i) - Number(a.i))) {
    if (row.known || row.closest === null) continue;
    const match = words[Number(row.i) - 1];
    searched =
      searched.slice(0, match.index) + row.closest + searched.slice(match.index + match[0].length);
  }
  return { searched, correctedQuery: searched === query ? null : searched };
}
