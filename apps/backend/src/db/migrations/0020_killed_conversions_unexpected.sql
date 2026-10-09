-- NBK-112: a Docling conversion killed from outside — out of memory, its
-- container removed (NBK-111), Docker stopped — was recorded as
-- `unreadable`, which blames the file and offers no Retry (NBK-110). The
-- converter now records it as `unexpected`; this re-marks the ones already
-- recorded, recognised by the error the converter wrote for them. Every other
-- failure keeps its reason, and a second run finds nothing left to change.
UPDATE document_versions
SET failure_reason = 'unexpected'
WHERE ingestion_status = 'failed'
  AND failure_reason = 'unreadable'
  AND (
    ingestion_error LIKE 'Docling exited with code 137:%'
    OR ingestion_error LIKE 'Docling exited with code 143:%'
    OR ingestion_error LIKE 'Docling exited with signal %'
  );
