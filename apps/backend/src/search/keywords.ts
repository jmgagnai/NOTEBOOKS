import type { TextSegment } from './schema.js';

/**
 * The text search configuration keyword search runs on, Documents and Chat
 * Threads alike (NBK-104): `simple` with accents removed, created by
 * migration 0015. Indexes are on `to_tsvector('simple_unaccent', …)`, so
 * every query has to spell the expression exactly this way to use them.
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
export function headlineOptions(extra = ''): string {
  return `StartSel=${START}, StopSel=${STOP}${extra ? `, ${extra}` : ''}`;
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
