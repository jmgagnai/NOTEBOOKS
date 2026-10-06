-- Document and Document Version (NBK-5). See GLOSSARY.md: a Document groups
-- its Versions; uploading a filename that already exists (undeleted) within
-- the same Notebook creates a new Version of the existing Document rather
-- than a new Document.
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notebook_id UUID NOT NULL REFERENCES notebooks (id),
  filename TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- Only one non-deleted Document per (notebook, filename): re-uploading an
-- existing, undeleted filename must find this row rather than create a
-- sibling Document.
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_notebook_filename_active
  ON documents (notebook_id, filename)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_notebook_active
  ON documents (notebook_id, created_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents (id),
  version_number INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Required by NBK-5, whose acceptance criteria name `documents` and
  -- `document_versions` as "both soft-deletable". **Currently dormant**: no
  -- application code sets it, because the product deletes Notebooks and
  -- Documents, never an individual Version.
  --
  -- It is not dead weight, and it is not speculative generality. Every read
  -- path honours it today — `searchable-versions.ts`, `findDocumentContent`,
  -- `findDownloadableVersion`, `findDocumentVersionDetail`, and the three
  -- ingestion Stages — so the behaviour a "delete this Version" feature needs
  -- already exists and is already tested
  -- (`test/searchable-versions.test.ts` covers the "deleted latest Version
  -- falls back to the newest surviving one" branch at the SQL level, which is
  -- the only level it can be driven from). Removing the column would mean
  -- removing that filter from eight queries and putting it back later, which
  -- is the expensive direction. See `docs/versioning.md`, "Not reachable
  -- today".
  deleted_at TIMESTAMPTZ,
  UNIQUE (document_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_document_versions_document_active
  ON document_versions (document_id, version_number)
  WHERE deleted_at IS NULL;
