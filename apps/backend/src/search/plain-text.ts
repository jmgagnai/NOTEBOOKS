/**
 * A Chunk's Converted Markdown as prose for an Excerpt (NBK-104): the
 * Markdown markers a reader would otherwise see — headings' `#`, emphasis,
 * code ticks, quotes and list bullets, table pipes and rules, link and
 * image syntax — dropped, the words kept, and all whitespace one space. An
 * Excerpt is for recognising a match, not for reading layout, so a table
 * becomes its cells in a row.
 *
 * Numbered items keep their number: "2024. A year…" may be a list marker or
 * the year that opens a sentence, and dropping a number changes the text.
 */
export function plainText(markdown: string): string {
  const text = protectEscapes(markdown)
    // Images and links keep their text: ![alt](src), [text](href), [text][ref].
    // A destination may hold one level of parentheses, as Wikipedia's do.
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    // A table's separator row, then its pipes.
    .replace(/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/gm, ' ')
    .replace(/\|/g, ' ')
    // Line-start markers: headings, quotes, bullets, rules.
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}(>\s?)+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*([-*_]\s*){3,}$/gm, ' ')
    // Emphasis and code markers, wherever they sit.
    .replace(/(\*\*|__|~~|`+)/g, '')
    .replace(/(^|[\s(])[*_](?=\S)|(?<=\S)[*_](?=[\s).,;:!?]|$)/gm, '$1');
  return decodeEntities(restoreEscapes(text)).replace(/\s+/g, ' ').trim();
}

// A backslash-escaped character (`file\_name`, as Docling writes it) is
// literal text, not a marker: it travels as a private-use stand-in, out of
// reach of the marker rules above, and comes back without its backslash.
const ESCAPABLE = /\\([\\`*_{}[\]()#+\-.!|>~&])/g;
const STAND_IN_BASE = 0xf000;

function protectEscapes(markdown: string): string {
  return markdown.replace(ESCAPABLE, (_, c: string) =>
    String.fromCharCode(STAND_IN_BASE + c.charCodeAt(0)),
  );
}

function restoreEscapes(text: string): string {
  return text.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - STAND_IN_BASE));
}

// The HTML entities Docling writes into Converted Markdown.
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}
