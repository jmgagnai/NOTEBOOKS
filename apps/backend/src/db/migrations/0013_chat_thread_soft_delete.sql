-- Chat Thread deletion (NBK-95): soft, like Notebooks and Documents. Only its
-- author deletes a Chat Thread (ADR-0001 amendment); setting `deleted_at`
-- rather than removing the row keeps its messages — and the Citations in
-- them, which `ON DELETE CASCADE` from chat_messages would otherwise take —
-- so an Administrator can restore it.
ALTER TABLE chat_threads
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- The Notebook's Thread list reads only live Threads, newest first.
CREATE INDEX IF NOT EXISTS idx_chat_threads_notebook_active
  ON chat_threads (notebook_id, created_at)
  WHERE deleted_at IS NULL;
