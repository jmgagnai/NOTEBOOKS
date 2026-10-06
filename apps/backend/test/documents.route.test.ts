import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedTestContainer } from "testcontainers";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import type { ConvertToMarkdownPayload } from "../src/ingestion/convert-to-markdown.js";
import type { JobQueue } from "../src/jobs/queue.js";
import { createS3Client, ensureBucket, type S3Config } from "../src/storage/s3-client.js";
import { startMinio } from "./support/minio-container.js";

const DOCUMENTS_BUCKET = "rag-notebook-documents-test";

// Seam-1 test (per NBK-1's testing decisions, and explicitly called for by
// NBK-5's acceptance criteria): drive the real Fastify app through
// app.inject() against a real Postgres container AND a real MinIO container
// (bitnamilegacy/minio, matching the root docker-compose.yml — see
// test/support/minio-container.ts for why).
describe("Document routes", () => {
  let pgContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedTestContainer;
  let pool: Pool;
  let app: FastifyInstance;
  // Kept so the NBK-6 hand-off tests below can build a second app, with a
  // JobQueue stub, against the same containers.
  let s3Config: S3Config;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = createPool(pgContainer.getConnectionUri());
    await runMigrations(pool);

    const minio = await startMinio();
    minioContainer = minio.container;
    s3Config = {
      endpoint: minio.endpoint,
      accessKeyId: minio.accessKeyId,
      secretAccessKey: minio.secretAccessKey,
    };
    const s3 = createS3Client(s3Config);
    await ensureBucket(s3, DOCUMENTS_BUCKET);

    app = await buildApp({ pool, s3, documentsBucket: DOCUMENTS_BUCKET });
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await minioContainer.stop();
    await pgContainer.stop();
  });

  /** Registers a fresh user and logs in, returning their session cookie value. */
  async function loginAsNewUser(email: string): Promise<string> {
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "correct-horse-battery-staple" },
    });
    const loginResponse = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "correct-horse-battery-staple" },
    });
    return loginResponse.cookies.find((c) => c.name === "session")!.value;
  }

  async function createNotebook(session: string, title: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/notebooks",
      cookies: { session },
      payload: { title },
    });
    return (response.json() as { id: string }).id;
  }

  /** Builds a `multipart/form-data` payload containing a single file field. */
  function multipartUpload(filename: string, content: string): { payload: Buffer; contentType: string } {
    const boundary = "----nbk5TestBoundary";
    const payload = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n` +
        `${content}\r\n` +
        `--${boundary}--\r\n`,
    );
    return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  async function uploadFile(session: string, notebookId: string, filename: string, content: string) {
    const { payload, contentType } = multipartUpload(filename, content);
    return app.inject({
      method: "POST",
      url: `/notebooks/${notebookId}/documents`,
      cookies: { session },
      headers: { "content-type": contentType },
      payload,
    });
  }

  describe("GET /notebooks/:notebookId/documents", () => {
    it("rejects an unauthenticated request with 401", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/notebooks/00000000-0000-0000-0000-000000000000/documents",
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns 404 for a Notebook that doesn't exist", async () => {
      const session = await loginAsNewUser("lister1@example.com");

      const response = await app.inject({
        method: "GET",
        url: "/notebooks/00000000-0000-0000-0000-000000000000/documents",
        cookies: { session },
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns an empty list for a Notebook with no Documents", async () => {
      const session = await loginAsNewUser("lister2@example.com");
      const notebookId = await createNotebook(session, "Empty Notebook");

      const response = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });
  });

  describe("POST /notebooks/:notebookId/documents (upload)", () => {
    it("rejects an unauthenticated request with 401", async () => {
      const { payload, contentType } = multipartUpload("a.txt", "hello");
      const response = await app.inject({
        method: "POST",
        url: "/notebooks/00000000-0000-0000-0000-000000000000/documents",
        headers: { "content-type": contentType },
        payload,
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns 404 for a Notebook that doesn't exist", async () => {
      const session = await loginAsNewUser("uploader1@example.com");
      const response = await uploadFile(session, "00000000-0000-0000-0000-000000000000", "a.txt", "hello");

      expect(response.statusCode).toBe(404);
    });

    it("uploads a text file, creating a Document with version 1 awaiting conversion", async () => {
      const session = await loginAsNewUser("uploader2@example.com");
      const notebookId = await createNotebook(session, "Research");

      const response = await uploadFile(session, notebookId, "report.txt", "the contents");

      expect(response.statusCode).toBe(201);
      const body = response.json() as {
        id: string;
        notebookId: string;
        filename: string;
        status: string;
        latestVersion: { versionNumber: number; mimeType: string; sizeBytes: number };
      };
      expect(body.filename).toBe("report.txt");
      expect(body.notebookId).toBe(notebookId);
      // NBK-6: an upload is immediately enqueued for Markdown conversion,
      // so the Document Version starts out "queued" rather than terminal.
      expect(body.status).toBe("queued");
      expect(body.latestVersion.versionNumber).toBe(1);
      expect(body.latestVersion.mimeType).toBe("text/plain");
      expect(body.latestVersion.sizeBytes).toBe(Buffer.byteLength("the contents"));

      const listResponse = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents`,
        cookies: { session },
      });
      expect((listResponse.json() as Array<{ filename: string }>).map((d) => d.filename)).toContain(
        "report.txt",
      );
    });

    it.each([
      ["memo.txt", "text/plain"],
      ["notes.md", "text/markdown"],
      ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["data.csv", "text/csv"],
      ["scan.pdf", "application/pdf"],
    ])("accepts %s, recording mimeType %s", async (filename, expectedMimeType) => {
      const session = await loginAsNewUser(`accepted-${filename}@example.com`);
      const notebookId = await createNotebook(session, `Accepted ${filename}`);

      const response = await uploadFile(session, notebookId, filename, "whatever bytes");

      expect(response.statusCode).toBe(201);
      const body = response.json() as { latestVersion: { mimeType: string } };
      expect(body.latestVersion.mimeType).toBe(expectedMimeType);
    });

    it.each([["script.exe"], ["archive.zip"], ["noextension"]])(
      "rejects an unsupported file type (%s) with 400",
      async (filename) => {
        const session = await loginAsNewUser(`rejector-${filename}@example.com`);
        const notebookId = await createNotebook(session, "Rejections");

        const response = await uploadFile(session, notebookId, filename, "whatever");

        expect(response.statusCode).toBe(400);
        expect((response.json() as { message: string }).message).toMatch(/Unsupported file type/i);
      },
    );

    it("re-uploading an existing, undeleted filename creates a new Version on the same Document instead of a new one", async () => {
      const session = await loginAsNewUser("versioner1@example.com");
      const notebookId = await createNotebook(session, "Versioned Notebook");

      const firstUpload = await uploadFile(session, notebookId, "contract.pdf", "v1 bytes");
      const firstBody = firstUpload.json() as { id: string; latestVersion: { versionNumber: number } };
      expect(firstBody.latestVersion.versionNumber).toBe(1);

      const secondUpload = await uploadFile(session, notebookId, "contract.pdf", "v2 bytes, longer");
      const secondBody = secondUpload.json() as {
        id: string;
        latestVersion: { versionNumber: number; sizeBytes: number };
      };

      expect(secondUpload.statusCode).toBe(201);
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.latestVersion.versionNumber).toBe(2);
      expect(secondBody.latestVersion.sizeBytes).toBe(Buffer.byteLength("v2 bytes, longer"));

      const listResponse = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents`,
        cookies: { session },
      });
      const documents = listResponse.json() as Array<{ filename: string }>;
      expect(documents.filter((d) => d.filename === "contract.pdf")).toHaveLength(1);
    });
  });

  describe("GET .../versions/:versionId/download", () => {
    it("rejects an unauthenticated request with 401", async () => {
      const response = await app.inject({
        method: "GET",
        url:
          "/notebooks/00000000-0000-0000-0000-000000000000/documents/00000000-0000-0000-0000-000000000000/versions/00000000-0000-0000-0000-000000000000/download",
      });

      expect(response.statusCode).toBe(401);
    });

    it("streams back the exact bytes uploaded for a Document Version", async () => {
      const session = await loginAsNewUser("downloader1@example.com");
      const notebookId = await createNotebook(session, "Download Notebook");
      const uploadResponse = await uploadFile(session, notebookId, "notes.md", "# Heading\n\nBody text.");
      const { id: documentId, latestVersion } = uploadResponse.json() as {
        id: string;
        latestVersion: { id: string };
      };

      const response = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents/${documentId}/versions/${latestVersion.id}/download`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("# Heading\n\nBody text.");
      expect(response.headers["content-type"]).toBe("text/markdown");
    });

    it("returns 404 for a Version that doesn't exist", async () => {
      const session = await loginAsNewUser("downloader2@example.com");
      const notebookId = await createNotebook(session, "Download Notebook 2");
      const uploadResponse = await uploadFile(session, notebookId, "notes2.md", "content");
      const { id: documentId } = uploadResponse.json() as { id: string };

      const response = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents/${documentId}/versions/00000000-0000-0000-0000-000000000000/download`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("DELETE /notebooks/:notebookId/documents/:documentId", () => {
    it("rejects an unauthenticated request with 401", async () => {
      const response = await app.inject({
        method: "DELETE",
        url:
          "/notebooks/00000000-0000-0000-0000-000000000000/documents/00000000-0000-0000-0000-000000000000",
      });

      expect(response.statusCode).toBe(401);
    });

    it("soft-deletes a Document, removing it from the list", async () => {
      const session = await loginAsNewUser("deleter1@example.com");
      const notebookId = await createNotebook(session, "Delete Notebook");
      const uploadResponse = await uploadFile(session, notebookId, "todelete.csv", "a,b,c");
      const { id: documentId } = uploadResponse.json() as { id: string };

      const response = await app.inject({
        method: "DELETE",
        url: `/notebooks/${notebookId}/documents/${documentId}`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(204);

      const listResponse = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents`,
        cookies: { session },
      });
      expect((listResponse.json() as Array<{ filename: string }>).map((d) => d.filename)).not.toContain(
        "todelete.csv",
      );
    });

    it("returns 404 when deleting a Document that's already deleted", async () => {
      const session = await loginAsNewUser("deleter2@example.com");
      const notebookId = await createNotebook(session, "Delete Notebook 2");
      const uploadResponse = await uploadFile(session, notebookId, "twice.csv", "x");
      const { id: documentId } = uploadResponse.json() as { id: string };
      await app.inject({
        method: "DELETE",
        url: `/notebooks/${notebookId}/documents/${documentId}`,
        cookies: { session },
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/notebooks/${notebookId}/documents/${documentId}`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(404);
    });

    it("re-uploading the same filename after its Document was deleted creates a brand-new Document", async () => {
      const session = await loginAsNewUser("deleter3@example.com");
      const notebookId = await createNotebook(session, "Delete Notebook 3");
      const firstUpload = await uploadFile(session, notebookId, "reused.txt", "first");
      const { id: firstDocumentId } = firstUpload.json() as { id: string };
      await app.inject({
        method: "DELETE",
        url: `/notebooks/${notebookId}/documents/${firstDocumentId}`,
        cookies: { session },
      });

      const secondUpload = await uploadFile(session, notebookId, "reused.txt", "second");
      const secondBody = secondUpload.json() as { id: string; latestVersion: { versionNumber: number } };

      expect(secondUpload.statusCode).toBe(201);
      expect(secondBody.id).not.toBe(firstDocumentId);
      expect(secondBody.latestVersion.versionNumber).toBe(1);
    });
  });

  describe("POST /notebooks/:notebookId/documents/:documentId/restore", () => {
    it("rejects an unauthenticated request with 401", async () => {
      const response = await app.inject({
        method: "POST",
        url:
          "/notebooks/00000000-0000-0000-0000-000000000000/documents/00000000-0000-0000-0000-000000000000/restore",
      });

      expect(response.statusCode).toBe(401);
    });

    it("restores a soft-deleted Document so it reappears in the list", async () => {
      const session = await loginAsNewUser("restorer1@example.com");
      const notebookId = await createNotebook(session, "Restore Notebook");
      const uploadResponse = await uploadFile(session, notebookId, "restorable.txt", "data");
      const { id: documentId } = uploadResponse.json() as { id: string };
      await app.inject({
        method: "DELETE",
        url: `/notebooks/${notebookId}/documents/${documentId}`,
        cookies: { session },
      });

      const response = await app.inject({
        method: "POST",
        url: `/notebooks/${notebookId}/documents/${documentId}/restore`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { filename: string }).filename).toBe("restorable.txt");

      const listResponse = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents`,
        cookies: { session },
      });
      expect((listResponse.json() as Array<{ filename: string }>).map((d) => d.filename)).toContain(
        "restorable.txt",
      );
    });

    it("returns 404 when restoring a Document that isn't deleted", async () => {
      const session = await loginAsNewUser("restorer2@example.com");
      const notebookId = await createNotebook(session, "Restore Notebook 2");
      const uploadResponse = await uploadFile(session, notebookId, "never-deleted.txt", "data");
      const { id: documentId } = uploadResponse.json() as { id: string };

      const response = await app.inject({
        method: "POST",
        url: `/notebooks/${notebookId}/documents/${documentId}/restore`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(404);
    });

    // Found while verifying NBK-13's versioning guarantee end to end.
    // Filename-collision versioning only groups *non-deleted* Documents, so a
    // re-upload after a delete starts a new Document rather than a new
    // Version — and that leaves the deleted one with nowhere to come back to,
    // because a Notebook can hold only one non-deleted Document per filename.
    // That has to read as a conflict the user can resolve, not as a 500.
    it("returns 409 when the filename was re-uploaded while the Document was deleted", async () => {
      const session = await loginAsNewUser("restorer3@example.com");
      const notebookId = await createNotebook(session, "Restore Notebook 3");
      const first = await uploadFile(session, notebookId, "contested.txt", "first");
      const { id: documentId } = first.json() as { id: string };
      await app.inject({
        method: "DELETE",
        url: `/notebooks/${notebookId}/documents/${documentId}`,
        cookies: { session },
      });

      // With the original deleted, this is a new Document at Version 1 —
      // not a new Version of the deleted one.
      const second = await uploadFile(session, notebookId, "contested.txt", "second");
      const replacement = second.json() as { id: string; latestVersion: { versionNumber: number } };
      expect(replacement.id).not.toBe(documentId);
      expect(replacement.latestVersion.versionNumber).toBe(1);

      const response = await app.inject({
        method: "POST",
        url: `/notebooks/${notebookId}/documents/${documentId}/restore`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(409);
      expect((response.json() as { message: string }).message).toContain("contested.txt");

      // And the Notebook is left as it was: the replacement alone, with the
      // deleted Document still deleted rather than half-restored.
      const listed = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents`,
        cookies: { session },
      });
      expect((listed.json() as Array<{ id: string }>).map((d) => d.id)).toEqual([replacement.id]);
    });

    // The conflict is about the *current* contents, so clearing them makes
    // the restore possible again — which is what the 409's message tells the
    // user to do.
    it("restores after the colliding Document is itself deleted", async () => {
      const session = await loginAsNewUser("restorer4@example.com");
      const notebookId = await createNotebook(session, "Restore Notebook 4");
      const first = await uploadFile(session, notebookId, "handover.txt", "first");
      const { id: documentId } = first.json() as { id: string };
      await app.inject({
        method: "DELETE",
        url: `/notebooks/${notebookId}/documents/${documentId}`,
        cookies: { session },
      });
      const second = await uploadFile(session, notebookId, "handover.txt", "second");
      const { id: replacementId } = second.json() as { id: string };
      await app.inject({
        method: "DELETE",
        url: `/notebooks/${notebookId}/documents/${replacementId}`,
        cookies: { session },
      });

      const response = await app.inject({
        method: "POST",
        url: `/notebooks/${notebookId}/documents/${documentId}/restore`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { id: string }).id).toBe(documentId);
    });
  });

  // NBK-6: an upload is the ingestion pipeline's trigger. Only the hand-off
  // is asserted here — that the job then converts anything belongs to
  // test/convert-to-markdown.job.test.ts and test/job-queue.test.ts.
  describe("ingestion hand-off", () => {
    /** Builds a second app, sharing these containers, with a JobQueue stub. */
    async function appWith(jobs: JobQueue): Promise<FastifyInstance> {
      return buildApp({
        pool,
        s3: createS3Client(s3Config),
        documentsBucket: DOCUMENTS_BUCKET,
        jobs,
      });
    }

    it("enqueues Markdown conversion for the Version it just created", async () => {
      const enqueued: ConvertToMarkdownPayload[] = [];
      const appWithJobs = await appWith({
        enqueueConvertToMarkdown: async (payload) => {
          enqueued.push(payload);
        },
        stop: async () => {},
      });
      try {
        const session = await loginAsNewUser("ingestion-handoff@example.com");
        const notebookId = await createNotebook(session, "Ingestion");

        const { payload, contentType } = multipartUpload("pipeline.txt", "convert me");
        const response = await appWithJobs.inject({
          method: "POST",
          url: `/notebooks/${notebookId}/documents`,
          cookies: { session },
          headers: { "content-type": contentType },
          payload,
        });

        expect(response.statusCode).toBe(201);
        const body = response.json() as { id: string; status: string; latestVersion: { id: string } };
        expect(body.status).toBe("queued");
        expect(enqueued).toEqual([{ documentId: body.id, versionId: body.latestVersion.id }]);
      } finally {
        await appWithJobs.close();
      }
    });

    it("still stores the upload when enqueueing the job fails", async () => {
      const appWithJobs = await appWith({
        enqueueConvertToMarkdown: async () => {
          throw new Error("pg_boss is down");
        },
        stop: async () => {},
      });
      try {
        const session = await loginAsNewUser("ingestion-enqueue-fails@example.com");
        const notebookId = await createNotebook(session, "Ingestion failure");

        const { payload, contentType } = multipartUpload("orphan.txt", "stored anyway");
        const response = await appWithJobs.inject({
          method: "POST",
          url: `/notebooks/${notebookId}/documents`,
          cookies: { session },
          headers: { "content-type": contentType },
          payload,
        });

        // The bytes are already in object storage by the time the enqueue is
        // attempted, so failing the request would strand them. The Version
        // stays "queued" — the standing record of work still owed.
        expect(response.statusCode).toBe(201);
        expect((response.json() as { status: string }).status).toBe("queued");
      } finally {
        await appWithJobs.close();
      }
    });
  });

  // The read side of ingestion stage 2 (NBK-7). The three Generated document
  // artifacts have three different consumers, and the API splits along
  // exactly those lines (see GLOSSARY.md):
  //
  //   Abstract          -> the Document list, for cards and search results
  //   Executive Summary -> the Document detail, shown when one is opened
  //   Converted Markdown -> its own endpoint, fetched only on expand
  //
  // Not one fat payload, because the Converted Markdown can run past 200
  // pages: putting it on the list would make browsing a Notebook download
  // every document in it.
  describe("NBK-7: reading metadata and the generated artifacts", () => {
    /** Writes stage 2's output onto a Version, as the job would. */
    async function seedSummaries(versionId: string): Promise<void> {
      await pool.query(
        `UPDATE document_versions
         SET ingestion_status = 'summarized',
             markdown = $2,
             metadata = $3::jsonb,
             chat_snippet = $4,
             executive_summary = $5,
             abstract = $6,
             summarized_at = now()
         WHERE id = $1`,
        [
          versionId,
          "# Quarterly Report\n\n## Revenue\n\n| Quarter | Total |\n| --- | --- |\n| Q1 | 12.4M |\n",
          JSON.stringify({ title: "Quarterly Report", authors: ["A. Analyst"], documentType: "report" }),
          "Chat Snippet for a model to read.",
          "## Key points\n\nThe Executive Summary a human sees first.",
          "The Abstract, short enough to skim in a list.",
        ],
      );
    }

    it("includes each Document's Abstract in the list, but not its Executive Summary or Markdown", async () => {
      const session = await loginAsNewUser("nbk7-list@example.com");
      const notebookId = await createNotebook(session, "Summarized");
      const upload = await uploadFile(session, notebookId, "quarterly.md", "# Quarterly Report");
      const { latestVersion } = upload.json() as { latestVersion: { id: string } };
      await seedSummaries(latestVersion.id);

      const response = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(200);
      const [document] = response.json() as Array<Record<string, unknown>>;
      expect(document.status).toBe("summarized");
      expect(document.abstract).toBe("The Abstract, short enough to skim in a list.");
      // A 200-page document's content must not ride along on a list request.
      expect(document).not.toHaveProperty("markdown");
      expect(document).not.toHaveProperty("executiveSummary");
    });

    it("reports a null Abstract for a Document that hasn't been summarized yet", async () => {
      const session = await loginAsNewUser("nbk7-list-pending@example.com");
      const notebookId = await createNotebook(session, "Not yet summarized");
      await uploadFile(session, notebookId, "fresh.md", "# Fresh");

      const response = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents`,
        cookies: { session },
      });

      const [document] = response.json() as Array<{ status: string; abstract: string | null }>;
      expect(document.status).toBe("queued");
      expect(document.abstract).toBeNull();
    });

    it("serves the Executive Summary, Chat Snippet and metadata on the Document detail", async () => {
      const session = await loginAsNewUser("nbk7-detail@example.com");
      const notebookId = await createNotebook(session, "Detail");
      const upload = await uploadFile(session, notebookId, "quarterly.md", "# Quarterly Report");
      const { id: documentId, latestVersion } = upload.json() as {
        id: string;
        latestVersion: { id: string };
      };
      await seedSummaries(latestVersion.id);

      const response = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents/${documentId}`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      expect(body.id).toBe(documentId);
      expect(body.executiveSummary).toBe("## Key points\n\nThe Executive Summary a human sees first.");
      expect(body.abstract).toBe("The Abstract, short enough to skim in a list.");
      expect(body.chatSnippet).toBe("Chat Snippet for a model to read.");
      expect(body.metadata).toMatchObject({ title: "Quarterly Report", documentType: "report" });
      // Still not the full content: that is a deliberate second request,
      // made only when the user expands past the Executive Summary.
      expect(body).not.toHaveProperty("markdown");
    });

    it("returns 404 for a Document detail that doesn't exist", async () => {
      const session = await loginAsNewUser("nbk7-detail-404@example.com");
      const notebookId = await createNotebook(session, "Missing detail");

      const response = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents/00000000-0000-0000-0000-000000000000`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(404);
    });

    it("serves the Converted Markdown for a Version on its own endpoint", async () => {
      const session = await loginAsNewUser("nbk7-content@example.com");
      const notebookId = await createNotebook(session, "Content");
      const upload = await uploadFile(session, notebookId, "quarterly.md", "# Quarterly Report");
      const { id: documentId, latestVersion } = upload.json() as {
        id: string;
        latestVersion: { id: string };
      };
      await seedSummaries(latestVersion.id);

      const response = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents/${documentId}/versions/${latestVersion.id}/content`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { markdown: string | null };
      // Markdown, not pre-rendered HTML: the structure (headings, tables)
      // has to survive to the client so it can render it as such.
      expect(body.markdown).toContain("## Revenue");
      expect(body.markdown).toContain("| Q1 | 12.4M |");
    });

    it("rejects unauthenticated reads of the detail and the content with 401", async () => {
      const session = await loginAsNewUser("nbk7-guard@example.com");
      const notebookId = await createNotebook(session, "Guarded");
      const upload = await uploadFile(session, notebookId, "guarded.md", "# Guarded");
      const { id: documentId, latestVersion } = upload.json() as {
        id: string;
        latestVersion: { id: string };
      };

      for (const url of [
        `/notebooks/${notebookId}/documents/${documentId}`,
        `/notebooks/${notebookId}/documents/${documentId}/versions/${latestVersion.id}/content`,
      ]) {
        expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      }
    });
  });

  // Per ADR-0001 (shared Notebook access despite full attribution): Documents
  // are not owned by the user who uploaded them, so there is deliberately no
  // ownership check on any Document route. This proves that's not an
  // oversight — a second, unrelated user can act on a Document they didn't
  // upload.
  describe("ADR-0001: shared access (no ownership check)", () => {
    it("lets a different authenticated user list, download, delete, and restore a Document they didn't upload", async () => {
      const uploaderSession = await loginAsNewUser("adr0001-uploader@example.com");
      const otherSession = await loginAsNewUser("adr0001-other@example.com");
      const notebookId = await createNotebook(uploaderSession, "Shared Notebook");

      const uploadResponse = await uploadFile(uploaderSession, notebookId, "shared.txt", "shared content");
      const { id: documentId, latestVersion } = uploadResponse.json() as {
        id: string;
        latestVersion: { id: string };
      };

      const listByOther = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents`,
        cookies: { session: otherSession },
      });
      expect((listByOther.json() as Array<{ filename: string }>).map((d) => d.filename)).toContain(
        "shared.txt",
      );

      const downloadByOther = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents/${documentId}/versions/${latestVersion.id}/download`,
        cookies: { session: otherSession },
      });
      expect(downloadByOther.statusCode).toBe(200);
      expect(downloadByOther.body).toBe("shared content");

      const deleteByOther = await app.inject({
        method: "DELETE",
        url: `/notebooks/${notebookId}/documents/${documentId}`,
        cookies: { session: otherSession },
      });
      expect(deleteByOther.statusCode).toBe(204);

      const restoreByOther = await app.inject({
        method: "POST",
        url: `/notebooks/${notebookId}/documents/${documentId}/restore`,
        cookies: { session: otherSession },
      });
      expect(restoreByOther.statusCode).toBe(200);
    });
  });
});
