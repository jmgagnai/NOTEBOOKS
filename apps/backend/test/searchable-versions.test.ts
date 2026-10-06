import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { SEARCHABLE_VERSIONS_CTE } from "../src/documents/searchable-versions.js";
import type { DocumentStatus } from "../src/documents/schema.js";

/**
 * The shared "which Document Versions may retrieval read" rule, tested on its
 * own against a real Postgres.
 *
 * It used to be written twice — NBK-9's search and NBK-12's chat retrieval had
 * independently derived it in two different SQL idioms — and NBK-13
 * consolidated it, because the rule holding *uniformly* is precisely what
 * NBK-13 is about. These tests are what make the shared definition
 * independently checkable; `test/versioning-integrity.test.ts` then proves it
 * end to end through both callers, and `test/search.route.test.ts` and
 * `test/chat.route.test.ts` keep covering it through theirs.
 *
 * The CTE is the module's interface (ADR-0003: raw SQL is the idiom here), so
 * that is what these tests drive — one `SELECT` over it, which is exactly how
 * both callers consume it.
 */
describe("searchable_versions", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  async function createNotebook(title: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO notebooks (title) VALUES ($1) RETURNING id",
      [title],
    );
    return rows[0].id;
  }

  async function createDocument(notebookId: string, filename: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO documents (notebook_id, filename) VALUES ($1, $2) RETURNING id",
      [notebookId, filename],
    );
    return rows[0].id;
  }

  async function addVersion(
    documentId: string,
    versionNumber: number,
    status: DocumentStatus,
    options: { deleted?: boolean; abstract?: string } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO document_versions
         (document_id, version_number, mime_type, size_bytes, storage_key,
          ingestion_status, abstract, chat_snippet, deleted_at)
       VALUES ($1, $2, 'text/markdown', 10, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        documentId,
        versionNumber,
        `${documentId}/${versionNumber}`,
        status,
        options.abstract ?? `Abstract of version ${versionNumber}`,
        `Chat Snippet of version ${versionNumber}`,
        options.deleted ? new Date() : null,
      ],
    );
    return rows[0].id;
  }

  interface Row {
    document_id: string;
    filename: string;
    version_id: string;
    version_number: number;
    ingestion_status: string;
    abstract: string | null;
    chat_snippet: string | null;
  }

  /** Runs the shared CTE for one Notebook, the way both callers do. */
  async function searchableVersions(notebookId: string): Promise<Row[]> {
    const { rows } = await pool.query<Row>(
      `WITH ${SEARCHABLE_VERSIONS_CTE}
       SELECT document_id, filename, version_id, version_number, ingestion_status, abstract, chat_snippet
       FROM searchable_versions
       ORDER BY filename`,
      [notebookId],
    );
    return rows;
  }

  it("picks each Document's latest Version and nothing older", async () => {
    const notebookId = await createNotebook("Latest only");
    const documentId = await createDocument(notebookId, "logistics.md");
    await addVersion(documentId, 1, "ready");
    await addVersion(documentId, 2, "ready");
    const v3 = await addVersion(documentId, 3, "ready");

    const rows = await searchableVersions(notebookId);

    // One row per Document, however many Versions it has.
    expect(rows).toHaveLength(1);
    expect(rows[0].version_id).toBe(v3);
    expect(rows[0].version_number).toBe(3);
    // Carrying the latest Version's own generated artifacts, not a previous
    // Version's — a search result shows the Abstract of what is current.
    expect(rows[0].abstract).toBe("Abstract of version 3");
    expect(rows[0].chat_snippet).toBe("Chat Snippet of version 3");
  });

  // The order of the two rules, which is the half that can go wrong silently.
  // Folding `ready` into choosing the Version would quietly answer from
  // Version 1 here — content the user has already replaced.
  it.each<DocumentStatus>(["queued", "converting", "converted", "summarizing", "summarized", "indexing", "failed"])(
    "excludes a Document whose latest Version is '%s', rather than falling back to a ready older one",
    async (status) => {
      const notebookId = await createNotebook(`Latest is ${status}`);
      const documentId = await createDocument(notebookId, "logistics.md");
      await addVersion(documentId, 1, "ready");
      await addVersion(documentId, 2, status);

      expect(await searchableVersions(notebookId)).toEqual([]);
    },
  );

  it("includes a Document whose only Version is ready", async () => {
    const notebookId = await createNotebook("Single ready version");
    const documentId = await createDocument(notebookId, "logistics.md");
    const v1 = await addVersion(documentId, 1, "ready");

    const rows = await searchableVersions(notebookId);

    expect(rows).toHaveLength(1);
    expect(rows[0].version_id).toBe(v1);
  });

  it("ignores a soft-deleted Version and uses the newest surviving one", async () => {
    const notebookId = await createNotebook("Deleted latest");
    const documentId = await createDocument(notebookId, "logistics.md");
    const v1 = await addVersion(documentId, 1, "ready");
    await addVersion(documentId, 2, "ready", { deleted: true });

    const rows = await searchableVersions(notebookId);

    expect(rows).toHaveLength(1);
    expect(rows[0].version_id).toBe(v1);
    expect(rows[0].version_number).toBe(1);
  });

  it("excludes a Document with no Versions at all", async () => {
    const notebookId = await createNotebook("No versions");
    await createDocument(notebookId, "logistics.md");

    expect(await searchableVersions(notebookId)).toEqual([]);
  });

  it("excludes a Document whose every Version is soft-deleted", async () => {
    const notebookId = await createNotebook("All versions deleted");
    const documentId = await createDocument(notebookId, "logistics.md");
    await addVersion(documentId, 1, "ready", { deleted: true });

    expect(await searchableVersions(notebookId)).toEqual([]);
  });

  it("excludes a soft-deleted Document", async () => {
    const notebookId = await createNotebook("Deleted document");
    const documentId = await createDocument(notebookId, "logistics.md");
    await addVersion(documentId, 1, "ready");
    await pool.query("UPDATE documents SET deleted_at = now() WHERE id = $1", [documentId]);

    expect(await searchableVersions(notebookId)).toEqual([]);
  });

  it("is scoped to one Notebook", async () => {
    const notebookId = await createNotebook("Mine");
    const mine = await createDocument(notebookId, "mine.md");
    await addVersion(mine, 1, "ready");

    const otherNotebookId = await createNotebook("Theirs");
    const theirs = await createDocument(otherNotebookId, "theirs.md");
    await addVersion(theirs, 1, "ready");

    expect((await searchableVersions(notebookId)).map((r) => r.filename)).toEqual(["mine.md"]);
    expect((await searchableVersions(otherNotebookId)).map((r) => r.filename)).toEqual(["theirs.md"]);
  });

  it("returns one row per Document in a Notebook holding several", async () => {
    const notebookId = await createNotebook("Several documents");
    const first = await createDocument(notebookId, "a.md");
    await addVersion(first, 1, "ready");
    const second = await createDocument(notebookId, "b.md");
    await addVersion(second, 1, "ready");
    const second2 = await addVersion(second, 2, "ready");
    // Not ready, so this third Document is absent while the other two stay.
    const third = await createDocument(notebookId, "c.md");
    await addVersion(third, 1, "indexing");

    const rows = await searchableVersions(notebookId);

    expect(rows.map((r) => r.filename)).toEqual(["a.md", "b.md"]);
    expect(rows.find((r) => r.filename === "b.md")!.version_id).toBe(second2);
  });
});
