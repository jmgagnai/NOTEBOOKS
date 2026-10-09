-- NBK-109: the word list spelling correction reads (migration 0016) was 83%
-- base64. Pictures embedded in Converted Markdown were chunked before
-- NBK-108, and every piece `simple_unaccent` cut from them became a
-- "word": 1.2M of the dev database's 1.45M, a 693 MB table and a 404 MB
-- trigram index that no longer stayed cached, so a first search read them
-- from disk (up to 734 ms for the correction alone).
--
-- Whether a lexeme is a word, in one place, for the purge below and for
-- every word added from now on. Only lexemes made of base64's characters
-- are judged — Cyrillic, CJK or accented words never are — and of those,
-- what real text does not produce: more than 25 characters; a `/`; ten or
-- more characters mixing letters and digits; or six or more switching
-- between letters and digits twice. Measured on the dev list: no real word
-- among the samples it rejects, while "mp3", "covid19" and "h2o" stay; a
-- few real words go ("md5sum", "iphone15pro", 26+ letter words), which
-- spelling correction then searches as typed (src/search/correction.ts).
-- Base64 runs it misses — letters alone up to 25 long, short mixed ones
-- like "xapxny10" — stay: they look like real words by every measure tried.
CREATE OR REPLACE FUNCTION is_notebook_word(lexeme TEXT) RETURNS boolean AS $$
  SELECT lexeme !~ '^[a-z0-9+/=]+$'
      OR NOT (
        length(lexeme) > 25
        OR position('/' IN lexeme) > 0
        OR (length(lexeme) >= 10 AND lexeme ~ '[0-9]' AND lexeme ~ '[a-z]')
        OR (length(lexeme) >= 6 AND lexeme ~ '([a-z][0-9]+[a-z]|[0-9][a-z]+[0-9])')
      );
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION add_notebook_words(notebook UUID, vector tsvector) RETURNS void AS $$
  INSERT INTO notebook_words (notebook_id, word)
  SELECT DISTINCT notebook, lexeme
  FROM unnest(tsvector_to_array(vector)) AS lexeme
  WHERE is_notebook_word(lexeme)
    AND NOT EXISTS (
      SELECT 1 FROM notebook_words w WHERE w.notebook_id = notebook AND w.word = lexeme
    );
$$ LANGUAGE sql;

-- Rebuilt rather than deleted from: a DELETE leaves the table and its
-- indexes at full size until a VACUUM FULL and a REINDEX, and a migration
-- runs in a transaction, where VACUUM cannot. Copying the 17% kept is also
-- faster than deleting the 83% not.
CREATE TABLE notebook_words_kept AS
  SELECT notebook_id, word FROM notebook_words WHERE is_notebook_word(word);
DROP TABLE notebook_words;
ALTER TABLE notebook_words_kept RENAME TO notebook_words;
ALTER TABLE notebook_words
  ALTER COLUMN notebook_id SET NOT NULL,
  ALTER COLUMN word SET NOT NULL,
  ADD CONSTRAINT notebook_words_notebook_id_fkey
    FOREIGN KEY (notebook_id) REFERENCES notebooks (id) ON DELETE CASCADE;
CREATE INDEX idx_notebook_words_trigram ON notebook_words USING GIN (notebook_id, word gin_trgm_ops);
CREATE INDEX idx_notebook_words_word ON notebook_words (notebook_id, word);
-- Statistics for the new table now, not whenever autovacuum gets to it.
ANALYZE notebook_words;
