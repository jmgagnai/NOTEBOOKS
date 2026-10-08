import { Citation } from './chat.store';
import { chunkLinkParams } from '../documents/chunk-link';

/**
 * One piece of an answer's prose: either plain text, or a Citation marker
 * that resolved to a Citation.
 *
 * Splitting the answer rather than rewriting it is what keeps the prose
 * exactly as the model wrote it — a marker the backend dropped (because it
 * named a Chunk that was never retrieved) stays visible as the plain text
 * it is instead of becoming a link to nowhere.
 */
export interface AnswerSegment {
  text: string;
  /** The Citation this segment links to, or null for ordinary prose. */
  citation: Citation | null;
}

/** The marker notation the backend asks the model for, read back here. */
const MARKER = /\[(\d{1,3})\]/g;

/**
 * Splits prose on its Citation markers, pairing each marker with the Citation
 * it refers to.
 *
 * A marker with no Citation stays a plain-text segment: the backend only
 * records Citations for markers that named a Chunk the answer was actually
 * grounded in, so an unmatched marker is one it deliberately dropped and
 * must not be made clickable.
 *
 * Takes the text and the Citations rather than a `ChatMessage` so a streaming
 * answer's chunks go through the same code (NBK-11). That is worth the extra
 * parameter: a chunk whose markers rendered differently from the recorded
 * message's would make the preview visibly swap for something else at the
 * end. It also means a marker in a chunk is plain text until the completion
 * event brings the Citations, which is correct — they cannot be resolved
 * from a half-written answer.
 */
export function answerSegments(content: string, citations: Citation[]): AnswerSegment[] {
  const byMarker = new Map(citations.map((c) => [c.marker, c]));
  const segments: AnswerSegment[] = [];
  let from = 0;

  for (const match of content.matchAll(MARKER)) {
    const citation = byMarker.get(Number(match[1]));
    if (!citation) continue;
    const at = match.index!;
    if (at > from) segments.push({ text: content.slice(from, at), citation: null });
    segments.push({ text: match[0], citation });
    from = at + match[0].length;
  }
  if (from < content.length) {
    segments.push({ text: content.slice(from), citation: null });
  }
  return segments;
}

/**
 * What a reader hears a Citation called. Per NBK-12 the name derives from
 * the chunk's heading path — the Document's filename says *which* Document,
 * the path says where in it — so no label is stored or sent.
 */
export function citationName(citation: Citation): string {
  return citation.headingPath.length > 0
    ? `${citation.filename} — ${citation.headingPath.join(' > ')}`
    : citation.filename;
}

/**
 * A Citation chip's tooltip: which Document and which Version, exactly as
 * spec 04 "Citation chips" words it. The heading path is left to the chip's
 * accessible name (`citationName`), where it does not crowd a hover.
 */
export function citationTitle(citation: Citation): string {
  return `${citation.filename} (v${citation.versionNumber})`;
}

/**
 * The route a Citation opens: its Document, with the pinned Version, the
 * pinned chunk and that chunk's character range as query parameters.
 *
 * The Version id travels in the link rather than being looked up on arrival
 * because the Document's latest Version may well have moved on — and
 * GLOSSARY.md requires that following a Citation still open "that exact
 * Version at that location, even after newer Versions exist". The character
 * range rides along so the link is self-sufficient: copied, bookmarked or
 * shared, it still scrolls to the cited Chunk, because the range is fixed to
 * a Version whose content can never change.
 */
export function citationLink(notebookId: string, citation: Citation): (string | number)[] {
  return ['/notebooks', notebookId, 'documents', citation.documentId];
}

/**
 * The query a Citation's link carries: the pinned Version, Chunk and range
 * (see `citationLink`), and the Chat Thread the answer citing it is in, so
 * the Document page opens with that Thread beside the Document (spec 08) —
 * also from a pasted link, where nothing else could say which Thread.
 */
export function citationParams(
  citation: Citation,
  threadId: string,
): Record<string, string | number> {
  return {
    ...chunkLinkParams({ ...citation, versionId: citation.documentVersionId }),
    thread: threadId,
  };
}
