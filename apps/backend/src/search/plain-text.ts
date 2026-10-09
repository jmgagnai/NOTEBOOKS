/**
 * A Chunk's Converted Markdown as prose for an Excerpt (NBK-104): the
 * Markdown markers a reader would otherwise see — headings' `#`, emphasis,
 * code ticks, quotes and list bullets, table pipes and rules, link and
 * image syntax — dropped, the words kept, and all whitespace one space. An
 * Excerpt is for recognising a match, not for reading layout, so a table
 * becomes its cells in a row.
 */
export function plainText(markdown: string): string {
  return (
    markdown
      // Images and links keep their text: ![alt](src), [text](href), [text][ref].
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      // A table's separator row, then its pipes.
      .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, ' ')
      .replace(/\|/g, ' ')
      // Line-start markers: headings, quotes, bullets, numbered items, rules.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}(>\s?)+/gm, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*([-*_]\s*){3,}$/gm, ' ')
      // Emphasis and code markers, wherever they sit.
      .replace(/(\*\*|__|~~|`+)/g, '')
      .replace(/(^|[\s(])[*_](?=\S)|(?<=\S)[*_](?=[\s).,;:!?]|$)/gm, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
