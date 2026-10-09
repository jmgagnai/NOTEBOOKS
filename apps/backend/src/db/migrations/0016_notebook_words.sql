-- Typo tolerance (NBK-105): every distinct word of a Notebook's Chunks and
-- chat messages, so a misspelt query word ("rosigny") can be corrected to
-- the closest word the Notebook really holds ("rossigny") before the
-- keyword search runs. The words are `simple_unaccent` lexemes (migration
-- 0015) — lowercased, unaccented — exactly what the search matches on, and
-- indexed by trigrams so the closest one is found without a scan.
--
-- Words are only ever added: one left behind by a deleted Document or Chat
-- Thread corrects a query towards something that is no longer found, which
-- costs a "no results", never a wrong one.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS notebook_words (
  notebook_id UUID NOT NULL REFERENCES notebooks (id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  PRIMARY KEY (notebook_id, word)
);

CREATE INDEX IF NOT EXISTS idx_notebook_words_trigram
  ON notebook_words USING GIN (word gin_trgm_ops);

-- Kept by the database rather than by each writer: a Chunk is written by
-- ingestion stage 3 and a message by chat, and a word list one of them
-- forgot to update would silently stop correcting towards its words.
CREATE OR REPLACE FUNCTION notebook_words_from_chunk() RETURNS trigger AS $$
BEGIN
  INSERT INTO notebook_words (notebook_id, word)
  SELECT d.notebook_id, lexeme
  FROM document_versions v
  JOIN documents d ON d.id = v.document_id
  CROSS JOIN unnest(tsvector_to_array(to_tsvector('simple_unaccent', NEW.text))) AS lexeme
  WHERE v.id = NEW.document_version_id
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION notebook_words_from_message() RETURNS trigger AS $$
BEGIN
  INSERT INTO notebook_words (notebook_id, word)
  SELECT t.notebook_id, lexeme
  FROM chat_threads t
  CROSS JOIN unnest(tsvector_to_array(to_tsvector('simple_unaccent', NEW.content))) AS lexeme
  WHERE t.id = NEW.chat_thread_id
  ON CONFLICT DO NOTHING;
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

-- The words already there.
INSERT INTO notebook_words (notebook_id, word)
SELECT DISTINCT d.notebook_id, lexeme
FROM chunks c
JOIN document_versions v ON v.id = c.document_version_id
JOIN documents d ON d.id = v.document_id
CROSS JOIN unnest(tsvector_to_array(to_tsvector('simple_unaccent', c.text))) AS lexeme
ON CONFLICT DO NOTHING;

INSERT INTO notebook_words (notebook_id, word)
SELECT DISTINCT t.notebook_id, lexeme
FROM chat_messages m
JOIN chat_threads t ON t.id = m.chat_thread_id
CROSS JOIN unnest(tsvector_to_array(to_tsvector('simple_unaccent', m.content))) AS lexeme
ON CONFLICT DO NOTHING;
