-- Keyword search (NBK-104): Documents are searched by keyword now, like
-- Chat Threads (NBK-97), and both ignore accents — "etretat" finds
-- "Étretat". A text search configuration that is `simple` (no stemming:
-- Notebooks mix French and English, and one language's stemmer mangles the
-- other's words and the names people search for) with every word run
-- through `unaccent` first. Search indexes and queries on exactly
-- `to_tsvector('simple_unaccent', …)`, so the expressions below and in
-- src/search/ must stay identical. See src/search/keywords.ts.
CREATE EXTENSION IF NOT EXISTS unaccent;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'simple_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION simple_unaccent (COPY = simple);
    ALTER TEXT SEARCH CONFIGURATION simple_unaccent
      ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part,
                        numword, numhword, hword_numpart
      WITH unaccent, simple;
  END IF;
END
$$;

-- Migration 0014's index was on the `simple` expression, which no query
-- uses any more.
DROP INDEX IF EXISTS idx_chat_messages_content_fts;
CREATE INDEX IF NOT EXISTS idx_chat_messages_content_fts
  ON chat_messages USING GIN (to_tsvector('simple_unaccent', content));

CREATE INDEX IF NOT EXISTS idx_chunks_text_fts
  ON chunks USING GIN (to_tsvector('simple_unaccent', text));
