-- Ingestion stage 1 (NBK-6): every uploaded Document Version is converted to
-- Markdown in the background. The lifecycle lives on the Version, not the
-- Document — per GLOSSARY.md a Document is "tracked through successive
-- Document Versions", and re-uploading the same filename produces a new
-- Version that has to be converted independently of the ones before it.
--
-- queued      : the raw bytes are in object storage and a convert job is enqueued
-- converting  : a worker has picked the job up
-- converted   : `markdown` holds the converted content
-- failed      : conversion exhausted its retries; `ingestion_error` says why
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS ingestion_status TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS markdown TEXT,
  ADD COLUMN IF NOT EXISTS ingestion_error TEXT,
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

ALTER TABLE document_versions
  DROP CONSTRAINT IF EXISTS document_versions_ingestion_status_check;

ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_ingestion_status_check
  CHECK (ingestion_status IN ('queued', 'converting', 'converted', 'failed'));
