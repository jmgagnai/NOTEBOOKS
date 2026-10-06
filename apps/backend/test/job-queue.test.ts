import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { S3Client } from "@aws-sdk/client-s3";
import type { StartedTestContainer } from "testcontainers";
import type { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { startJobQueue, type JobQueue } from "../src/jobs/queue.js";
import type { MarkdownConverter } from "../src/ingestion/docling.js";
import { createS3Client, ensureBucket, getObject, putObject } from "../src/storage/s3-client.js";
import { startMinio } from "./support/minio-container.js";

const DOCUMENTS_BUCKET = "rag-notebook-documents-queue-test";

/**
 * Covers the three things NBK-6 asks of the job *queue* itself, as opposed to
 * the handler (that's test/convert-to-markdown.job.test.ts): that an enqueued
 * job actually runs, that a failing one is retried without losing the
 * original upload, and that a job enqueued before the backend started still
 * completes afterwards.
 *
 * Real Postgres (pg_boss stores its jobs there, which is the entire reason it
 * survives a restart) and real MinIO; only Docling is stubbed.
 */
describe("job queue", () => {
  let pgContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedTestContainer;
  let pool: Pool;
  let s3: S3Client;
  let connectionString: string;
  const started: JobQueue[] = [];

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    connectionString = pgContainer.getConnectionUri();
    pool = createPool(connectionString);
    await runMigrations(pool);

    const minio = await startMinio();
    minioContainer = minio.container;
    s3 = createS3Client({
      endpoint: minio.endpoint,
      accessKeyId: minio.accessKeyId,
      secretAccessKey: minio.secretAccessKey,
    });
    await ensureBucket(s3, DOCUMENTS_BUCKET);
  }, 180_000);

  afterAll(async () => {
    for (const queue of started) await queue.stop().catch(() => {});
    await pool.end();
    await minioContainer.stop();
    await pgContainer.stop();
  });

  /** Starts a queue that is torn down with the suite. */
  async function start(options: {
    schema: string;
    convertToMarkdown?: MarkdownConverter;
    retryLimit?: number;
  }): Promise<JobQueue> {
    const queue = await startJobQueue({
      connectionString,
      // One pg_boss schema per test, so a worker left running by an earlier
      // test can't pick up this one's jobs.
      schema: options.schema,
      retryLimit: options.retryLimit ?? 0,
      retryDelaySeconds: 0,
      pollingIntervalSeconds: 0.5,
      worker: options.convertToMarkdown
        ? { pool, s3, documentsBucket: DOCUMENTS_BUCKET, convertToMarkdown: options.convertToMarkdown }
        : undefined,
    });
    started.push(queue);
    return queue;
  }

  async function seedUploadedVersion(filename: string, contents: string) {
    const { rows: notebookRows } = await pool.query<{ id: string }>(
      "INSERT INTO notebooks (title) VALUES ($1) RETURNING id",
      [`Notebook for ${filename}`],
    );
    const notebookId = notebookRows[0].id;
    const { rows: documentRows } = await pool.query<{ id: string }>(
      "INSERT INTO documents (notebook_id, filename) VALUES ($1, $2) RETURNING id",
      [notebookId, filename],
    );
    const documentId = documentRows[0].id;
    const storageKey = `notebooks/${notebookId}/${documentId}-${filename}`;
    await putObject(s3, DOCUMENTS_BUCKET, storageKey, Buffer.from(contents), "text/plain");
    const { rows: versionRows } = await pool.query<{ id: string }>(
      `INSERT INTO document_versions (document_id, version_number, mime_type, size_bytes, storage_key)
       VALUES ($1, 1, 'text/plain', $2, $3) RETURNING id`,
      [documentId, Buffer.byteLength(contents), storageKey],
    );
    return { notebookId, documentId, versionId: versionRows[0].id, storageKey };
  }

  /** Polls until a Document Version reaches one of `statuses`. */
  async function waitForStatus(versionId: string, statuses: string[], timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      const { rows } = await pool.query<{ ingestion_status: string; markdown: string | null }>(
        "SELECT ingestion_status, markdown FROM document_versions WHERE id = $1",
        [versionId],
      );
      last = rows[0].ingestion_status;
      if (statuses.includes(last)) return rows[0];
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Version ${versionId} never reached ${statuses.join("/")}; last status was "${last}".`);
  }

  /** A converter that writes the raw input through as Markdown. */
  const passthrough: MarkdownConverter = async ({ inputPath, outputPath }) => {
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(inputPath, "utf8"));
    await writeFile(outputPath, `# converted\n\n${raw}`, "utf8");
  };

  it("runs a convert job enqueued through the queue", async () => {
    const seeded = await seedUploadedVersion("queued.txt", "pipeline bytes");
    const queue = await start({ schema: "pgboss_runs", convertToMarkdown: passthrough });

    await queue.enqueueConvertToMarkdown({
      documentId: seeded.documentId,
      versionId: seeded.versionId,
    });

    const version = await waitForStatus(seeded.versionId, ["converted", "failed"]);
    expect(version.ingestion_status).toBe("converted");
    expect(version.markdown).toBe("# converted\n\npipeline bytes");
  });

  it("retries a failing job without losing the original upload", async () => {
    const seeded = await seedUploadedVersion("retried.txt", "survives a failure");
    let attempts = 0;
    const flaky: MarkdownConverter = async (request) => {
      attempts += 1;
      if (attempts === 1) throw new Error("first attempt blows up");
      await passthrough(request);
    };

    const queue = await start({ schema: "pgboss_retries", convertToMarkdown: flaky, retryLimit: 3 });
    await queue.enqueueConvertToMarkdown({
      documentId: seeded.documentId,
      versionId: seeded.versionId,
    });

    const version = await waitForStatus(seeded.versionId, ["converted", "failed"]);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(version.ingestion_status).toBe("converted");
    expect(version.markdown).toContain("survives a failure");

    // The raw upload is untouched by the failed attempt.
    const stored = await getObject(s3, DOCUMENTS_BUCKET, seeded.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stored.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe("survives a failure");
  });

  it("completes a job enqueued before the backend started", async () => {
    const seeded = await seedUploadedVersion("restarted.txt", "enqueued before restart");

    // A backend that only enqueues — the "before restart" process. Stopping
    // it leaves the job sitting in Postgres with nobody working it.
    const producerOnly = await start({ schema: "pgboss_restart" });
    await producerOnly.enqueueConvertToMarkdown({
      documentId: seeded.documentId,
      versionId: seeded.versionId,
    });
    await producerOnly.stop();

    const { rows: beforeRestart } = await pool.query<{ ingestion_status: string }>(
      "SELECT ingestion_status FROM document_versions WHERE id = $1",
      [seeded.versionId],
    );
    expect(beforeRestart[0].ingestion_status).toBe("queued");

    // The restarted backend, with its worker, picks the job up.
    await start({ schema: "pgboss_restart", convertToMarkdown: passthrough });

    const version = await waitForStatus(seeded.versionId, ["converted", "failed"]);
    expect(version.ingestion_status).toBe("converted");
    expect(version.markdown).toContain("enqueued before restart");
  });
});
