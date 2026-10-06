import type { Pool } from "pg";
import type {
  Document,
  DocumentContent,
  DocumentDetail,
  DocumentStatus,
  DocumentVersion,
} from "./schema.js";

/**
 * Exactly the columns a `Document` (as the API returns it) is built from — a
 * Document joined to its latest Version.
 *
 * Exported, with {@link toDocument}, because search (NBK-9) returns the same
 * shape out of a different query: a search result *is* a Document card plus
 * a score, so the two must not drift into two mappings of one row.
 */
export interface DocumentRow {
  id: string;
  notebook_id: string;
  filename: string;
  created_at: Date;
  version_id: string;
  version_number: number;
  mime_type: string;
  size_bytes: string;
  version_created_at: Date;
  ingestion_status: DocumentStatus;
  // Ingestion stage 2's output (NBK-7). Null until it has run.
  abstract: string | null;
}

interface DocumentWithLatestVersionRow extends DocumentRow {
  chat_snippet: string | null;
  executive_summary: string | null;
  metadata: Record<string, unknown> | null;
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
    v.created_at AS version_created_at,
    v.ingestion_status,
    v.abstract,
    v.chat_snippet,
    v.executive_summary,
    v.metadata
  FROM documents d
  JOIN LATERAL (
    SELECT id, version_number, mime_type, size_bytes, created_at, ingestion_status,
           abstract, chat_snippet, executive_summary, metadata
    FROM document_versions
    WHERE document_id = d.id AND deleted_at IS NULL
    ORDER BY version_number DESC
    LIMIT 1
  ) v ON true
`;

// Deliberately absent from this projection: `markdown`. The Converted
// Markdown can run past 200 pages, so it is never selected alongside a list
// of Documents — `findDocumentContent` fetches it for one Version on demand.

/** Maps one {@link DocumentRow} to the `Document` the API publishes. */
export function toDocument(row: DocumentRow): Document {
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
    status: row.ingestion_status,
    // The Abstract of the latest Version — the artifact GLOSSARY.md assigns
    // to document cards and search results.
    abstract: row.abstract,
    createdAt: row.created_at.toISOString(),
    latestVersion,
  };
}

function toDocumentDetail(row: DocumentWithLatestVersionRow): DocumentDetail {
  return {
    ...toDocument(row),
    metadata: row.metadata,
    chatSnippet: row.chat_snippet,
    executiveSummary: row.executive_summary,
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
 * One non-deleted Document with its latest Version's metadata and generated
 * artifacts (NBK-7) — what the UI shows when a Document is opened, before
 * the user expands to the full Converted Markdown. Per ADR-0001 there is no
 * ownership check. Returns `null` if no match (caller maps this to 404).
 */
export async function findDocumentDetail(
  pool: Pool,
  notebookId: string,
  documentId: string,
): Promise<DocumentDetail | null> {
  const { rows } = await pool.query<DocumentWithLatestVersionRow>(
    `${SELECT_DOCUMENTS_WITH_LATEST_VERSION} WHERE d.id = $1 AND d.notebook_id = $2 AND d.deleted_at IS NULL`,
    [documentId, notebookId],
  );
  return rows[0] ? toDocumentDetail(rows[0]) : null;
}

/**
 * The Converted Markdown of one specific Document Version.
 *
 * A separate query, and a separate endpoint, from the Document detail
 * because this is the payload that can run past 200 pages: a reader who
 * never expands past the Executive Summary never pays for it.
 *
 * Scoped to its Notebook and Document but, like `findDownloadableVersion`,
 * it does not require the parent Document to still be non-deleted — per
 * GLOSSARY.md a Citation keeps pointing at an older Version, and following
 * one has to be able to open it. Returns `null` if no match.
 */
export async function findDocumentContent(
  pool: Pool,
  notebookId: string,
  documentId: string,
  versionId: string,
): Promise<DocumentContent | null> {
  const { rows } = await pool.query<{ id: string; markdown: string | null }>(
    `SELECT v.id, v.markdown
     FROM document_versions v
     JOIN documents d ON d.id = v.document_id
     WHERE v.id = $1 AND v.document_id = $2 AND d.notebook_id = $3 AND v.deleted_at IS NULL`,
    [versionId, documentId, notebookId],
  );
  const row = rows[0];
  return row ? { versionId: row.id, markdown: row.markdown } : null;
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
 * What restoring a Document did, or why it couldn't.
 *
 * `filename-taken` exists because a Document's filename is unique among a
 * Notebook's *non-deleted* Documents (migration 0004) — that index is what
 * makes a re-upload find the existing Document instead of creating a sibling
 * (NBK-5). A Document that was deleted and whose filename has since been
 * re-uploaded therefore has nowhere to come back to, and the caller has to be
 * able to say so instead of surfacing a constraint violation.
 */
export type RestoreDocumentResult =
  | { outcome: "restored"; document: Document }
  | { outcome: "not-found" }
  | { outcome: "filename-taken"; filename: string };

/** Postgres' unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/**
 * Restores a soft-deleted Document (clears `deleted_at`). Per ADR-0001 there
 * is no ownership check.
 *
 * The collision is detected by letting the write fail rather than by looking
 * first: a check-then-update would still lose to an upload of the same
 * filename committing in between, and the unique index is the only thing that
 * can actually decide it.
 */
export async function restoreDocument(
  pool: Pool,
  notebookId: string,
  documentId: string,
): Promise<RestoreDocumentResult> {
  let restored: number | null;
  try {
    ({ rowCount: restored } = await pool.query(
      "UPDATE documents SET deleted_at = NULL WHERE id = $1 AND notebook_id = $2 AND deleted_at IS NOT NULL",
      [documentId, notebookId],
    ));
  } catch (err) {
    if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
    // The only unique constraint this statement can break is the one on
    // (notebook_id, filename) for non-deleted Documents.
    const { rows } = await pool.query<{ filename: string }>("SELECT filename FROM documents WHERE id = $1", [
      documentId,
    ]);
    return { outcome: "filename-taken", filename: rows[0]?.filename ?? "" };
  }

  if (restored !== 1) return { outcome: "not-found" };
  const document = await findDocumentWithLatestVersion(pool, notebookId, documentId);
  return document ? { outcome: "restored", document } : { outcome: "not-found" };
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
