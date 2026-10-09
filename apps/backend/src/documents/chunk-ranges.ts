import type { Pool } from 'pg';

/** Where one Chunk sits in its Version's Converted Markdown. */
export interface ChunkRange {
  charStart: number;
  charEnd: number;
}

interface ChunkTextRow {
  id: string;
  document_version_id: string;
  chunk_index: number;
  text: string;
}

/**
 * Finds where each Chunk of the given Document Versions sits in its
 * Version's Converted Markdown — the range a Citation (NBK-12) and a search
 * result's best Chunk (NBK-96) open the Document page at.
 *
 * It can be done by searching at all because of GLOSSARY.md's guarantee that
 * a Chunk's text is "a verbatim, contiguous slice of the Converted Markdown
 * — never a rewritten or summarized form of it".
 *
 * The search walks a Version's chunks in `chunk_index` order with a cursor
 * that only ever moves forward, which is what makes it exact rather than
 * approximate: a document that repeats a block of text verbatim (a boilerplate
 * disclaimer under two headings, a table header repeated per page) would send
 * a naive "first occurrence of this text" search to the wrong copy, while a
 * forward scan in document order lands on the copy the chunk actually is.
 * The cursor advances by one character rather than by the chunk's length
 * because consecutive chunks overlap (150 characters, NBK-8), so chunk n+1
 * starts *before* chunk n ends.
 *
 * Only the Versions asked about are read, and each one's Markdown only
 * once. The cost is one pass over those Versions' content: paid once per
 * Citation (persisted on its row, NBK-12), and on every query for a search
 * result's best Chunk (NBK-96, `docs/search.md`).
 *
 * A chunk whose text cannot be found (a Version with no Converted Markdown,
 * or text that line-ending normalisation has moved away from the source) is
 * left out of the map: a link to it still opens its exact Version, just not
 * scrolled.
 */
export async function locateChunkRanges(
  pool: Pool,
  versionIds: readonly string[],
): Promise<Map<string, ChunkRange>> {
  const ranges = new Map<string, ChunkRange>();
  const unique = [...new Set(versionIds)];
  if (unique.length === 0) return ranges;

  const { rows: versionRows } = await pool.query<{ id: string; markdown: string | null }>(
    'SELECT id, markdown FROM document_versions WHERE id = ANY($1::uuid[])',
    [unique],
  );
  const markdownByVersion = new Map(versionRows.map((row) => [row.id, row.markdown]));

  const { rows: chunkRows } = await pool.query<ChunkTextRow>(
    `SELECT id, document_version_id, chunk_index, text
     FROM chunks
     WHERE document_version_id = ANY($1::uuid[])
     ORDER BY document_version_id, chunk_index`,
    [unique],
  );

  const chunksByVersion = new Map<string, ChunkTextRow[]>();
  for (const row of chunkRows) {
    const list = chunksByVersion.get(row.document_version_id) ?? [];
    list.push(row);
    chunksByVersion.set(row.document_version_id, list);
  }

  for (const [versionId, chunks] of chunksByVersion) {
    const markdown = markdownByVersion.get(versionId);
    if (!markdown) continue;
    const located = locateInMarkdown(
      markdown,
      chunks.map((chunk) => chunk.text),
    );
    for (const [i, chunk] of chunks.entries()) {
      const range = located[i];
      if (range) ranges.set(chunk.id, range);
    }
  }
  return ranges;
}

/**
 * The forward scan itself: where each of a Version's Chunk texts, in
 * `chunk_index` order, sits in its Converted Markdown, or null where it
 * cannot be found. Ingestion stage 3 runs it as it writes the Chunks
 * (NBK-107); `locateChunkRanges` runs it over Chunks already stored.
 */
export function locateInMarkdown(
  markdown: string,
  texts: readonly string[],
): (ChunkRange | null)[] {
  let cursor = 0;
  return texts.map((text) => {
    const at = markdown.indexOf(text, cursor);
    if (at === -1) return null;
    cursor = at + 1;
    return { charStart: at, charEnd: at + text.length };
  });
}

/**
 * Locates the Chunks of Versions not located yet — written before ranges
 * were stored (NBK-107) — and stores what it found in `chunk_ranges`, marking
 * each Version located, so no later search rescans it. A Chunk that cannot
 * be found keeps a null range; its Version still counts as located.
 */
export async function storeChunkRanges(
  pool: Pool,
  versionIds: readonly string[],
): Promise<Map<string, ChunkRange>> {
  const unique = [...new Set(versionIds)];
  if (unique.length === 0) return new Map();
  const ranges = await locateChunkRanges(pool, unique);
  const ids = [...ranges.keys()];
  // Into their own table, never onto `chunks`: rewriting a Chunk's row
  // would recompute its stored search vector and GIN entries (0018's note).
  await pool.query(
    `INSERT INTO chunk_ranges (chunk_id, char_start, char_end)
     SELECT * FROM unnest($1::uuid[], $2::int[], $3::int[])
     ON CONFLICT (chunk_id) DO UPDATE SET char_start = EXCLUDED.char_start, char_end = EXCLUDED.char_end`,
    [ids, ids.map((id) => ranges.get(id)!.charStart), ids.map((id) => ranges.get(id)!.charEnd)],
  );
  await pool.query(
    'UPDATE document_versions SET chunk_ranges_located_at = now() WHERE id = ANY($1::uuid[])',
    [unique],
  );
  return ranges;
}
