-- Why a `failed` Document Version failed, in terms a user can act on (NBK-63,
-- NBK-64). `ingestion_error` stays the operator's full record — converter
-- diagnostics, setup hints, internal facts — and never leaves the backend;
-- these two columns are what the API publishes instead.
--
-- failure_reason : one of a closed set, decided by the Stage where it failed
--                  (see `IngestionFailure` in src/ingestion/stage.ts). The
--                  list mirrors `failureReasonSchema` in documents/schema.ts.
-- failed_at      : the status the Version was in when its Stage gave up.
--                  NULL for a failure recorded before this migration.
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS failed_at TEXT;

-- Failures recorded before this change were never classified, and their
-- stored text is not re-read to guess a reason (NBK-63, out of scope): they
-- report the honest fallback.
UPDATE document_versions
  SET failure_reason = 'unexpected'
  WHERE ingestion_status = 'failed' AND failure_reason IS NULL;

ALTER TABLE document_versions
  DROP CONSTRAINT IF EXISTS document_versions_failure_reason_check,
  DROP CONSTRAINT IF EXISTS document_versions_failed_at_check,
  DROP CONSTRAINT IF EXISTS document_versions_failure_only_when_failed;

ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_failure_reason_check
  CHECK (failure_reason IN (
    'no-text-layer', 'unreadable', 'timed-out', 'service-unavailable', 'unexpected'
  ));

ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_failed_at_check
  CHECK (failed_at IN ('converting', 'summarizing', 'indexing'));

-- A reason left behind on a Version that has since moved on would tell a user
-- about a failure that is no longer true. Every Stage clears both columns on
-- any other transition; this makes forgetting to a loud error instead of a
-- stale message.
ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_failure_only_when_failed
  CHECK (ingestion_status = 'failed' OR (failure_reason IS NULL AND failed_at IS NULL));
