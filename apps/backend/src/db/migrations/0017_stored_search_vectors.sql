-- NBK-106: keyword search ranks on a stored search vector. Searching
-- "the" in a 160,000-Chunk Notebook took 12.6 s, almost all of it spent
-- recomputing `to_tsvector('simple_unaccent', text)` for every one of the
-- 21,739 matching Chunks — for `ts_rank`, and again for the "matched as
-- typed" ordering (NBK-105) — while the GIN index found the matches in
-- milliseconds. Stored once per row, the vector is read instead.
--
-- Generated, so every writer gets it for free; `simple_unaccent` as in
-- migration 0015, and the configuration src/search/keywords.ts names. A
-- one-off cost: adding a stored column rewrites the table once.
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple_unaccent', text)) STORED;
CREATE INDEX IF NOT EXISTS idx_chunks_search_vector ON chunks USING GIN (search_vector);
DROP INDEX IF EXISTS idx_chunks_text_fts;

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple_unaccent', content)) STORED;
CREATE INDEX IF NOT EXISTS idx_chat_messages_search_vector
  ON chat_messages USING GIN (search_vector);
DROP INDEX IF EXISTS idx_chat_messages_content_fts;

-- The word list's triggers (migration 0016) read the stored vector too.
CREATE OR REPLACE FUNCTION add_notebook_words(notebook UUID, vector tsvector) RETURNS void AS $$
  INSERT INTO notebook_words (notebook_id, word)
  SELECT DISTINCT notebook, lexeme
  FROM unnest(tsvector_to_array(vector)) AS lexeme
  WHERE NOT EXISTS (
    SELECT 1 FROM notebook_words w WHERE w.notebook_id = notebook AND w.word = lexeme
  );
$$ LANGUAGE sql;
DROP FUNCTION IF EXISTS add_notebook_words(UUID, TEXT);

CREATE OR REPLACE FUNCTION notebook_words_from_chunk() RETURNS trigger AS $$
BEGIN
  PERFORM add_notebook_words(d.notebook_id, NEW.search_vector)
  FROM document_versions v
  JOIN documents d ON d.id = v.document_id
  WHERE v.id = NEW.document_version_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION notebook_words_from_message() RETURNS trigger AS $$
BEGIN
  PERFORM add_notebook_words(t.notebook_id, NEW.search_vector)
  FROM chat_threads t
  WHERE t.id = NEW.chat_thread_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
