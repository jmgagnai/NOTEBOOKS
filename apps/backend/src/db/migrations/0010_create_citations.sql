-- Citations (NBK-12). See GLOSSARY.md: a Citation is "a pointer into one
-- specific Document Version at one specific chunk, surfaced in a chat answer
-- as a source reference. Following a Citation opens that exact Version at
-- that location, even after newer Versions exist."
--
-- That last clause is the whole reason this table exists and the reason it
-- looks the way it does. `document_version_id` is stored, never derived: if a
-- Citation held only a `document_id` (or only a `chunk_id` and resolved the
-- Version at read time) then re-uploading the file would silently re-point
-- every historical answer at text it was never grounded in, and an old answer
-- would stop being checkable. The pair is written once, when the answer is
-- recorded, and never recomputed.
CREATE TABLE IF NOT EXISTS citations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The answer this Citation belongs to. Cascading: a Citation is part of a
  -- message, not a thing in its own right, so it goes when the message does.
  chat_message_id UUID NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
  -- The exact Version. No ON DELETE clause on purpose: Postgres refuses to
  -- hard-delete a Document Version a Citation still points at, which is the
  -- storage-level expression of "older Versions stay retrievable through
  -- Citations". (Documents and Versions are soft-deleted in normal use, so
  -- this never fires on the happy path.)
  document_version_id UUID NOT NULL REFERENCES document_versions (id),
  -- The exact chunk within that Version. Also without ON DELETE: re-running
  -- ingestion stage 3 replaces a Version's chunks, and a Citation already
  -- pointing into that Version must not be quietly cascaded away (or left
  -- dangling). Re-ingesting a *file* makes a new Version with new chunks, so
  -- the cited rows are untouched — which is the path that actually happens.
  chunk_id UUID NOT NULL REFERENCES chunks (id),
  -- The source marker the model emitted in the answer text ("[2]"), 1-based.
  -- It is how a reader's click on a marker in the prose finds the Citation it
  -- refers to, so it is part of the record rather than a render-time index.
  -- One marker means one Citation per answer: a claim citing the same passage
  -- twice reuses the marker.
  marker INTEGER NOT NULL CHECK (marker > 0),
  -- Where the cited chunk's text sits in that Version's Converted Markdown,
  -- as a half-open character range. Per GLOSSARY.md a Chunk's text is "a
  -- verbatim, contiguous slice of the Converted Markdown", so the chunk has
  -- an exact character range in it — and resolving that range once, here,
  -- rather than searching for the text every time a Citation is opened, is
  -- what makes "scrolled to that chunk's location" cheap and unambiguous.
  --
  -- Nullable because locating can legitimately fail: a Version whose stage-1
  -- conversion never produced Markdown has nothing to offset into. A
  -- Citation with no range still opens its exact Version, just at the top.
  char_start INTEGER CHECK (char_start >= 0),
  char_end INTEGER CHECK (char_end >= char_start),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_message_id, marker)
);

-- Every read is "the Citations of these messages", ordered by marker so the
-- source list under an answer is in the order the prose refers to it.
CREATE INDEX IF NOT EXISTS idx_citations_message
  ON citations (chat_message_id, marker);

-- And the reverse direction: everything that cited a given Version, which is
-- what makes an old Version's retention auditable.
CREATE INDEX IF NOT EXISTS idx_citations_document_version
  ON citations (document_version_id);
