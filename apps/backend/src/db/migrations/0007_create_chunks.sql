-- Ingestion stage 3 (NBK-8): the Converted Markdown of a Document Version,
-- split into chunks and embedded, which is what makes the Version searchable.
--
-- `infra/postgres/init/001-pgvector.sql` already enables pgvector on a real
-- deployment; this is here so the migration is self-sufficient against a bare
-- Postgres (every test spins one up). `IF NOT EXISTS` is a no-op — and needs
-- no superuser — wherever the init script has already run.
CREATE EXTENSION IF NOT EXISTS vector;

--
-- `vector(2560)` is not a guess. NBK-1 requires the dimension be "fixed to
-- whatever dimension this model's OpenRouter listing reports, confirmed
-- before the schema migration is written", and OpenRouter's embeddings
-- catalogue (GET /api/v1/embeddings/models) does not publish a dimension
-- field for qwen/qwen3-embedding-4b at all. So it was confirmed the only way
-- left: by calling POST /api/v1/embeddings for real and measuring the vector
-- that came back. It is 2560 — Qwen3-Embedding-4B's full hidden size.
--
-- A changed embedding model means re-embedding every row here, which per
-- ADR-0002 is "a real migration, not a config change" — and this column's
-- width is exactly why.
CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id UUID NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
  -- Position in the document, 0-based. Ordering is part of a chunk's identity:
  -- a Citation points at one chunk, and a reader following it expects the
  -- passage that was actually cited.
  chunk_index INTEGER NOT NULL,
  -- The enclosing Markdown headings, outermost first (["Annual Report",
  -- "Risks"]). TEXT[] rather than a joined string because it is a path, and
  -- per GLOSSARY.md a Citation has to be able to say *where* in a Document
  -- Version it points.
  heading_path TEXT[] NOT NULL DEFAULT '{}',
  text TEXT NOT NULL,
  embedding vector(2560) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Stage 3 is independently retryable (ADR-0004), so a retry re-chunks the
  -- same Version from scratch. This makes a half-written retry impossible to
  -- mistake for extra content, and makes "replace this Version's chunks"
  -- expressible as a delete plus an insert.
  UNIQUE (document_version_id, chunk_index)
);

-- Retrieval is always scoped to a Document Version (and, through it, to a
-- Notebook's latest Versions), so this is the index every read starts from.
CREATE INDEX IF NOT EXISTS idx_chunks_document_version
  ON chunks (document_version_id, chunk_index);

-- Deliberately NO ivfflat/HNSW index on `embedding`: pgvector caps both at
-- 2000 dimensions and these vectors are 2560, so neither can be built on
-- this column. Similarity search is therefore an exact scan within one
-- Notebook's chunks, which is correct and fast enough at this scale.
-- Indexing it later means storing a `halfvec(2560)` alongside (HNSW allows
-- 4000 half-precision dimensions) or reducing the dimension — either way a
-- decision for the retrieval ticket, with real data to measure, not a guess
-- made here.
--
-- RESOLVED by NBK-9: it stays exact. Measured on a realistic corpus, an HNSW
-- index on a duplicated halfvec column cannot even serve the query search
-- actually runs (a MIN()/GROUP BY roll-up per Document, not ORDER BY ...
-- LIMIT k), and the exact scan is a fraction of the OpenRouter round trip
-- that embeds the query. See docs/adr/0005-exact-vector-scan-over-ann-index.md
-- and the measurement in docs/search.md.

-- Stage 3 extends the same status progression as stages 1 and 2 (see the 0005
-- and 0006 comments) rather than adding a parallel field. A Version stage 2
-- left "summarized" is picked up as "indexing" and ends "ready".
--
-- "indexing" is GLOSSARY.md's own word for this: it tells the reader to
-- "reserve 'indexing' for the embedding/retrieval stage specifically".
-- "ready" is terminal for the pipeline — it is what NBK-8 requires and what
-- tells a user the Document "is safe to rely on for chat".
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

ALTER TABLE document_versions
  DROP CONSTRAINT IF EXISTS document_versions_ingestion_status_check;

ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_ingestion_status_check
  CHECK (ingestion_status IN (
    'queued', 'converting', 'converted', 'summarizing', 'summarized', 'indexing', 'ready', 'failed'
  ));
