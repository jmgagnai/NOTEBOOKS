import type { Pool } from 'pg';
import { locateChunkRanges } from '../documents/chunk-ranges.js';
import type { RetrievedChunk } from './retrieval.js';

/**
 * One Citation an answer earned: the exact Chunk a claim came from, the
 * marker the model used to refer to it, and where that Chunk's text sits in
 * its Document Version's Converted Markdown.
 *
 * `chunk` carries `documentVersionId` as well as `chunkId`, which is the
 * whole point — per GLOSSARY.md a Citation is "a pointer into one specific
 * Document Version at one specific chunk", and that Version is the one that
 * was retrieved, not whatever is latest when someone later follows the link.
 */
export interface ResolvedCitation {
  /** The 1-based source marker as it appears in the answer text ("[2]"). */
  marker: number;
  chunk: RetrievedChunk;
  /** Start of the chunk's text in the Converted Markdown, or null if unlocatable. */
  charStart: number | null;
  /** End of that range, exclusive. Null whenever `charStart` is. */
  charEnd: number | null;
}

/**
 * The outcome of reading an answer's source markers.
 *
 * `unresolvedMarkers` is kept rather than thrown away so the caller can say
 * out loud that the model referred to a source that does not exist — see
 * `resolveCitationMarkers` for why that is a log line and not a failure.
 */
export interface CitationResolution {
  citations: ResolvedCitation[];
  unresolvedMarkers: number[];
}

/**
 * The part of the system prompt that asks for attributable claims.
 *
 * Kept next to the parser that reads the markers back, because the two are
 * one contract: change the notation asked for here and
 * `resolveCitationMarkers` stops finding anything. The notation is
 * deliberately the most conventional one a model will have seen — bracketed
 * integers after the sentence they support.
 *
 * It calls the evidence **Chunks**, GLOSSARY.md's word, which explicitly
 * lists "passage" among the terms to avoid. That matters more here than in
 * ordinary prose: the model reads this text and echoes its vocabulary back
 * into answers a user reads, so a prompt that says "passage" is how a
 * banned synonym gets into the product. The label in `formatSources` uses
 * the same word for the same reason.
 */
export const CITATION_INSTRUCTIONS = [
  '- Cite your sources. Every Chunk you were given is labelled with a number, like [2].',
  '  End each sentence that makes a factual claim with the marker(s) of the Chunk(s) it came',
  '  from, e.g. "Revenue was 12.4M [2]." Use several markers when a claim draws on several',
  '  Chunks, each in its own brackets: "[1][3]".',
  '- Only ever use a marker that appears in the Chunks above. Never invent one, never cite a',
  '  source you were not given, and never cite a marker for a claim it does not support.',
].join('\n');

/**
 * Finds the source markers in an answer and turns them into Citations
 * against the Chunks that were actually retrieved for it.
 *
 * `chunks` is the evidence that was put in front of the model, in the order
 * it was numbered. A marker is only ever resolved by indexing into that list,
 * so a Citation structurally cannot point at a Chunk this answer was not
 * grounded in — which is the one invariant that makes a Citation worth
 * clicking.
 *
 * A marker outside the list (the model invented "[9]" for nine sources it
 * never saw, or wrote "[0]") resolves to nothing and is reported in
 * `unresolvedMarkers`. The answer text is deliberately left exactly as the
 * model wrote it and is still recorded: a dangling marker renders as the
 * plain text it is, whereas rewriting the prose would mean showing the user
 * something the model did not say, and rejecting the answer outright would
 * throw away a possibly perfect answer because of a formatting slip — and
 * make every question depend on the model obeying an instruction it has no
 * obligation to obey. An answer with no resolvable markers is therefore an
 * answer with no Citations, which is at least honest about its provenance.
 *
 * Each marker yields at most one Citation: a Chunk cited by three separate
 * sentences is one source, referred to three times.
 */
export function resolveCitationMarkers(
  answer: string,
  chunks: RetrievedChunk[],
): CitationResolution {
  // One or more integers inside one pair of brackets. Comma-separated groups
  // ("[1, 3]") are accepted as well as separate brackets, because models
  // write both and the distinction is not worth losing a Citation over.
  const MARKER_GROUP = /\[\s*(\d{1,3}(?:\s*,\s*\d{1,3})*)\s*\]/g;

  const byMarker = new Map<number, ResolvedCitation>();
  const unresolved = new Set<number>();

  for (const match of answer.matchAll(MARKER_GROUP)) {
    for (const part of match[1].split(',')) {
      const marker = Number(part.trim());
      if (!Number.isInteger(marker)) continue;
      const chunk = chunks[marker - 1];
      if (marker < 1 || !chunk) {
        unresolved.add(marker);
        continue;
      }
      if (!byMarker.has(marker)) {
        byMarker.set(marker, { marker, chunk, charStart: null, charEnd: null });
      }
    }
  }

  // Ordered by marker, which is retrieval order — the same order the source
  // list under an answer is read in, and the order rows come back from
  // Postgres in, so a Citation list survives a round trip unchanged.
  return {
    citations: [...byMarker.values()].sort((a, b) => a.marker - b.marker),
    unresolvedMarkers: [...unresolved].sort((a, b) => a - b),
  };
}

/**
 * Fills in each Citation's character range in its Version's Converted
 * Markdown (`locateChunkRanges`). A Chunk that cannot be found keeps a null
 * range: following that Citation still opens its exact Version, just not
 * scrolled.
 */
export async function locateCitations(
  pool: Pool,
  citations: ResolvedCitation[],
): Promise<ResolvedCitation[]> {
  const ranges = await locateChunkRanges(
    pool,
    citations.map((c) => c.chunk.documentVersionId),
  );
  return citations.map((citation) => {
    const range = ranges.get(citation.chunk.chunkId);
    return range ? { ...citation, ...range } : citation;
  });
}
