-- Supports the notebook CRUD routes added in NBK-4: every list/rename/delete
-- query filters (or excludes) non-deleted Notebooks, so index the active
-- subset rather than the whole table.
CREATE INDEX IF NOT EXISTS idx_notebooks_active ON notebooks (created_at) WHERE deleted_at IS NULL;
