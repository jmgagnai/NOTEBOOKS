/** One Chunk of one Document Version: what a Citation and a search result both point at. */
export interface ChunkPin {
  versionId: string;
  chunkId: string;
  /** The Chunk's range in the Version's Converted Markdown; null when it could not be located. */
  charStart: number | null;
  charEnd: number | null;
}

/**
 * The query that opens the Document page at a Chunk (NBK-12): the pinned
 * Version, the Chunk, and its range, which the page scrolls to and marks.
 * Shared by Citation links and search results (NBK-96).
 */
export function chunkLinkParams(pin: ChunkPin): Record<string, string | number> {
  const params: Record<string, string | number> = { version: pin.versionId, chunk: pin.chunkId };
  // Omitted rather than sent as null when the Chunk could not be located in
  // the Converted Markdown: the Version still opens, just not scrolled.
  if (pin.charStart !== null) params['from'] = pin.charStart;
  if (pin.charEnd !== null) params['to'] = pin.charEnd;
  return params;
}
