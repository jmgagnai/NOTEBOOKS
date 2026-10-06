import { splitMarkdownSections } from "./markdown-sections.js";

/**
 * One embeddable piece of a Document Version's Converted Markdown.
 *
 * `headingPath` is carried, not derived, because it is what a Citation will
 * later surface — per GLOSSARY.md a Citation is "a pointer into one specific
 * Document Version at one specific chunk", and a reader following one needs
 * to be told where in the document they have landed.
 */
export interface DocumentChunk {
  /** Position in the document, 0-based and contiguous. */
  index: number;
  /** The enclosing Markdown headings, outermost first. */
  headingPath: string[];
  text: string;
}

/** Target chunk size in characters (NBK-1's starting default). */
export const CHUNK_SIZE = 1000;

/** Characters of the previous chunk repeated at the start of the next. */
export const CHUNK_OVERLAP = 150;

export interface ChunkingOptions {
  chunkSize?: number;
  chunkOverlap?: number;
}

/**
 * Where to prefer a cut, strongest first: between paragraphs, then between
 * lines, then between sentences, then between words, and only then
 * mid-word.
 *
 * Markdown-aware by virtue of being Markdown's own structure — a blank line
 * separates block elements, so cutting there is cutting between a paragraph
 * and a list rather than through a table row. The empty string at the end is
 * the floor: a single unbroken run longer than `chunkSize` (a base64 blob, a
 * CJK paragraph with no spaces) still has to be cut somewhere.
 */
const SEPARATORS = ["\n\n", "\n", ". ", " ", ""] as const;

/**
 * Splits `text` on `separator`, leaving the separator attached to the end of
 * the part it followed.
 *
 * Keeping it is what makes the whole splitter *lossless*: concatenating the
 * pieces reproduces the input exactly, so every chunk is a contiguous slice
 * of the Converted Markdown. That matters beyond tidiness — a Citation
 * (GLOSSARY.md) points at a chunk and has to be able to find that text in
 * the document a reader is shown.
 */
function splitKeepingSeparator(text: string, separator: string): string[] {
  if (separator === "") return [text];
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(separator, from);
    if (at === -1) break;
    parts.push(text.slice(from, at + separator.length));
    from = at + separator.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/**
 * Breaks `text` down until every piece fits `chunkSize`, trying each
 * separator in turn and recursing only into the parts that are still too
 * long. This is the "recursive" in `RecursiveCharacterTextSplitter`: a short
 * paragraph is never cut into words just because a long one next to it had
 * to be.
 *
 * Concatenating the result always reproduces `text`.
 */
function splitIntoPieces(text: string, chunkSize: number, separators: readonly string[]): string[] {
  const [separator, ...rest] = separators;

  if (separator === undefined || separator === "") {
    // The floor: no separator left, so cut on character count alone.
    const pieces: string[] = [];
    for (let start = 0; start < text.length; start += chunkSize) {
      pieces.push(text.slice(start, start + chunkSize));
    }
    return pieces;
  }

  const pieces: string[] = [];
  for (const part of splitKeepingSeparator(text, separator)) {
    if (part === "") continue;
    if (part.length <= chunkSize) pieces.push(part);
    else pieces.push(...splitIntoPieces(part, chunkSize, rest));
  }
  return pieces;
}

/**
 * Reassembles pieces into chunks of at most `chunkSize` characters, each
 * starting with the last `chunkOverlap` characters of the one before it.
 *
 * The overlap is why a retrieval hit on a sentence that happens to straddle
 * a cut still returns that sentence whole: whatever the cut falls through is
 * complete in one of the two chunks. It is taken back by whole pieces where
 * it can be — ending a chunk on a word rather than mid-word — and by raw
 * characters only when one piece is itself longer than the overlap.
 */
function mergePieces(pieces: string[], chunkSize: number, chunkOverlap: number): string[] {
  const chunks: string[] = [];
  let buffer: string[] = [];
  let length = 0;

  const flush = (): void => {
    if (length === 0) return;
    chunks.push(buffer.join(""));

    if (chunkOverlap <= 0) {
      buffer = [];
      length = 0;
      return;
    }

    // Walk back from the end taking whole pieces while they fit the overlap.
    const kept: string[] = [];
    let keptLength = 0;
    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      if (keptLength + buffer[i].length > chunkOverlap) break;
      kept.unshift(buffer[i]);
      keptLength += buffer[i].length;
    }
    if (kept.length === 0) {
      // One piece longer than the whole overlap (a 300-character sentence
      // with a 150-character overlap). Take its tail so the chunks still
      // overlap at all — losing the overlap entirely would be worse than
      // starting mid-sentence.
      const tail = buffer[buffer.length - 1].slice(-chunkOverlap);
      kept.push(tail);
      keptLength = tail.length;
    }
    buffer = kept;
    length = keptLength;
  };

  for (const piece of pieces) {
    if (length > 0 && length + piece.length > chunkSize) flush();

    // The carried-over overlap plus this piece can itself exceed the chunk
    // size — a chunk ending on a long paragraph carries a 150-character tail
    // into the next, and the next paragraph may already be near the full
    // budget. Found against the real API on a document with alternating long
    // and short paragraphs. Overlap is given up rather than the size,
    // because the size is the budget every downstream prompt is built on.
    while (buffer.length > 1 && length + piece.length > chunkSize) {
      length -= buffer[0].length;
      buffer.shift();
    }
    if (buffer.length === 1 && length + piece.length > chunkSize) {
      // One overlap piece left and it still doesn't fit: keep as much of its
      // tail as there is room for (a tail, so the chunk stays a contiguous
      // slice), down to none at all.
      const room = chunkSize - piece.length;
      const kept = room > 0 ? buffer[0].slice(-room) : "";
      buffer = kept === "" ? [] : [kept];
      length = kept.length;
    }

    buffer.push(piece);
    length += piece.length;
  }
  if (length > 0) chunks.push(buffer.join(""));

  return chunks;
}

/**
 * Splits Converted Markdown into embeddable chunks — ingestion stage 3's
 * chunking half (NBK-8).
 *
 * Two passes, in the order NBK-1 specifies. First the heading split, shared
 * with stage 2: `splitMarkdownSections`, the `MarkdownHeaderTextSplitter`
 * equivalent — one splitter, used by both stages, so a chunk's heading path
 * and a section summary's are the same notion of "where". Then a finer
 * recursive character split *within* each section, 1000 characters with 150
 * of overlap.
 *
 * Per section rather than over the whole document, so no chunk ever
 * straddles two headings and every chunk has exactly one true heading path.
 * A heading with no body of its own contributes no chunk — there is nothing
 * to embed — but still appears in its children's paths.
 *
 * Chunk text is a verbatim, contiguous slice of the Converted Markdown; the
 * heading path travels beside it rather than being prepended to it, so a
 * Citation can find the Chunk in the document the reader is shown.
 */
export function chunkMarkdown(markdown: string, options: ChunkingOptions = {}): DocumentChunk[] {
  const chunkSize = Math.max(1, options.chunkSize ?? CHUNK_SIZE);
  // An overlap at or above the chunk size could never advance.
  const chunkOverlap = Math.min(Math.max(0, options.chunkOverlap ?? CHUNK_OVERLAP), chunkSize - 1);

  const chunks: DocumentChunk[] = [];
  for (const section of splitMarkdownSections(markdown)) {
    const content = section.content.trim();
    if (content === "") continue;

    for (const text of mergePieces(splitIntoPieces(content, chunkSize, SEPARATORS), chunkSize, chunkOverlap)) {
      const trimmed = text.trim();
      if (trimmed === "") continue;
      chunks.push({ index: chunks.length, headingPath: section.headingPath, text: trimmed });
    }
  }

  return chunks;
}
