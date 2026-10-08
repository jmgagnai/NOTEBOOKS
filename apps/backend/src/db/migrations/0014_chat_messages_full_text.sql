-- Chat Thread search (NBK-97): every message — questions and answers — by
-- keyword, through Postgres full-text search rather than embeddings (no
-- OpenRouter call, and every existing message searchable at once). The
-- `simple` configuration on purpose: Notebooks mix French and English, and a
-- language's stemming would mangle the other's words and the names people
-- search for. The query matches on exactly this expression, so it must stay
-- `to_tsvector('simple', content)` on both sides.
CREATE INDEX IF NOT EXISTS idx_chat_messages_content_fts
  ON chat_messages USING GIN (to_tsvector('simple', content));
