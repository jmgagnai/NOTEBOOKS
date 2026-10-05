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

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
  }));
}
