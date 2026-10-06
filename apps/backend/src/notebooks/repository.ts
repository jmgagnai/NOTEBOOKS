import type { Pool } from 'pg';
import { notebookIsActive } from './active-notebooks.js';
import type { Notebook } from './schema.js';

interface NotebookRow {
  id: string;
  title: string;
  created_at: Date;
}

/**
 * Whether a non-deleted Notebook with this id exists — what every route
 * nested under a Notebook asks before it does anything, so a request against
 * a Notebook that is gone answers 404 rather than an empty success.
 *
 * Lives here, with the Notebooks it is about, rather than in
 * `documents/repository.ts` where it started: Documents, Chat Threads and
 * search all ask it, and none of them is where the answer comes from. It is
 * the same rule as `notebookIsActive`, which is why it is written in terms of
 * it instead of repeating the `deleted_at` test.
 */
export async function notebookExists(pool: Pool, notebookId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 WHERE ${notebookIsActive('$1::uuid')}`, [notebookId]);
  return rows.length === 1;
}

/**
 * Lists every non-deleted Notebook, oldest first. Raw SQL per ADR-0003.
 */
export async function listNotebooks(pool: Pool): Promise<Notebook[]> {
  const { rows } = await pool.query<NotebookRow>(
    'SELECT id, title, created_at FROM notebooks WHERE deleted_at IS NULL ORDER BY created_at ASC',
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
    'INSERT INTO notebooks (title) VALUES ($1) RETURNING id, title, created_at',
    [title],
  );
  return toNotebook(rows[0]);
}

/**
 * Renames a non-deleted Notebook. Per ADR-0001 there is no ownership check:
 * any authenticated user may rename any Notebook. Returns `null` if no
 * matching, non-deleted Notebook exists (caller maps this to 404).
 */
export async function renameNotebook(
  pool: Pool,
  id: string,
  title: string,
): Promise<Notebook | null> {
  const { rows } = await pool.query<NotebookRow>(
    'UPDATE notebooks SET title = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id, title, created_at',
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
    'UPDATE notebooks SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
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
    'UPDATE notebooks SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id, title, created_at',
    [id],
  );
  return rows[0] ? toNotebook(rows[0]) : null;
}
