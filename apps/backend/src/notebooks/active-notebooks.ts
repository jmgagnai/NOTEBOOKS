/**
 * The one definition of "this Notebook is still there".
 *
 * A Notebook is soft-deleted, never removed: NBK-4's story is that "a deleted
 * Notebook [is] recoverable, so that an accidental deletion doesn't lose the
 * team's documents and chat history", so `notebooks.deleted_at` is set and
 * every row the Notebook contains stays exactly where it was. That is the
 * point, and it is also the trap: the Documents and Chat Threads inside a
 * deleted Notebook are still perfectly valid rows, reachable by id, and a
 * query that only scopes itself to `notebook_id` will happily keep serving
 * them.
 *
 * Listing routes never had that problem, because they ask `notebookExists`
 * first and 404 before touching anything. Reading *one* Document or *one*
 * Chat Thread by id is where it bites: those queries resolve from the child
 * row, join up to `documents`/`chat_threads`, and historically stopped there
 * — so a caller holding a Document id or a Thread id could read a deleted
 * Notebook's contents straight back out. The rule belongs here, once, for the
 * same reason `documents/searchable-versions.ts` exists: it was independently
 * omitted in three different queries in two modules, which is three places
 * for it to drift and no place to read it.
 *
 * Note what this rule is *not*. It says nothing about `documents.deleted_at`
 * or `document_versions.deleted_at`. A soft-deleted *Document* deliberately
 * stays readable through a Citation ("even after newer Versions exist",
 * GLOSSARY.md), and `findDocumentContent` / `findDownloadableVersion` say so
 * in their own comments. A soft-deleted *Notebook* is a different claim: the
 * user deleted the container, so nothing inside it answers until they restore
 * it. Both rules apply at once — a Version inside a deleted Notebook is
 * unreachable however alive its own Document is.
 *
 * Raw SQL per ADR-0003.
 */

/**
 * A SQL predicate that holds only while the Notebook named by
 * `notebookIdExpression` is not soft-deleted.
 *
 * Takes an **expression**, not a value — a column reference like
 * `"d.notebook_id"`, or a placeholder like `"$1::uuid"` — because the three
 * callers reach the Notebook id three different ways and all of them need the
 * same test. It interpolates no caller data: every argument in the codebase
 * is a literal written next to the query it belongs to, and actual ids travel
 * as bound parameters as usual.
 *
 * Usable in a `WHERE` of either a `SELECT` or an `UPDATE`, which is why it is
 * a predicate rather than a `JOIN` fragment: the write paths (renaming a Chat
 * Thread) need the rule too, and a `JOIN` cannot be added to an `UPDATE ...
 * WHERE` without rewriting it.
 */
export function notebookIsActive(notebookIdExpression: string): string {
  return `EXISTS (
    SELECT 1 FROM notebooks active_nb
    WHERE active_nb.id = ${notebookIdExpression} AND active_nb.deleted_at IS NULL
  )`;
}
