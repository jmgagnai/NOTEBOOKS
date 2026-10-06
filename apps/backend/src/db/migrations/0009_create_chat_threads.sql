-- Chat Threads and their messages (NBK-10). See GLOSSARY.md: a Chat Thread is
-- "a named sequence of messages asked against a Notebook's Documents, started
-- by one user (its author) but visible to every user who opens the Notebook,
-- the same as Documents."
--
-- `created_by` is that author. It exists for attribution and nothing else:
-- per ADR-0001 there is no ownership check anywhere in this feature, and any
-- authenticated user may read, rename, or continue any Thread. The column is
-- the record of *who started it*, never a gate on *who may use it*.
CREATE TABLE IF NOT EXISTS chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notebook_id UUID NOT NULL REFERENCES notebooks (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every read starts from "the Threads in this Notebook", listed newest-first
-- so the thread someone is most likely to continue is at the top.
CREATE INDEX IF NOT EXISTS idx_chat_threads_notebook
  ON chat_threads (notebook_id, created_at DESC);

-- One message in a Thread.
--
-- `asked_by` is NOT NULL for both roles, which is deliberate. GLOSSARY.md
-- says "every message in it records which user asked it" — and the asker of
-- an assistant message is the user whose question produced it. Keeping the
-- column non-null means a shared Thread can always answer "whose exchange
-- was this?" for every row, instead of leaving half of them anonymous.
--
-- `role` is 'user' or 'assistant' only. There is no 'system' role row: the
-- grounding prompt is assembled per request from the Notebook's current Chat
-- Snippets and retrieved Chunks (it changes as Documents are re-ingested),
-- so storing one would record something that is no longer true.
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_thread_id UUID NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
  asked_by UUID NOT NULL REFERENCES users (id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  -- Message order within a Thread, and the column every read orders by.
  --
  -- Not `created_at`: a question and the answer it produced are written in
  -- one transaction, so both carry the same `now()` and a timestamp sort
  -- could put the answer first. A sequence makes the order of a conversation
  -- a fact rather than a tie-break.
  seq BIGSERIAL NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_role_check CHECK (role IN ('user', 'assistant'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
  ON chat_messages (chat_thread_id, seq);
