import type { Pool } from 'pg';
import type { TextSegment } from './schema.js';

/**
 * The text search configuration keyword search runs on, Documents and Chat
 * Threads alike (NBK-104): `simple` with accents removed, created by
 * migration 0015. Chunks and chat messages store their text as it reads it
 * (`search_vector`, migration 0017, whose generated columns must name the
 * same configuration); the queries are built with it.
 */
export const TEXT_SEARCH_CONFIG = 'simple_unaccent';

// What `ts_headline` puts around a matched word. Private-use code points:
// stored text never contains them, so splitting on them is exact, and no
// markup ever travels — the frontend renders text and bold, not HTML.
const START = '\uE000';
const STOP = '\uE001';

// And what `<` and `>` travel as through `ts_headline`, which otherwise
// takes `<script>` — or `List<String>` in a code sample — for an HTML tag
// and leaves it out of the excerpt. Swapped back by `segments`.
const LT = '\uE002';
const GT = '\uE003';

/**
 * A SQL expression for `text` with its angle brackets swapped out, to hand
 * `ts_headline` so it cuts the excerpt from every character of the text.
 */
export function withoutTags(sqlText: string): string {
  return `translate(${sqlText}, '<>', '${LT}${GT}')`;
}

/**
 * `ts_headline` options marking matches with the delimiters `segments`
 * splits on, plus whatever else the caller wants (length, fragments).
 */
export function headlineOptions(extra: string): string {
  return `StartSel=${START}, StopSel=${STOP}, ${extra}`;
}

/**
 * A `ts_headline` excerpt of `withoutTags` text as plain text runs, the
 * matched ones flagged, the angle brackets back.
 */
export function segments(headline: string): TextSegment[] {
  const out: TextSegment[] = [];
  const text = headline.replaceAll(LT, '<').replaceAll(GT, '>');
  for (const [i, part] of text.split(START).entries()) {
    if (i === 0) {
      if (part) out.push({ text: part, match: false });
      continue;
    }
    const [matched, rest = ''] = part.split(STOP);
    if (matched) out.push({ text: matched, match: true });
    if (rest) out.push({ text: rest, match: false });
  }
  return out;
}

/**
 * Whether a query names a word to look for. One that only excludes
 * (`-lupin`) or has no words at all (`?!`) would match almost every row —
 * no index serves "not this word" — so it finds nothing instead of
 * scanning the Notebook. `querytree` reduces a query to what an index can
 * search for, and to `T` when that is nothing.
 */
export async function namesAWord(pool: Pool, query: string): Promise<boolean> {
  if (query.trim() === '') return false;
  const { rows } = await pool.query<{ tree: string }>(
    `SELECT querytree(websearch_to_tsquery('${TEXT_SEARCH_CONFIG}', $1)) AS tree`,
    [query],
  );
  const tree = rows[0].tree;
  return tree !== '' && tree !== 'T';
}

// Up to this much left out at either end of a fragment is shown rather
// than replaced by "…": an ellipsis standing for "2024. " hides more than it
// saves, and `ts_headline` never starts or ends a fragment on a number.
const SHOWN_IF_SHORTER = 16;

/**
 * An Excerpt: a `ts_headline` fragment of `source` as segments, framed so
 * the reader can tell it was cut — "… " where text before it was left out,
 * " …" where text after it was — or with that text itself when it is only a
 * few characters, as the punctuation ending a sentence, which a fragment
 * drops, always is.
 */
export function excerpt(headline: string, source: string): TextSegment[] {
  const parts = segments(headline);
  const shown = parts.map((part) => part.text).join('');
  const at = source.indexOf(shown);
  if (shown === '' || at < 0) return parts;
  const before = source.slice(0, at);
  const after = source.slice(at + shown.length);
  const lead = before.length <= SHOWN_IF_SHORTER ? before : '… ';
  const tail = after.length <= SHOWN_IF_SHORTER ? after : ' …';
  return [
    ...(lead ? [{ text: lead, match: false }] : []),
    ...parts,
    ...(tail ? [{ text: tail, match: false }] : []),
  ];
}

/**
 * What one search finds: the best results, up to its limit, and how many
 * matched in all — so the page can say when the list is cut, and how much.
 */
export interface Found<T> {
  results: T[];
  total: number;
}

/** Nothing found. */
export const NOTHING_FOUND: Found<never> = { results: [], total: 0 };
