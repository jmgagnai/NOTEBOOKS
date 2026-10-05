import type { Pool } from "pg";
import type { Document, DocumentVersion } from "./schema.js";

interface DocumentWithLatestVersionRow {
  id: string;
  notebook_id: string;
  filename: string;
  created_at: Date;
  version_id: string;
  version_number: number;
  mime_type: string;
  size_bytes: string;
  version_created_at: Date;
}

// Joins each Document to its latest (highest version_number, non-deleted)
// Version. Per GLOSSARY.md, only a Document's latest Version is searched in
// chat, so it's the only one the API surfaces alongside the Document itself.
const SELECT_DOCUMENTS_WITH_LATEST_VERSION = `
  SELECT
    d.id,
    d.notebook_id,
    d.filename,
    d.created_at,
    v.id AS version_id,
    v.version_number,
    v.mime_type,
    v.size_bytes,
    v.created_at AS version_created_at
  FROM documents d
  JOIN LATERAL (
    SELECT id, version_number, mime_type, size_bytes, created_at
    FROM document_versions
    WHERE document_id = d.id AND deleted_at IS NULL
    ORDER BY version_number DESC
    LIMIT 1
  ) v ON true
`;

function toDocument(row: DocumentWithLatestVersionRow): Document {
  const latestVersion: DocumentVersion = {
    id: row.version_id,
    versionNumber: row.version_number,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.version_created_at.toISOString(),
  };
  return {
    id: row.id,
    notebookId: row.notebook_id,
    filename: row.filename,
    status: "uploaded",
    createdAt: row.created_at.toISOString(),
    latestVersion,
  };
}

/** Whether a non-deleted Notebook with this id exists. */
export async function notebookExists(pool: Pool, notebookId: string): Promise<boolean> {
  const { rows } = await pool.query("SELECT 1 FROM notebooks WHERE id = $1 AND deleted_at IS NULL", [
    notebookId,
  ]);
  return rows.length === 1;
}

/**
 * Lists every non-deleted Document in a Notebook, oldest first, each paired
 * with its latest Version. Per ADR-0001 there is no ownership check.
 */
export async function listDocuments(pool: Pool, notebookId: string): Promise<Document[]> {
  const { rows } = await pool.query<DocumentWithLatestVersionRow>(
    `${SELECT_DOCUMENTS_WITH_LATEST_VERSION} WHERE d.notebook_id = $1 AND d.deleted_at IS NULL ORDER BY d.created_at ASC`,
    [notebookId],
  );
  return rows.map(toDocument);
}

async function findDocumentWithLatestVersion(
  pool: Pool,
  notebookId: string,
  documentId: string,
): Promise<Document | null> {
  const { rows } = await pool.query<DocumentWithLatestVersionRow>(
    `${SELECT_DOCUMENTS_WITH_LATEST_VERSION} WHERE d.id = $1 AND d.notebook_id = $2`,
    [documentId, notebookId],
  );
  return rows[0] ? toDocument(rows[0]) : null;
}

/**
 * Stores a new upload as a Document Version. Per GLOSSARY.md and NBK-5: if a
 * non-deleted Document with this exact filename already exists in the
 * Notebook, this adds a new Version to it (version_number incremented)
 * instead of creating a new Document. The row lock taken on an existing
 * Document while the transaction computes the next version_number serializes
 * concurrent uploads of the same filename.
 */
export async function createDocumentVersion(
  pool: Pool,
  notebookId: string,
  filename: string,
  mimeType: string,
  sizeBytes: number,
  storageKey: string,
): Promise<Document> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query<{ id: string }>(
      "SELECT id FROM documents WHERE notebook_id = $1 AND filename = $2 AND deleted_at IS NULL FOR UPDATE",
      [notebookId, filename],
    );

    let documentId: string;
    if (existing.rows[0]) {
      documentId = existing.rows[0].id;
    } else {
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO documents (notebook_id, filename) VALUES ($1, $2) RETURNING id",
        [notebookId, filename],
      );
      documentId = inserted.rows[0].id;
    }

    const { rows: versionRows } = await client.query<{ max_version: number | null }>(
      "SELECT MAX(version_number) AS max_version FROM document_versions WHERE document_id = $1",
      [documentId],
    );
    const nextVersion = (versionRows[0].max_version ?? 0) + 1;

    await client.query(
      `INSERT INTO document_versions (document_id, version_number, mime_type, size_bytes, storage_key)
       VALUES ($1, $2, $3, $4, $5)`,
      [documentId, nextVersion, mimeType, sizeBytes, storageKey],
    );

    await client.query("COMMIT");
    const document = await findDocumentWithLatestVersion(pool, notebookId, documentId);
    if (!document) {
      throw new Error("Document vanished immediately after its Version was committed.");
    }
    return document;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Soft-deletes a Document (sets `deleted_at`). Per ADR-0001 there is no
 * ownership check. Returns `false` if no matching, non-deleted Document
 * exists in this Notebook (caller maps this to 404).
 */
export async function softDeleteDocument(pool: Pool, notebookId: string, documentId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "UPDATE documents SET deleted_at = now() WHERE id = $1 AND notebook_id = $2 AND deleted_at IS NULL",
    [documentId, notebookId],
  );
  return rowCount === 1;
}

/**
 * Restores a soft-deleted Document (clears `deleted_at`). Per ADR-0001 there
 * is no ownership check. Returns `null` if no matching, currently
 * soft-deleted Document exists in this Notebook (caller maps this to 404).
 */
export async function restoreDocument(pool: Pool, notebookId: string, documentId: string): Promise<Document | null> {
  const { rowCount } = await pool.query(
    "UPDATE documents SET deleted_at = NULL WHERE id = $1 AND notebook_id = $2 AND deleted_at IS NOT NULL",
    [documentId, notebookId],
  );
  if (rowCount !== 1) return null;
  return findDocumentWithLatestVersion(pool, notebookId, documentId);
}

export interface DownloadableVersion {
  storageKey: string;
  mimeType: string;
  filename: string;
}

/**
 * Looks up a specific Document Version for download, scoped to its Notebook
 * and Document. Per GLOSSARY.md, Citations keep pointing at older Versions
 * even after newer ones exist, so this deliberately doesn't require the
 * parent Document to still be non-deleted — only the Version itself must not
 * be deleted. Returns `null` if no match (caller maps this to 404).
 */
export async function findDownloadableVersion(
  pool: Pool,
  notebookId: string,
  documentId: string,
  versionId: string,
): Promise<DownloadableVersion | null> {
  const { rows } = await pool.query<{ storage_key: string; mime_type: string; filename: string }>(
    `SELECT v.storage_key, v.mime_type, d.filename
     FROM document_versions v
     JOIN documents d ON d.id = v.document_id
     WHERE v.id = $1 AND v.document_id = $2 AND d.notebook_id = $3 AND v.deleted_at IS NULL`,
    [versionId, documentId, notebookId],
  );
  const row = rows[0];
  return row ? { storageKey: row.storage_key, mimeType: row.mime_type, filename: row.filename } : null;
}
