import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { S3Client } from '@aws-sdk/client-s3';
import type { StartedTestContainer } from 'testcontainers';
import type { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import {
  createAppEventSubscriber,
  type AppEvent,
  type AppEventSubscriber,
} from '../src/events/bus.js';
import { listDocuments } from '../src/documents/repository.js';
import type { FailureReason } from '../src/documents/schema.js';
import { runConvertToMarkdownJob } from '../src/ingestion/convert-to-markdown.js';
import { IngestionFailure } from '../src/ingestion/stage.js';
import {
  createDoclingConverter,
  type MarkdownConversionRequest,
} from '../src/ingestion/docling.js';
import { createS3Client, ensureBucket, getObject, putObject } from '../src/storage/s3-client.js';
import { startMinio } from './support/minio-container.js';
import { missingDocker, scriptedDocker } from './support/scripted-docker.js';

const DOCUMENTS_BUCKET = 'rag-notebook-documents-job-test';

/**
 * Seam-2 tests (per NBK-1's testing decisions, and explicitly called for by
 * NBK-6's acceptance criteria): invoke the pg_boss job handler directly with
 * a constructed payload, against a real Postgres and a real MinIO, with the
 * Docling subprocess stubbed at its boundary (the `MarkdownConverter`
 * function — see src/ingestion/docling.ts). Assertions are on the resulting
 * database rows and the app events actually published over LISTEN/NOTIFY.
 *
 * Nothing here starts pg_boss: that this handler is *wired* to a queue, is
 * retried, and survives a restart is a different question, covered by
 * test/job-queue.test.ts.
 */
describe('convert-to-Markdown job', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedTestContainer;
  let pool: Pool;
  let s3: S3Client;
  let subscriber: AppEventSubscriber;
  let tempRoot: string;
  let received: AppEvent[];
  let stopCollecting: () => void;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = createPool(pgContainer.getConnectionUri());
    await runMigrations(pool);

    const minio = await startMinio();
    minioContainer = minio.container;
    s3 = createS3Client({
      endpoint: minio.endpoint,
      accessKeyId: minio.accessKeyId,
      secretAccessKey: minio.secretAccessKey,
    });
    await ensureBucket(s3, DOCUMENTS_BUCKET);

    subscriber = await createAppEventSubscriber(pgContainer.getConnectionUri());
    tempRoot = await mkdtemp(join(tmpdir(), 'nbk6-job-test-'));
  }, 180_000);

  afterAll(async () => {
    stopCollecting?.();
    await subscriber.close();
    await pool.end();
    await minioContainer.stop();
    await pgContainer.stop();
  });

  beforeEach(() => {
    stopCollecting?.();
    received = [];
    stopCollecting = subscriber.subscribe((event) => received.push(event));
  });

  /** Waits until `predicate` holds over the events collected so far. */
  async function waitForEvents(predicate: (events: AppEvent[]) => boolean): Promise<AppEvent[]> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (predicate(received)) return received;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Expected app events never arrived. Got: ${JSON.stringify(received)}`);
  }

  interface SeededVersion {
    notebookId: string;
    documentId: string;
    versionId: string;
    storageKey: string;
  }

  /**
   * Inserts a Notebook + Document + Document Version directly and puts the
   * raw bytes in MinIO, i.e. exactly the state the upload route (NBK-5)
   * leaves behind just before the job runs.
   */
  async function seedUploadedVersion(filename: string, contents: string): Promise<SeededVersion> {
    const { rows: notebookRows } = await pool.query<{ id: string }>(
      'INSERT INTO notebooks (title) VALUES ($1) RETURNING id',
      [`Notebook for ${filename}`],
    );
    const notebookId = notebookRows[0].id;
    const { rows: documentRows } = await pool.query<{ id: string }>(
      'INSERT INTO documents (notebook_id, filename) VALUES ($1, $2) RETURNING id',
      [notebookId, filename],
    );
    const documentId = documentRows[0].id;

    const storageKey = `notebooks/${notebookId}/${documentId}-${filename}`;
    await putObject(s3, DOCUMENTS_BUCKET, storageKey, Buffer.from(contents), 'text/plain');

    const { rows: versionRows } = await pool.query<{ id: string }>(
      `INSERT INTO document_versions (document_id, version_number, mime_type, size_bytes, storage_key)
       VALUES ($1, 1, 'text/plain', $2, $3) RETURNING id`,
      [documentId, Buffer.byteLength(contents), storageKey],
    );

    return { notebookId, documentId, versionId: versionRows[0].id, storageKey };
  }

  async function readVersion(versionId: string) {
    const { rows } = await pool.query<{
      ingestion_status: string;
      markdown: string | null;
      ingestion_error: string | null;
      converted_at: Date | null;
      storage_key: string;
    }>(
      'SELECT ingestion_status, markdown, ingestion_error, converted_at, storage_key FROM document_versions WHERE id = $1',
      [versionId],
    );
    return rows[0];
  }

  /** The Document's `failure` as the Documents API publishes it. */
  async function publishedFailure(seeded: SeededVersion) {
    const documents = await listDocuments(pool, seeded.notebookId);
    return documents.find((d) => d.id === seeded.documentId)!.failure;
  }

  /** Runs one stage-1 attempt whose converter throws `error`, swallowing the rethrow. */
  async function failAttempt(seeded: SeededVersion, error: Error, willRetry: boolean) {
    await expect(
      runConvertToMarkdownJob(
        {
          pool,
          s3,
          documentsBucket: DOCUMENTS_BUCKET,
          tempDir: tempRoot,
          convertToMarkdown: async () => {
            throw error;
          },
        },
        { payload: { documentId: seeded.documentId, versionId: seeded.versionId }, willRetry },
      ),
    ).rejects.toBe(error);
  }

  const scanRefusal = () =>
    new IngestionFailure('no-text-layer', 'scan.pdf has no text layer (a scanned PDF).');

  describe('NBK-64: failure reason', () => {
    it("records 'no-text-layer' and where it failed when a scanned PDF exhausts its retries", async () => {
      const seeded = await seedUploadedVersion('scan.pdf', 'pictures of text');

      await failAttempt(seeded, scanRefusal(), false);

      expect(await publishedFailure(seeded)).toEqual({
        reason: 'no-text-layer',
        failedAt: 'converting',
      });
    });

    it('records no reason while a retry is still pending', async () => {
      const seeded = await seedUploadedVersion('scan-retry.pdf', 'pictures of text');

      await failAttempt(seeded, scanRefusal(), true);

      expect((await readVersion(seeded.versionId)).ingestion_status).toBe('queued');
      expect(await publishedFailure(seeded)).toBeNull();
    });

    it("records 'unexpected' for an error that carries no reason", async () => {
      const seeded = await seedUploadedVersion('odd.txt', 'whatever');

      await failAttempt(seeded, new Error('something nobody classified'), false);

      expect(await publishedFailure(seeded)).toEqual({
        reason: 'unexpected',
        failedAt: 'converting',
      });
    });

    it('clears the reason once a later run of the Version succeeds', async () => {
      const seeded = await seedUploadedVersion('second-try.txt', 'fine after all');
      await failAttempt(seeded, scanRefusal(), false);

      await runConvertToMarkdownJob(
        {
          pool,
          s3,
          documentsBucket: DOCUMENTS_BUCKET,
          tempDir: tempRoot,
          convertToMarkdown: async ({ outputPath }) => {
            await writeFile(outputPath, '# Fine after all\n', 'utf8');
          },
        },
        {
          payload: { documentId: seeded.documentId, versionId: seeded.versionId },
          willRetry: false,
        },
      );

      expect((await readVersion(seeded.versionId)).ingestion_status).toBe('converted');
      expect(await publishedFailure(seeded)).toBeNull();
    });
  });

  /**
   * NBK-65: the real converter, run against a scripted `docker` binary, so
   * what the user is shown is checked from the way Docling actually failed
   * rather than from an error the test classified itself.
   */
  describe('NBK-65: stage 1 names its failures', () => {
    async function convertWithDocling(
      seeded: SeededVersion,
      docling: { docker: string; timeoutMs?: number },
      willRetry: boolean,
    ) {
      await expect(
        runConvertToMarkdownJob(
          {
            pool,
            s3,
            documentsBucket: DOCUMENTS_BUCKET,
            tempDir: tempRoot,
            convertToMarkdown: createDoclingConverter(docling),
          },
          { payload: { documentId: seeded.documentId, versionId: seeded.versionId }, willRetry },
        ),
      ).rejects.toBeInstanceOf(IngestionFailure);
    }

    const cases: {
      reason: FailureReason;
      when: string;
      docling: () => Promise<{ docker: string; timeoutMs?: number }>;
    }[] = [
      {
        reason: 'unreadable',
        when: 'Docling exits with an error',
        docling: async () => ({ docker: await scriptedDocker("echo 'damaged' >&2; exit 1") }),
      },
      {
        reason: 'unreadable',
        when: 'Docling exits 0 without writing Markdown',
        docling: async () => ({ docker: await scriptedDocker("echo 'failed to convert'") }),
      },
      {
        reason: 'timed-out',
        when: 'Docling is killed after its timeout',
        docling: async () => ({ docker: await scriptedDocker('exec sleep 30'), timeoutMs: 200 }),
      },
      {
        reason: 'service-unavailable',
        when: 'Docling cannot be started',
        docling: async () => ({ docker: missingDocker() }),
      },
    ];

    for (const { reason, when, docling } of cases) {
      it(`records '${reason}' at 'converting' when ${when} on the final attempt`, async () => {
        const seeded = await seedUploadedVersion('report.txt', 'Quarterly report');

        await convertWithDocling(seeded, await docling(), false);

        expect((await readVersion(seeded.versionId)).ingestion_status).toBe('failed');
        expect(await publishedFailure(seeded)).toEqual({ reason, failedAt: 'converting' });
      });

      it(`records no reason when ${when} and a retry is pending`, async () => {
        const seeded = await seedUploadedVersion('report-retry.txt', 'Quarterly report');

        await convertWithDocling(seeded, await docling(), true);

        expect((await readVersion(seeded.versionId)).ingestion_status).toBe('queued');
        expect(await publishedFailure(seeded)).toBeNull();
      });
    }
  });

  it('converts the stored upload and saves the Markdown on the Document Version', async () => {
    const seeded = await seedUploadedVersion('handbook.txt', 'the original bytes');

    // The Docling stub stands exactly where the Python subprocess would:
    // it is handed an input path holding the downloaded raw file and an
    // output path it must write the Markdown to. Reading the result back
    // from that file (not stdout) is the contract under test.
    const seenRequests: MarkdownConversionRequest[] = [];
    await runConvertToMarkdownJob(
      {
        pool,
        s3,
        documentsBucket: DOCUMENTS_BUCKET,
        tempDir: tempRoot,
        convertToMarkdown: async (request) => {
          seenRequests.push(request);
          const raw = await import('node:fs/promises').then((fs) =>
            fs.readFile(request.inputPath, 'utf8'),
          );
          await writeFile(request.outputPath, `# Handbook\n\n${raw}\n`, 'utf8');
        },
      },
      { payload: { documentId: seeded.documentId, versionId: seeded.versionId }, willRetry: false },
    );

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].inputPath).not.toBe(seenRequests[0].outputPath);

    const version = await readVersion(seeded.versionId);
    expect(version.ingestion_status).toBe('converted');
    expect(version.markdown).toBe('# Handbook\n\nthe original bytes\n');
    expect(version.ingestion_error).toBeNull();
    expect(version.converted_at).not.toBeNull();

    const events = await waitForEvents(
      (all) =>
        all.filter((e) => (e.data as { versionId?: string }).versionId === seeded.versionId)
          .length >= 2,
    );
    const mine = events.filter(
      (e) => (e.data as { versionId?: string }).versionId === seeded.versionId,
    );
    expect(mine.map((e) => (e.data as { status?: string }).status)).toEqual([
      'converting',
      'converted',
    ]);
    expect(mine[0].type).toBe('document-version-status-changed');
    expect(mine[0].topic).toBe(`notebook:${seeded.notebookId}`);
    expect(mine[1].data).toMatchObject({
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      status: 'converted',
      filename: 'handbook.txt',
    });
  });

  it("marks the Version failed and keeps the original upload when conversion can't be retried", async () => {
    const seeded = await seedUploadedVersion('broken.txt', 'still here afterwards');

    await expect(
      runConvertToMarkdownJob(
        {
          pool,
          s3,
          documentsBucket: DOCUMENTS_BUCKET,
          tempDir: tempRoot,
          convertToMarkdown: async () => {
            throw new Error('docling exited with code 1');
          },
        },
        {
          payload: { documentId: seeded.documentId, versionId: seeded.versionId },
          willRetry: false,
        },
      ),
    ).rejects.toThrow('docling exited with code 1');

    const version = await readVersion(seeded.versionId);
    expect(version.ingestion_status).toBe('failed');
    expect(version.ingestion_error).toContain('docling exited with code 1');
    // "Without losing the original upload" (NBK-6): the raw bytes and the
    // storage key pointing at them are untouched by a conversion failure.
    expect(version.storage_key).toBe(seeded.storageKey);
    const stored = await getObject(s3, DOCUMENTS_BUCKET, seeded.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stored.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8')).toBe('still here afterwards');

    const events = await waitForEvents((all) =>
      all.some(
        (e) =>
          (e.data as { versionId?: string }).versionId === seeded.versionId &&
          (e.data as { status?: string }).status === 'failed',
      ),
    );
    const failure = events.find((e) => (e.data as { status?: string }).status === 'failed')!;
    expect(failure.type).toBe('document-version-status-changed');
    expect(failure.data).toMatchObject({ status: 'failed' });
  });

  it("returns the Version to 'queued' when the failure will be retried", async () => {
    const seeded = await seedUploadedVersion('flaky.txt', 'retry me');

    await expect(
      runConvertToMarkdownJob(
        {
          pool,
          s3,
          documentsBucket: DOCUMENTS_BUCKET,
          tempDir: tempRoot,
          convertToMarkdown: async () => {
            throw new Error('transient docling crash');
          },
        },
        {
          payload: { documentId: seeded.documentId, versionId: seeded.versionId },
          willRetry: true,
        },
      ),
    ).rejects.toThrow('transient docling crash');

    const version = await readVersion(seeded.versionId);
    // A retry is still pending, so the Version is back in line — not
    // terminally failed. "failed" is reserved for retries being exhausted.
    expect(version.ingestion_status).toBe('queued');
    expect(version.ingestion_error).toContain('transient docling crash');
  });

  it('records a failure whose message is too long for an event, with the full text on the row', async () => {
    const seeded = await seedUploadedVersion('verbose.txt', 'noisy converter');
    // Stage 1 attaches up to 8000 bytes of Docling's own output to its error.
    // Before NBK-14's follow-up this blew the event bus's payload cap inside
    // the transaction recording the failure, so the Version silently stayed
    // at "converting" and the real error was replaced by the bus's complaint.
    const traceback = `Docling exited with code 1: ${'Traceback line\n'.repeat(600)}`;
    expect(traceback.length).toBeGreaterThan(7000);

    await expect(
      runConvertToMarkdownJob(
        {
          pool,
          s3,
          documentsBucket: DOCUMENTS_BUCKET,
          tempDir: tempRoot,
          convertToMarkdown: async () => {
            throw new Error(traceback);
          },
        },
        {
          payload: { documentId: seeded.documentId, versionId: seeded.versionId },
          willRetry: false,
        },
      ),
    ).rejects.toThrow('Docling exited with code 1');

    const version = await readVersion(seeded.versionId);
    expect(version.ingestion_status).toBe('failed');
    expect(version.ingestion_error).toBe(traceback);

    const events = await waitForEvents((all) =>
      all.some(
        (e) =>
          (e.data as { versionId?: string }).versionId === seeded.versionId &&
          (e.data as { status?: string }).status === 'failed',
      ),
    );
    const failure = events.find(
      (e) =>
        (e.data as { versionId?: string }).versionId === seeded.versionId &&
        (e.data as { status?: string }).status === 'failed',
    )!;
    const announced = (failure.data as { error: string }).error;
    expect(announced.startsWith('Docling exited with code 1')).toBe(true);
    expect(announced.length).toBeLessThan(traceback.length);
  });

  // Per ADR-0004 and GLOSSARY.md, Ingestion is "a chain of independently
  // retryable Stages, each one enqueuing the next on success". Stage 2
  // (NBK-7) is the first stage to be on the receiving end of that, so the
  // handler has to actually hand over.
  it('enqueues ingestion stage 2 once conversion succeeds, and not when it fails', async () => {
    const enqueued: { documentId: string; versionId: string }[] = [];
    const enqueueSummarizeDocument = async (payload: { documentId: string; versionId: string }) => {
      enqueued.push(payload);
    };

    const converted = await seedUploadedVersion('chained.txt', 'chain me');
    await runConvertToMarkdownJob(
      {
        pool,
        s3,
        documentsBucket: DOCUMENTS_BUCKET,
        tempDir: tempRoot,
        enqueueSummarizeDocument,
        convertToMarkdown: async ({ outputPath }) => {
          await writeFile(outputPath, '# Chained\n', 'utf8');
        },
      },
      {
        payload: { documentId: converted.documentId, versionId: converted.versionId },
        willRetry: false,
      },
    );

    expect(enqueued).toEqual([
      { documentId: converted.documentId, versionId: converted.versionId },
    ]);

    // A failed conversion produces no Converted Markdown, so there is
    // nothing for stage 2 to read — handing over would only queue a job
    // guaranteed to fail.
    const failed = await seedUploadedVersion('unchained.txt', 'no chain');
    await expect(
      runConvertToMarkdownJob(
        {
          pool,
          s3,
          documentsBucket: DOCUMENTS_BUCKET,
          tempDir: tempRoot,
          enqueueSummarizeDocument,
          convertToMarkdown: async () => {
            throw new Error('conversion failed');
          },
        },
        {
          payload: { documentId: failed.documentId, versionId: failed.versionId },
          willRetry: false,
        },
      ),
    ).rejects.toThrow('conversion failed');

    expect(enqueued).toHaveLength(1);
  });

  it('does nothing for a Document Version that no longer exists', async () => {
    await expect(
      runConvertToMarkdownJob(
        {
          pool,
          s3,
          documentsBucket: DOCUMENTS_BUCKET,
          tempDir: tempRoot,
          convertToMarkdown: async () => {
            throw new Error('should never be called');
          },
        },
        {
          payload: {
            documentId: '00000000-0000-0000-0000-000000000000',
            versionId: '00000000-0000-0000-0000-000000000001',
          },
          willRetry: true,
        },
      ),
    ).resolves.toBeUndefined();
  });
});
