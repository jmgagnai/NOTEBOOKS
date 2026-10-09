-- NBK-107: where each Chunk sits in its Version's Converted Markdown, stored.
-- A search opens each result at its Chunk, and finding that range on every
-- query meant reading the result Versions' whole Converted Markdown and all
-- their Chunks: most of a search's time. Ingestion stage 3 now stores the
-- ranges when it writes a Version's Chunks; a Version written before this
-- is located by the first search that meets it.
--
-- In a table of their own rather than on `chunks`: storing a range on an
-- existing Chunk rewrote its row, and with it the stored `search_vector`
-- and its GIN entries (migration 0017) — measured, the first search over a
-- Version went from 0.9 s to 27 s. Here it inserts small rows instead.
-- A Chunk with no row cannot be found in the Markdown (a null range).
CREATE TABLE IF NOT EXISTS chunk_ranges (
  chunk_id UUID PRIMARY KEY REFERENCES chunks (id) ON DELETE CASCADE,
  char_start INTEGER NOT NULL CHECK (char_start >= 0),
  char_end INTEGER NOT NULL CHECK (char_end >= char_start)
);

-- Whether a Version's Chunks have been located at all, so a Chunk that
-- cannot be found is not looked for again on every search.
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS chunk_ranges_located_at TIMESTAMPTZ;
