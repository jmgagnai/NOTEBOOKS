import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedTestContainer } from 'testcontainers';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { S3Client } from '@aws-sdk/client-s3';
import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { runConvertToMarkdownJob } from '../src/ingestion/convert-to-markdown.js';
import { runSummarizeDocumentJob } from '../src/ingestion/summarize-document.js';
import { runEmbedChunksJob } from '../src/ingestion/embed-chunks.js';
import type { JobQueue } from '../src/jobs/queue.js';
import { createOpenRouterEmbedder } from '../src/llm/embeddings.js';
import { DEFAULT_TASK_MODELS, EMBEDDING_DIMENSIONS } from '../src/llm/models.js';
import { createOpenRouterCompleter } from '../src/llm/openrouter.js';
import { createS3Client, ensureBucket } from '../src/storage/s3-client.js';
import { startMinio } from './support/minio-container.js';

const DOCUMENTS_BUCKET = 'rag-notebook-versioning-test';

/**
 * NBK-13: the cross-cutting versioning guarantee, proven once across the
 * whole stack rather than a slice at a time.
 *
 * GLOSSARY.md states it in two sentences, and this file exists to show they
 * hold together:
 *
 * - Document Version — "Only a Document's latest Version is searched in
 *   chat; older Versions stay retrievable through Citations that point to
 *   them."
 * - Citation — "Following a Citation opens that exact Version at that
 *   location, even after newer Versions exist."
 *
 * Four earlier tickets each tested their own half of that (NBK-5 upload
 * versioning, NBK-8 chunking/embedding per Version, NBK-9 search's
 * latest-then-`ready` rule, NBK-12 version-pinned Citations) — but every one
 * of them *seeded its own rows*. What was never exercised is the composition:
 * a real upload producing a real Version, a real pipeline chunking it, and
 * real search and chat agreeing about which Version that leaves current.
 * So nothing here seeds a `document_versions` row. Every Version in this
 * file is created by `POST /notebooks/:id/documents` and filled in by the
 * three real ingestion job handlers, chained the way pg_boss chains them.
 *
 * Seams 1 and 2 of NBK-1's testing decisions, combined, because the sequence
 * crosses both: the real Fastify app through `app.inject()` for upload,
 * search, chat and following a Citation, and the real pg_boss job handlers
 * invoked directly for ingestion (which is never driven over HTTP). Against
 * a real Postgres+pgvector and a real MinIO via Testcontainers. Only two
 * boundaries are stubbed, each at the place the earlier tickets stub it:
 * OpenRouter at its `fetch`, so the real request building and response
 * parsing in `src/llm/*` stay under test, and Docling at the
 * `MarkdownConverter` boundary.
 *
 * Questions are asked down the synchronous answer path rather than the
 * streamed one (NBK-11), because both run the same `groundQuestion` — so
 * retrieval and the prompt are literally the same code, and
 * `test/chat-streaming.route.test.ts` is what proves the two paths persist
 * the same row. A versioning rule cannot differ between them without that
 * test failing first.
 */
describe('Versioning integrity, end to end', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedTestContainer;
  let pool: Pool;
  let s3: S3Client;
  let app: FastifyInstance;

  /**
   * Embeddings are opaque numbers, so they are pinned to something a test can
   * reason about: one orthonormal basis vector of the embedding space per
   * topic phrase (the device NBK-12's tests use). Cosine similarity between
   * two distinct axes is exactly 0 and between an axis and itself exactly 1,
   * so chat retrieval ranks a Version's Chunk first exactly when the question
   * is about its claim.
   *
   * Each phrase is the figure one Document Version claims, so "which Version
   * answered this" is decided by the claim alone: a question about fourteen
   * weeks is nearest v1's chunk. Search finds the claim's words instead
   * (NBK-104).
   */
  const TOPICS = ['fourteen weeks', 'six weeks', 'nine weeks', 'carrier capacity'];

  function vectorFor(text: string): number[] {
    const lower = text.toLowerCase();
    const topic = TOPICS.findIndex((t) => lower.includes(t));
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    vector[topic >= 0 ? topic : TOPICS.length] = 1;
    return vector;
  }

  /**
   * A text whose embedding request the stubbed OpenRouter rejects, standing
   * in for the stage-3 failure that leaves a Version `failed`. A 400 rather
   * than a 429/5xx on purpose: `createOpenRouterEmbedder` does not retry it,
   * so the failure is the one attempt the test asked for.
   */
  const UNEMBEDDABLE = 'unembeddable';

  /** What the stubbed chat completion answers. Set per test. */
  let chatAnswer = 'No answer was scripted for this test.';
  /** Every chat-completion prompt the app caused, oldest first. */
  let completionPrompts: { system: string; user: string }[] = [];

  /** `count` distinct words, so a scripted artifact can hit its word range. */
  function words(count: number): string {
    return Array.from({ length: count }, (_, i) => `word${i + 1}`).join(' ');
  }

  /**
   * Which generation task a completion is for, read off the system prompt the
   * way summarize-document.job.test.ts reads it — several tasks legitimately
   * share a model, so the model id cannot tell them apart.
   */
  function isIngestionTask(system: string): boolean {
    return (
      system.includes('extract bibliographic metadata') ||
      system.includes('merge several section summaries') ||
      system.includes('summarize one section') ||
      system.includes('a Chat Snippet') ||
      system.includes('an Executive Summary') ||
      system.includes('an Abstract')
    );
  }

  /**
   * The Abstract stage 2 generates for a Version, carrying the Version's own
   * claim so each Version's summaries can be told apart.
   */
  function abstractFor(claim: string): string {
    return `Abstract of the logistics review stating ${claim}. ${words(60)}`;
  }

  /** The claim named in the prompt stage 2 is currently summarizing. */
  function claimIn(user: string): string {
    return TOPICS.find((topic) => user.includes(topic)) ?? 'no stated figure';
  }

  const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.endsWith('/embeddings')) {
      const texts = (Array.isArray(body.input) ? body.input : [body.input]) as string[];
      if (texts.some((text) => text.includes(UNEMBEDDABLE))) {
        return json({ error: { message: 'This test refuses to embed that text.' } }, 400);
      }
      return json({ data: texts.map((text, index) => ({ index, embedding: vectorFor(text) })) });
    }

    if (url.endsWith('/chat/completions')) {
      const messages = body.messages as { role: string; content: string }[];
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages.find((m) => m.role === 'user')?.content ?? '';

      if (!isIngestionTask(system)) {
        // The chat answer path (NBK-10). Recorded, because what the model was
        // shown is how this test proves *which* Version grounded an answer.
        completionPrompts.push({ system, user });
        return json({ choices: [{ message: { content: chatAnswer } }] });
      }

      // Ingestion stage 2 (NBK-7). Scripted inside each artifact's word range
      // so no corrective rewrite is triggered.
      if (system.includes('extract bibliographic metadata')) {
        return json({
          choices: [
            {
              message: {
                content: '{"title":"Logistics Review","documentType":"report","language":"en"}',
              },
            },
          ],
        });
      }
      if (system.includes('an Abstract')) {
        return json({ choices: [{ message: { content: abstractFor(claimIn(user)) } }] });
      }
      if (system.includes('a Chat Snippet')) {
        return json({
          choices: [{ message: { content: `Chat Snippet for ${claimIn(user)}. ${words(200)}` } }],
        });
      }
      if (system.includes('an Executive Summary')) {
        return json({ choices: [{ message: { content: words(700) } }] });
      }
      return json({ choices: [{ message: { content: `Section summary. ${words(40)}` } }] });
    }

    throw new Error(`The app called an unexpected OpenRouter endpoint: ${url}`);
  }) as typeof globalThis.fetch;

  const embed = createOpenRouterEmbedder({
    apiKey: 'test-key',
    model: 'qwen/qwen3-embedding-4b',
    fetch: stubFetch,
    retries: 0,
  });
  const complete = createOpenRouterCompleter({ apiKey: 'test-key', fetch: stubFetch, retries: 0 });

  /**
   * The ingestion jobs the app and the stages themselves enqueued, in order.
   * Standing in for pg_boss: what matters to this test is that the real
   * hand-over happens and that each stage runs against the Version the stage
   * before it named — not pg_boss's polling.
   */
  type Stage = 'convert' | 'summarize' | 'embed';
  interface QueuedJob {
    stage: Stage;
    payload: { documentId: string; versionId: string };
  }
  let queued: QueuedJob[] = [];

  const jobs: JobQueue = {
    enqueueConvertToMarkdown: async (payload) => void queued.push({ stage: 'convert', payload }),
    enqueueSummarizeDocument: async (payload) => void queued.push({ stage: 'summarize', payload }),
    enqueueEmbedChunks: async (payload) => void queued.push({ stage: 'embed', payload }),
    stop: async () => {},
  };

  /**
   * Docling, at the boundary NBK-6's tests stub it at. It copies the uploaded
   * bytes through as the Converted Markdown, which is close to what Docling
   * really does for a Markdown input (NBK-1: "plain text, Markdown, and CSV
   * inputs likely pass through with comparatively little transformation") —
   * and it means the Markdown every later stage reads came out of the file
   * that was actually uploaded, through MinIO, rather than out of the test.
   */
  async function copyThroughDocling({
    inputPath,
    outputPath,
  }: {
    inputPath: string;
    outputPath: string;
  }) {
    await writeFile(outputPath, await readFile(inputPath, 'utf8'), 'utf8');
  }

  /** Runs one stage's real handler. Throws whatever the handler throws. */
  async function runStage(job: QueuedJob): Promise<void> {
    // `willRetry: false` throughout: a stage that fails here has exhausted
    // its attempts, which is the state these tests want to observe (a Version
    // left `failed`) rather than one sitting mid-retry.
    const invocation = { payload: job.payload, willRetry: false };
    if (job.stage === 'convert') {
      await runConvertToMarkdownJob(
        {
          pool,
          s3,
          documentsBucket: DOCUMENTS_BUCKET,
          convertToMarkdown: copyThroughDocling,
          enqueueSummarizeDocument: jobs.enqueueSummarizeDocument,
        },
        invocation,
      );
    } else if (job.stage === 'summarize') {
      await runSummarizeDocumentJob(
        {
          pool,
          complete,
          models: DEFAULT_TASK_MODELS,
          enqueueEmbedChunks: jobs.enqueueEmbedChunks,
        },
        invocation,
      );
    } else {
      await runEmbedChunksJob({ pool, embed }, invocation);
    }
  }

  interface DrainOptions {
    /** Only work jobs for this Document Version, leaving any others queued. */
    versionId?: string;
    /** Run this stage and then stop, leaving the chain it enqueued queued. */
    stopAfter?: Stage;
  }

  /**
   * Works the queue, running each stage's real handler and letting it enqueue
   * the next — the chain ADR-0004 describes, driven from whatever the upload
   * route enqueued rather than from the test.
   *
   * The two options are what let a test hold a Version mid-ingestion, or
   * finish a newer Version before an older one: `versionId` works one
   * Version's pipeline and leaves the rest of the queue alone, and
   * `stopAfter` stops once a stage has run. Together they stand in for a
   * pg_boss whose workers happen to run in an inconvenient order, which is
   * exactly the seam a versioning rule can break at.
   *
   * Stage failures are swallowed: a failed stage leaves a Version row behind
   * (status `failed`, `ingestion_error` set) and that row is what the test
   * then asserts on, the way pg_boss would leave it after the last attempt.
   */
  async function drainIngestion(options: DrainOptions = {}): Promise<void> {
    for (;;) {
      const at = queued.findIndex(
        (job) => options.versionId === undefined || job.payload.versionId === options.versionId,
      );
      if (at === -1) return;
      const [job] = queued.splice(at, 1);
      try {
        await runStage(job);
      } catch {
        // Recorded on the Version row by the handler itself; see above.
      }
      if (options.stopAfter !== undefined && job.stage === options.stopAfter) return;
    }
  }

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

    // One app, with every dependency a full deployment has: uploads store
    // bytes in MinIO and enqueue stage 1, and chat answers through
    // OpenRouter. Search is by keyword (NBK-104) and needs nothing more.
    app = await buildApp({
      pool,
      s3,
      documentsBucket: DOCUMENTS_BUCKET,
      jobs,
      chat: { complete, embed, model: 'test/chat-model' },
    });
  }, 300_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await minioContainer.stop();
    await pgContainer.stop();
  });

  beforeEach(() => {
    queued = [];
    completionPrompts = [];
    chatAnswer = 'No answer was scripted for this test.';
  });

  async function loginAsNewUser(email: string): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'correct-horse-battery-staple' },
    });
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'correct-horse-battery-staple' },
    });
    return loginResponse.cookies.find((c) => c.name === 'session')!.value;
  }

  async function createNotebook(session: string, title: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/notebooks',
      cookies: { session },
      payload: { title },
    });
    return (response.json() as { id: string }).id;
  }

  /**
   * One Version's worth of file content. The claim is the only thing that
   * differs between Versions, and it is what the chunk's embedding is derived
   * from — so "which Version is being searched" is decided by the content
   * that was uploaded, not by anything the test tells the database.
   */
  function logisticsMarkdown(claim: string): string {
    return [
      '# Logistics Review',
      '',
      '## Lead times',
      '',
      `Supply chain lead times ran to ${claim} across the northern corridor, and every tender was re-priced accordingly.`,
      '',
    ].join('\n');
  }

  /** The chunk text `chunkMarkdown` produces from {@link logisticsMarkdown}. */
  function expectedChunkText(claim: string): string {
    return `Supply chain lead times ran to ${claim} across the northern corridor, and every tender was re-priced accordingly.`;
  }

  interface ApiDocument {
    id: string;
    filename: string;
    status: string;
    abstract: string | null;
    latestVersion: { id: string; versionNumber: number };
  }

  /** Uploads a file through the real route, as a browser's form post would. */
  async function upload(session: string, notebookId: string, filename: string, content: string) {
    const boundary = '----nbk13TestBoundary';
    const payload = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n` +
        `${content}\r\n` +
        `--${boundary}--\r\n`,
    );
    const response = await app.inject({
      method: 'POST',
      url: `/notebooks/${notebookId}/documents`,
      cookies: { session },
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    return { statusCode: response.statusCode, body: response.json() as ApiDocument };
  }

  /** Uploads and then runs the whole pipeline the upload enqueued. */
  async function uploadAndIngest(
    session: string,
    notebookId: string,
    filename: string,
    claim: string,
  ) {
    const uploaded = await upload(session, notebookId, filename, logisticsMarkdown(claim));
    expect(uploaded.statusCode).toBe(201);
    await drainIngestion();
    return uploaded.body;
  }

  async function listDocuments(session: string, notebookId: string): Promise<ApiDocument[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/notebooks/${notebookId}/documents`,
      cookies: { session },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as ApiDocument[];
  }

  /**
   * The ingestion status of one Version, read straight off the row.
   *
   * The only direct database read in this file, and it is never an assertion
   * about behaviour — the API deliberately surfaces a Document's *latest*
   * Version's status and no endpoint exposes a superseded Version's, so this
   * is how a test confirms the state it set up (a superseded Version that did
   * reach `ready`) before asserting what search and chat do about it.
   */
  async function versionStatus(versionId: string): Promise<string> {
    const { rows } = await pool.query<{ ingestion_status: string }>(
      'SELECT ingestion_status FROM document_versions WHERE id = $1',
      [versionId],
    );
    return rows[0].ingestion_status;
  }

  /** A Documents search hit (NBK-104): one Chunk, and the Version it is from. */
  interface SearchHit {
    documentId: string;
    match: { versionId: string };
  }

  /**
   * Searches for a Version's claim ("six weeks"), as a phrase: since NBK-104
   * search is by keyword, so which Version is searched shows as whether a
   * claim only one Version states is found at all.
   */
  async function search(session: string, notebookId: string, claim: string): Promise<SearchHit[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/notebooks/${notebookId}/search?q=${encodeURIComponent(`"${claim}"`)}`,
      cookies: { session },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { results: SearchHit[] }).results;
  }

  interface ApiCitation {
    id: string;
    marker: number;
    documentId: string;
    documentVersionId: string;
    versionNumber: number;
    chunkId: string;
    filename: string;
    headingPath: string[];
    charStart: number | null;
    charEnd: number | null;
  }

  interface ApiMessage {
    id: string;
    role: string;
    content: string;
    citations: ApiCitation[];
  }

  async function startThread(session: string, notebookId: string, title: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/notebooks/${notebookId}/threads`,
      cookies: { session },
      payload: { title },
    });
    return (response.json() as { id: string }).id;
  }

  async function ask(session: string, notebookId: string, threadId: string, question: string) {
    const response = await app.inject({
      method: 'POST',
      url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
      cookies: { session },
      payload: { content: question },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { question: ApiMessage; answer: ApiMessage }).answer;
  }

  async function readThread(
    session: string,
    notebookId: string,
    threadId: string,
  ): Promise<ApiMessage[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
      cookies: { session },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as ApiMessage[];
  }

  /** Follows a Citation: opens the exact Version it pins. */
  async function follow(session: string, notebookId: string, citation: ApiCitation) {
    const response = await app.inject({
      method: 'GET',
      url: `/notebooks/${notebookId}/documents/${citation.documentId}/versions/${citation.documentVersionId}/content`,
      cookies: { session },
    });
    return {
      statusCode: response.statusCode,
      body: response.json() as { versionId: string; markdown: string },
    };
  }

  // The acceptance criterion, in one test, in the order NBK-13 writes it:
  // upload → ask a question → Citation created → re-upload the same filename
  // → search again → the old Version is excluded from search, the new Version
  // is included, and the earlier Citation still opens the old Version.
  //
  // Every "is included" assertion is positive — the new Version's own content
  // and Abstract — so the test cannot pass merely because retrieval returned
  // nothing at all.
  it('supersedes the old Version for search and chat while the Citation to it keeps opening it', async () => {
    const session = await loginAsNewUser('versioning-sequence@example.com');
    const notebookId = await createNotebook(session, 'Logistics');

    // 1. Upload, and let the real pipeline take it to `ready`.
    const v1Document = await uploadAndIngest(session, notebookId, 'logistics.md', 'fourteen weeks');
    expect(v1Document.latestVersion.versionNumber).toBe(1);
    const v1 = v1Document.latestVersion.id;

    const readyAfterUpload = await search(session, notebookId, 'fourteen weeks');
    expect(readyAfterUpload).toHaveLength(1);
    expect(readyAfterUpload[0].documentId).toBe(v1Document.id);
    expect(readyAfterUpload[0].match.versionId).toBe(v1);

    // 2. Ask a question, and 3. get a Citation out of the answer.
    const threadId = await startThread(session, notebookId, 'Lead times');
    chatAnswer = 'Lead times ran to fourteen weeks [1].';
    const firstAnswer = await ask(
      session,
      notebookId,
      threadId,
      'What were lead times at fourteen weeks?',
    );

    expect(firstAnswer.citations).toHaveLength(1);
    const oldCitation = firstAnswer.citations[0];
    expect(oldCitation.documentVersionId).toBe(v1);
    expect(oldCitation.versionNumber).toBe(1);
    expect(oldCitation.filename).toBe('logistics.md');
    expect(oldCitation.headingPath).toEqual(['Logistics Review', 'Lead times']);
    // The answer really was grounded in v1's text, not just attributed to it.
    expect(completionPrompts.at(-1)!.user).toContain(expectedChunkText('fourteen weeks'));

    // 4. Re-upload the same filename: a new Version of the same Document.
    const v2Document = await uploadAndIngest(session, notebookId, 'logistics.md', 'six weeks');
    expect(v2Document.id).toBe(v1Document.id);
    expect(v2Document.latestVersion.versionNumber).toBe(2);
    const v2 = v2Document.latestVersion.id;
    expect(v2).not.toBe(v1);

    // 5. Search again.
    //
    // The new Version is included — positively: what v2 says is found, in
    // v2's Chunk of the same Document.
    const forNewClaim = await search(session, notebookId, 'six weeks');
    expect(forNewClaim).toHaveLength(1);
    expect(forNewClaim[0].documentId).toBe(v1Document.id);
    expect(forNewClaim[0].match.versionId).toBe(v2);

    // And the old Version is excluded: what only v1 says is found nowhere.
    expect(await search(session, notebookId, 'fourteen weeks')).toEqual([]);

    // Chat agrees: a question about the superseded figure is now answered
    // from v2's text, and v1's text is nowhere in the prompt.
    chatAnswer = 'Lead times ran to six weeks [1].';
    const secondAnswer = await ask(
      session,
      notebookId,
      threadId,
      'And lead times at fourteen weeks now?',
    );
    const lastPrompt = completionPrompts.at(-1)!.user;
    expect(lastPrompt).toContain(expectedChunkText('six weeks'));
    expect(lastPrompt).not.toContain(expectedChunkText('fourteen weeks'));
    expect(secondAnswer.citations[0].documentVersionId).toBe(v2);
    expect(secondAnswer.citations[0].versionNumber).toBe(2);

    // 6. The earlier Citation still opens the old Version, at its location.
    const reread = await readThread(session, notebookId, threadId);
    const [citationNow] = reread.filter((m) => m.role === 'assistant')[0].citations;
    expect(citationNow.documentVersionId).toBe(v1);
    expect(citationNow.versionNumber).toBe(1);
    expect(citationNow.chunkId).toBe(oldCitation.chunkId);
    expect(citationNow.headingPath).toEqual(['Logistics Review', 'Lead times']);

    const followed = await follow(session, notebookId, citationNow);
    expect(followed.statusCode).toBe(200);
    expect(followed.body.versionId).toBe(v1);
    expect(followed.body.markdown).toBe(logisticsMarkdown('fourteen weeks'));
    // "At that location": the cited range still slices back to the passage
    // the answer was grounded in.
    expect(citationNow.charStart).not.toBeNull();
    expect(followed.body.markdown.slice(citationNow.charStart!, citationNow.charEnd!)).toBe(
      expectedChunkText('fourteen weeks'),
    );

    // Both Citations coexist in the Thread, each pinned to its own Version.
    expect(
      reread.filter((m) => m.role === 'assistant').map((m) => m.citations[0].versionNumber),
    ).toEqual([1, 2]);
  });

  // The first of the three seams where this could plausibly break: the
  // re-upload lands while the Version before it is still being ingested, so
  // the two pipelines are in flight at once and finish out of order.
  //
  // Two things have to hold. The new Version is numbered from the Document's
  // Versions, not from the ones that finished — otherwise the second upload
  // would collide on `version_number`. And a superseded Version that reaches
  // `ready` *after* its successor must not become searchable, which is the
  // case a "latest ready Version" rule (rather than "latest Version, then
  // ready") would get wrong.
  it('supersedes a Version that is still mid-ingestion, and never searches it when it finishes late', async () => {
    const session = await loginAsNewUser('versioning-midflight@example.com');
    const notebookId = await createNotebook(session, 'Mid-flight');

    // v1 is uploaded and converted, but stops there — stage 2 is still owed.
    const v1Document = (
      await upload(session, notebookId, 'logistics.md', logisticsMarkdown('fourteen weeks'))
    ).body;
    const v1 = v1Document.latestVersion.id;
    await drainIngestion({ versionId: v1, stopAfter: 'convert' });
    expect((await listDocuments(session, notebookId))[0].status).toBe('converted');

    // The same filename is re-uploaded while that is still true.
    const v2Document = (
      await upload(session, notebookId, 'logistics.md', logisticsMarkdown('six weeks'))
    ).body;
    expect(v2Document.id).toBe(v1Document.id);
    expect(v2Document.latestVersion.versionNumber).toBe(2);
    const v2 = v2Document.latestVersion.id;

    // With neither Version `ready`, the Document is out of search entirely
    // rather than answering from a half-ingested Version.
    expect(await search(session, notebookId, 'fourteen weeks')).toEqual([]);
    expect(await search(session, notebookId, 'six weeks')).toEqual([]);

    // v2's pipeline finishes first, leaving v1's stage 2 and 3 still queued.
    await drainIngestion({ versionId: v2 });
    const afterV2 = await search(session, notebookId, 'six weeks');
    expect(afterV2).toHaveLength(1);
    expect(afterV2[0].match.versionId).toBe(v2);

    // Now v1's ingestion catches up and takes the *superseded* Version all
    // the way to `ready`, chunks and all.
    await drainIngestion({ versionId: v1 });
    expect(await versionStatus(v1)).toBe('ready');

    // It still contributes nothing: what only v1 says is found nowhere.
    expect(await search(session, notebookId, 'fourteen weeks')).toEqual([]);

    // And chat is grounded in v2's text alone.
    const threadId = await startThread(session, notebookId, 'Lead times');
    chatAnswer = 'Lead times ran to six weeks [1].';
    const answer = await ask(
      session,
      notebookId,
      threadId,
      'What were lead times at fourteen weeks?',
    );
    const prompt = completionPrompts.at(-1)!.user;
    expect(prompt).toContain(expectedChunkText('six weeks'));
    expect(prompt).not.toContain(expectedChunkText('fourteen weeks'));
    expect(answer.citations[0].documentVersionId).toBe(v2);
  });

  // The second seam: the newest Version's ingestion fails outright.
  //
  // This is the one case where "only the latest Version is searched" and
  // "only `ready` Versions are searched" pull in opposite directions, and
  // docs/search.md is explicit about which wins — the `ready` test is applied
  // *after* the latest Version is chosen, so the Document leaves search
  // rather than quietly answering from content the user has already
  // replaced. A query about the superseded figure is the proof: it must find
  // nothing, not the old Version scoring 1.
  it('drops a Document whose newest Version failed, instead of falling back to the superseded one', async () => {
    const session = await loginAsNewUser('versioning-failed@example.com');
    const notebookId = await createNotebook(session, 'Failed re-upload');

    const v1Document = await uploadAndIngest(session, notebookId, 'logistics.md', 'fourteen weeks');
    const v1 = v1Document.latestVersion.id;
    const threadId = await startThread(session, notebookId, 'Lead times');
    chatAnswer = 'Lead times ran to fourteen weeks [1].';
    const groundedAnswer = await ask(
      session,
      notebookId,
      threadId,
      'What were lead times at fourteen weeks?',
    );
    const citation = groundedAnswer.citations[0];
    expect(citation.documentVersionId).toBe(v1);

    // The re-upload's content cannot be embedded, so stage 3 exhausts its
    // attempts and the Version is left `failed`.
    const v2Document = (
      await upload(
        session,
        notebookId,
        'logistics.md',
        `# Logistics Review\n\n## Lead times\n\nThis revision is ${UNEMBEDDABLE} and stage 3 will not take it.\n`,
      )
    ).body;
    expect(v2Document.latestVersion.versionNumber).toBe(2);
    await drainIngestion();
    expect(await versionStatus(v2Document.latestVersion.id)).toBe('failed');

    // Visible in the Notebook, with the status that says why — a failed
    // upload must not vanish (NBK-1: "so that I can retry or investigate
    // rather than silently losing the upload").
    const listed = await listDocuments(session, notebookId);
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe('failed');
    expect(listed[0].latestVersion.versionNumber).toBe(2);

    // But out of search: no fallback to v1, so v1's claim, found ten lines
    // ago, now finds nothing at all.
    expect(await search(session, notebookId, 'fourteen weeks')).toEqual([]);

    // And out of chat, which says so rather than answering from v1.
    chatAnswer = 'This should never be generated: there is nothing to ground it in.';
    const ungrounded = await ask(
      session,
      notebookId,
      threadId,
      'Lead times at fourteen weeks again?',
    );
    expect(ungrounded.citations).toEqual([]);
    expect(ungrounded.content).toContain('no sources to answer from yet');
    // No completion was even requested for it — the previous prompt is still
    // the last one.
    expect(completionPrompts).toHaveLength(1);

    // The Citation made while v1 was current still opens v1, at its passage.
    const followed = await follow(session, notebookId, citation);
    expect(followed.statusCode).toBe(200);
    expect(followed.body.markdown).toBe(logisticsMarkdown('fourteen weeks'));
    expect(followed.body.markdown.slice(citation.charStart!, citation.charEnd!)).toBe(
      expectedChunkText('fourteen weeks'),
    );
    // Re-read, not just remembered from the response: still v1, still v1's
    // chunk.
    const [citationNow] = (await readThread(session, notebookId, threadId)).filter(
      (m) => m.role === 'assistant',
    )[0].citations;
    expect(citationNow.documentVersionId).toBe(v1);
    expect(citationNow.chunkId).toBe(citation.chunkId);
  });

  // GLOSSARY.md says "even after newer Versions exist" — plural. One
  // superseding Version is the case every earlier ticket looked at; two is
  // where a rule written as "the previous Version" rather than "the Version
  // this Citation names" would start being wrong.
  //
  // It also settles the question NBK-12's migration raises: `chunks` has no
  // `ON DELETE`, and re-running ingestion stage 3 over a Version replaces
  // that Version's chunks. A re-upload makes a *new* Version, so each
  // re-upload's stage 3 only ever deletes chunks nothing has cited — which is
  // why three Citations into three Versions all still resolve here.
  it('keeps every Citation resolving to its own Version across two further re-uploads', async () => {
    const session = await loginAsNewUser('versioning-three@example.com');
    const notebookId = await createNotebook(session, 'Three Versions');
    const threadId = await startThread(session, notebookId, 'Lead times');

    const claims = ['fourteen weeks', 'six weeks', 'nine weeks'];
    const versionIds: string[] = [];
    let documentId = '';

    for (const claim of claims) {
      const document = await uploadAndIngest(session, notebookId, 'logistics.md', claim);
      documentId = document.id;
      versionIds.push(document.latestVersion.id);
      expect(document.latestVersion.versionNumber).toBe(versionIds.length);

      // Asked while this Version is the current one, so each answer's
      // Citation pins a different Version of the same Document.
      chatAnswer = `Lead times ran to ${claim} [1].`;
      const answer = await ask(session, notebookId, threadId, `What were lead times at ${claim}?`);
      expect(answer.citations).toHaveLength(1);
      expect(answer.citations[0].documentVersionId).toBe(versionIds.at(-1));
      expect(answer.citations[0].versionNumber).toBe(versionIds.length);
    }

    // One Document, three Versions, three answers — each still naming the
    // Version it was grounded in.
    const answers = (await readThread(session, notebookId, threadId)).filter(
      (m) => m.role === 'assistant',
    );
    expect(answers.map((m) => m.citations[0].documentVersionId)).toEqual(versionIds);
    expect(answers.map((m) => m.citations[0].versionNumber)).toEqual([1, 2, 3]);

    // And each one opens its own Version's content at its own passage —
    // including the first, two re-uploads later.
    for (const [index, claim] of claims.entries()) {
      const citation = answers[index].citations[0];
      expect(citation.documentId).toBe(documentId);
      const followed = await follow(session, notebookId, citation);
      expect(followed.statusCode).toBe(200);
      expect(followed.body.versionId).toBe(versionIds[index]);
      expect(followed.body.markdown).toBe(logisticsMarkdown(claim));
      expect(followed.body.markdown.slice(citation.charStart!, citation.charEnd!)).toBe(
        expectedChunkText(claim),
      );
    }

    // Only the third Version is searched: its claim is found, the claims of
    // the two it superseded are not.
    expect(await search(session, notebookId, 'nine weeks')).toHaveLength(1);
    expect(await search(session, notebookId, 'fourteen weeks')).toEqual([]);
    expect(await search(session, notebookId, 'six weeks')).toEqual([]);
  });

  // The third seam, and the one NBK-12 left a sharp edge on deliberately:
  // `citations.chunk_id` has no `ON DELETE`, so the `DELETE FROM chunks` that
  // opens stage 3's chunk replacement is refused for a Version something has
  // already cited. That is the storage-level expression of "older Versions
  // stay retrievable through Citations" — it is meant to fail loudly rather
  // than cascade a cited passage away.
  //
  // This test pins down that the re-upload path cannot reach it: a re-upload
  // makes a new Version with its own chunks, so stage 3 never re-runs over a
  // cited one. Re-driving stage 3 at a cited Version by hand is the only way
  // there, and it is refused — which is also the regression guard against
  // anyone "optimising" a re-upload into an in-place re-ingest of the current
  // Version.
  it('refuses to re-chunk a Version a Citation points into, and re-uploads never ask it to', async () => {
    const session = await loginAsNewUser('versioning-rechunk@example.com');
    const notebookId = await createNotebook(session, 'Re-chunking');

    const v1Document = await uploadAndIngest(session, notebookId, 'logistics.md', 'fourteen weeks');
    const v1 = v1Document.latestVersion.id;
    const threadId = await startThread(session, notebookId, 'Lead times');
    chatAnswer = 'Lead times ran to fourteen weeks [1].';
    const citation = (
      await ask(session, notebookId, threadId, 'What were lead times at fourteen weeks?')
    ).citations[0];
    expect(citation.documentVersionId).toBe(v1);

    // A re-upload: stage 3 runs again, for v2, and the cited Version's chunks
    // are untouched by it.
    const v2 = (await uploadAndIngest(session, notebookId, 'logistics.md', 'six weeks'))
      .latestVersion.id;
    expect(v2).not.toBe(v1);
    const stillResolves = await follow(session, notebookId, citation);
    expect(stillResolves.statusCode).toBe(200);
    expect(stillResolves.body.markdown).toBe(logisticsMarkdown('fourteen weeks'));

    // Now stage 3 is pointed at the cited Version itself, which is the only
    // way to make it try to replace chunks a Citation holds.
    await expect(
      runEmbedChunksJob(
        { pool, embed },
        { payload: { documentId: v1Document.id, versionId: v1 }, willRetry: false },
      ),
    ).rejects.toThrow(/citations/);

    // Refused, so nothing was lost: the Citation still opens v1 at its
    // passage, and still names the same chunk.
    const afterRefusal = await follow(session, notebookId, citation);
    expect(afterRefusal.statusCode).toBe(200);
    expect(afterRefusal.body.markdown.slice(citation.charStart!, citation.charEnd!)).toBe(
      expectedChunkText('fourteen weeks'),
    );
    const [citationNow] = (await readThread(session, notebookId, threadId)).filter(
      (m) => m.role === 'assistant',
    )[0].citations;
    expect(citationNow.chunkId).toBe(citation.chunkId);

    // And the current Version is unaffected by the failed re-chunk of the old
    // one: search still answers from v2.
    const hits = await search(session, notebookId, 'six weeks');
    expect(hits).toHaveLength(1);
    expect(hits[0].match.versionId).toBe(v2);
  });
});
