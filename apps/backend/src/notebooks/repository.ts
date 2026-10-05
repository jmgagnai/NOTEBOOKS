import type { Pool } from "pg";
import type { Notebook } from "./schema.js";

interface NotebookRow {
  id: string;
  title: string;
  created_at: Date;
}

/**
 * Lists every non-deleted Notebook, oldest first. Raw SQL per ADR-0003.
 */
export async function listNotebooks(pool: Pool): Promise<Notebook[]> {
  const { rows } = await pool.query<NotebookRow>(
    "SELECT id, title, created_at FROM notebooks WHERE deleted_at IS NULL ORDER BY created_at ASC",
  );

  return rows.map(toNotebook);
}

function toNotebook(row: NotebookRow): Notebook {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
  };
}

/** Creates a new Notebook. Raw SQL per ADR-0003. */
export async function createNotebook(pool: Pool, title: string): Promise<Notebook> {
  const { rows } = await pool.query<NotebookRow>(
    "INSERT INTO notebooks (title) VALUES ($1) RETURNING id, title, created_at",
    [title],
  );
  return toNotebook(rows[0]);
}

/**
 * Renames a non-deleted Notebook. Per ADR-0001 there is no ownership check:
 * any authenticated user may rename any Notebook. Returns `null` if no
 * matching, non-deleted Notebook exists (caller maps this to 404).
 */
export async function renameNotebook(pool: Pool, id: string, title: string): Promise<Notebook | null> {
  const { rows } = await pool.query<NotebookRow>(
    "UPDATE notebooks SET title = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id, title, created_at",
    [id, title],
  );
  return rows[0] ? toNotebook(rows[0]) : null;
}

/**
 * Soft-deletes a Notebook (sets `deleted_at`). Per ADR-0001 there is no
 * ownership check. Returns `false` if no matching, non-deleted Notebook
 * exists (caller maps this to 404) — this also makes a second delete of an
 * already-deleted Notebook report not-found rather than succeeding again.
 */
export async function softDeleteNotebook(pool: Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "UPDATE notebooks SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
    [id],
  );
  return rowCount === 1;
}

/**
 * Restores a soft-deleted Notebook (clears `deleted_at`). Per ADR-0001
 * there is no ownership check. Returns `null` if no matching, currently
 * soft-deleted Notebook exists (caller maps this to 404) — restoring a
 * Notebook that isn't deleted is therefore not a no-op success.
 */
export async function restoreNotebook(pool: Pool, id: string): Promise<Notebook | null> {
  const { rows } = await pool.query<NotebookRow>(
    "UPDATE notebooks SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id, title, created_at",
    [id],
  );
  return rows[0] ? toNotebook(rows[0]) : null;
}
