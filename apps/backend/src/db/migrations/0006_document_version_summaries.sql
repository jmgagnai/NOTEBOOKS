-- Ingestion stage 2 (NBK-7): extracted metadata and the three Generated
-- document artifacts, all stored on the Document Version alongside the
-- Converted Markdown they were derived from.
--
-- The three summaries get three columns, not one JSON blob and not one
-- "summary" column, because per GLOSSARY.md they are three precisely-defined,
-- non-interchangeable artifacts with three different consumers:
--
--   chat_snippet      : 150-300 words, injected into the LLM's chat context
--                       as grounding. Written for a model to read.
--   executive_summary : 1-2 pages, shown first when a user opens a Document.
--   abstract          : 50-100 words, shown on Document cards and in search
--                       results, to be skimmed in a list.
--
-- `metadata` is JSONB rather than title/author/... columns: what an extractor
-- can find varies by document kind (a contract's parties, a report's
-- publication date), and this is descriptive data the application reads back
-- whole, never filters or joins on.
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS metadata JSONB,
  ADD COLUMN IF NOT EXISTS chat_snippet TEXT,
  ADD COLUMN IF NOT EXISTS executive_summary TEXT,
  ADD COLUMN IF NOT EXISTS abstract TEXT,
  ADD COLUMN IF NOT EXISTS summarized_at TIMESTAMPTZ;

-- Stage 2 extends the status progression rather than adding a parallel field
-- (see the 0005 comment): a Version that stage 1 left "converted" is picked
-- up as "summarizing" and ends "summarized" — the state stage 3 (chunking)
-- will consume.
ALTER TABLE document_versions
  DROP CONSTRAINT IF EXISTS document_versions_ingestion_status_check;

ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_ingestion_status_check
  CHECK (ingestion_status IN ('queued', 'converting', 'converted', 'summarizing', 'summarized', 'failed'));
