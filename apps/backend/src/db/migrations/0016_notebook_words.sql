-- Typo tolerance (NBK-105): every distinct word of a Notebook's Chunks and
-- chat messages, so a misspelt query word ("rosigny") can be corrected to
-- the closest word the Notebook really holds ("rossigny") before the
-- keyword search runs. The words are `simple_unaccent` lexemes (migration
-- 0015) — lowercased, unaccented — exactly what the search matches on.
--
-- Words are only ever added: one left behind by a deleted Document or Chat
-- Thread corrects a query towards something that is no longer found, which
-- costs a "no results", never a wrong one.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- For a GIN index on the Notebook id beside the trigram one: the closest
-- word within one Notebook in a single index scan (measured: under 1 ms
-- among 1.6M words, docs/search.md).
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- No unique key, on purpose. Writers add a word only when it is not there
-- yet, and two transactions adding the same new word at once leave it
-- twice, which every reader tolerates. A unique key would make each writer
-- wait on the others' uncommitted words: two Documents of a Notebook
-- ingesting at once could deadlock, and an answer being recorded would wait
-- for a stage-3 transaction to commit.
CREATE TABLE IF NOT EXISTS notebook_words (
  notebook_id UUID NOT NULL REFERENCES notebooks (id) ON DELETE CASCADE,
  word TEXT NOT NULL
);

-- Kept by the database rather than by each writer: a Chunk is written by
-- ingestion stage 3 and a message by chat, and a word list one of them
-- forgot to update would silently stop correcting towards its words.
CREATE OR REPLACE FUNCTION add_notebook_words(notebook UUID, content TEXT) RETURNS void AS $$
  INSERT INTO notebook_words (notebook_id, word)
  SELECT DISTINCT notebook, lexeme
  FROM unnest(tsvector_to_array(to_tsvector('simple_unaccent', content))) AS lexeme
  WHERE NOT EXISTS (
    SELECT 1 FROM notebook_words w WHERE w.notebook_id = notebook AND w.word = lexeme
  );
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION notebook_words_from_chunk() RETURNS trigger AS $$
BEGIN
  PERFORM add_notebook_words(d.notebook_id, NEW.text)
  FROM document_versions v
  JOIN documents d ON d.id = v.document_id
  WHERE v.id = NEW.document_version_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION notebook_words_from_message() RETURNS trigger AS $$
BEGIN
  PERFORM add_notebook_words(t.notebook_id, NEW.content)
  FROM chat_threads t
  WHERE t.id = NEW.chat_thread_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunks_notebook_words ON chunks;
CREATE TRIGGER chunks_notebook_words
  AFTER INSERT ON chunks
  FOR EACH ROW EXECUTE FUNCTION notebook_words_from_chunk();

DROP TRIGGER IF EXISTS chat_messages_notebook_words ON chat_messages;
CREATE TRIGGER chat_messages_notebook_words
  AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION notebook_words_from_message();

-- The words already there, in one pass, before the indexes exist: building
-- an index over the finished table is far cheaper than updating it a row at
-- a time (about 1.3M words on a 138k-Chunk development database).
INSERT INTO notebook_words (notebook_id, word)
SELECT DISTINCT notebook_id, lexeme
FROM (
  SELECT d.notebook_id, c.text AS content
  FROM chunks c
  JOIN document_versions v ON v.id = c.document_version_id
  JOIN documents d ON d.id = v.document_id
  UNION ALL
  SELECT t.notebook_id, m.content
  FROM chat_messages m
  JOIN chat_threads t ON t.id = m.chat_thread_id
) source
CROSS JOIN unnest(tsvector_to_array(to_tsvector('simple_unaccent', source.content))) AS lexeme;

-- Is this word the Notebook's? (the writers' check, and a query word's).
CREATE INDEX IF NOT EXISTS idx_notebook_words_word ON notebook_words (notebook_id, word);
-- Which of the Notebook's words is closest to this one?
CREATE INDEX IF NOT EXISTS idx_notebook_words_trigram
  ON notebook_words USING GIN (notebook_id, word gin_trgm_ops);
