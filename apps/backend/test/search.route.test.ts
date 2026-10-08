import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { createOpenRouterEmbedder } from '../src/llm/embeddings.js';
import { EMBEDDING_DIMENSIONS } from '../src/llm/models.js';

/**
 * A unit vector pointing along one axis of the embedding space: 1 at
 * `index`, 0 everywhere else.
 *
 * Real Qwen3-Embedding-4B vectors come back L2-normalised (see
 * `docs/ingestion-embeddings.md`), and these are too, so the arithmetic the
 * route does is the arithmetic it does in production. Using the basis
 * vectors makes every expected score a known-good literal rather than
 * something recomputed the way the code computes it: cosine similarity
 * between two distinct axes is exactly 0, and between an axis and itself
 * exactly 1.
 */
function axis(index: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
}

/**
 * A unit vector whose cosine similarity to `axis(0)` is exactly `toAxis0`:
 * `toAxis0` along axis 0, the rest along `otherAxis`. Lets a test place
 * Documents at known distances from one query without any arithmetic that
 * mirrors the route's own.
 */
function blend(toAxis0: number, otherAxis: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = toAxis0;
  vector[otherAxis] = Math.sqrt(1 - toAxis0 * toAxis0);
  return vector;
}

// Seam-1 test (per NBK-1's testing decisions, and explicitly called for by
// NBK-9's acceptance criteria): drive the real Fastify app through
// app.inject() against a real Postgres+pgvector container with seeded
// chunks, stubbing only OpenRouter — and stubbing it at its `fetch`
// boundary, not at the `Embedder` seam above it, so the query's embedding
// request is built and parsed by the real code and only the network is fake.
// Same choice the stage-2 and stage-3 job tests make.
describe('Search routes', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: FastifyInstance;

  /**
   * What the stubbed OpenRouter returns for a given query string. Keyed by
   * the query text so one app (and so one container) serves every case
   * below, each one deciding where in the embedding space its query lands.
   */
  const queryVectors = new Map<string, number[]>();
  /** Every embeddings request body the route caused, newest last. */
  const embeddingRequests: { model: string; input: string[] }[] = [];

  const stubFetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
    embeddingRequests.push(body);
    const data = body.input.map((text, index) => {
      const vector = queryVectors.get(text);
      if (!vector) throw new Error(`The test has no stubbed embedding for the query "${text}".`);
      return { index, embedding: vector };
    });
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
    app = await buildApp({
      pool,
      embed: createOpenRouterEmbedder({
        apiKey: 'test-key',
        model: 'qwen/qwen3-embedding-4b',
        fetch: stubFetch,
      }),
    });
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
  });

  /** Registers a fresh user and logs in, returning their session cookie value. */
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

  interface SeededVersion {
    /** Where this Version sits in the Ingestion pipeline (GLOSSARY.md). */
    status: string;
    /** The Abstract — what a search result shows. Null before stage 2 ran. */
    abstract?: string | null;
    /** One embedding per Chunk of this Version. */
    chunks?: number[][];
    deleted?: boolean;
    /** The Converted Markdown; defaults to a placeholder no Chunk is found in. */
    markdown?: string;
  }

  /**
   * Seeds a Document with the given Versions (oldest first) and their
   * Chunks, writing the rows ingestion would have written. Deliberately
   * direct SQL rather than driving the pipeline: this test is about what
   * search does with stored Chunks, and the pipeline that writes them is
   * already covered at seam 2 by `embed-chunks.job.test.ts`.
   */
  async function seedDocument(
    notebookId: string,
    filename: string,
    versions: SeededVersion[],
    options: { deleted?: boolean } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO documents (notebook_id, filename, deleted_at) VALUES ($1, $2, $3) RETURNING id',
      [notebookId, filename, options.deleted ? new Date() : null],
    );
    const documentId = rows[0].id;

    for (const [i, version] of versions.entries()) {
      const { rows: versionRows } = await pool.query<{ id: string }>(
        `INSERT INTO document_versions
           (document_id, version_number, mime_type, size_bytes, storage_key,
            markdown, ingestion_status, abstract, deleted_at)
         VALUES ($1, $2, 'text/markdown', 100, $3, $7, $4, $5, $6)
         RETURNING id`,
        [
          documentId,
          i + 1,
          `seed/${documentId}/${i + 1}`,
          version.status,
          version.abstract ?? null,
          version.deleted ? new Date() : null,
          version.markdown ?? 'seeded',
        ],
      );
      const versionId = versionRows[0].id;

      for (const [chunkIndex, embedding] of (version.chunks ?? []).entries()) {
        await pool.query(
          `INSERT INTO chunks (document_version_id, chunk_index, heading_path, text, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [
            versionId,
            chunkIndex,
            ['Seeded'],
            `chunk ${chunkIndex} of ${filename}`,
            `[${embedding.join(',')}]`,
          ],
        );
      }
    }

    return documentId;
  }

  async function search(session: string, notebookId: string, q: string, limit?: number) {
    const query = new URLSearchParams({
      q,
      ...(limit === undefined ? {} : { limit: String(limit) }),
    });
    return app.inject({
      method: 'GET',
      url: `/notebooks/${notebookId}/search?${query.toString()}`,
      cookies: { session },
    });
  }

  it('rejects an unauthenticated search with 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/notebooks/00000000-0000-0000-0000-000000000000/search?q=anything',
    });

    expect(response.statusCode).toBe(401);
  });

  it("ranks Documents by their best-matching Chunk and returns each one's Abstract", async () => {
    const session = await loginAsNewUser('searcher1@example.com');
    const notebookId = await createNotebook(session, 'Planets');

    // "mars.md" owns axis 0 and "venus.md" axis 1, so a query on axis 0 is
    // an exact match for the first and orthogonal to the second.
    await seedDocument(notebookId, 'mars.md', [
      { status: 'ready', abstract: 'Everything known about Mars.', chunks: [axis(0)] },
    ]);
    await seedDocument(notebookId, 'venus.md', [
      { status: 'ready', abstract: 'Everything known about Venus.', chunks: [axis(1)] },
    ]);
    queryVectors.set('the red planet', axis(0));

    const response = await search(session, notebookId, 'the red planet');

    expect(response.statusCode).toBe(200);
    const results = response.json() as { filename: string; abstract: string; score: number }[];
    expect(results.map((r) => r.filename)).toEqual(['mars.md', 'venus.md']);
    expect(results.map((r) => r.abstract)).toEqual([
      'Everything known about Mars.',
      'Everything known about Venus.',
    ]);
    expect(results[0].score).toBeCloseTo(1, 5);
    expect(results[1].score).toBeCloseTo(0, 5);
  });

  // NBK-96: a result opens at its best-matching passage, so the response names
  // that Chunk and its range in the Version's Converted Markdown — the same
  // pin a Citation carries.
  it("names each Document's best-matching Chunk and where it sits in the Converted Markdown", async () => {
    const session = await loginAsNewUser('searcher-match@example.com');
    const notebookId = await createNotebook(session, 'Ranges');
    const markdown =
      '# Atlas\n\nchunk 0 of atlas.md\n\nchunk 1 of atlas.md\n\nchunk 2 of atlas.md\n';
    const documentId = await seedDocument(notebookId, 'atlas.md', [
      { status: 'ready', chunks: [axis(0), axis(1), axis(2)], markdown },
    ]);
    queryVectors.set('the middle', axis(1));

    const [result] = (await search(session, notebookId, 'the middle')).json() as {
      latestVersion: { id: string };
      match: { versionId: string; chunkId: string; charStart: number; charEnd: number };
    }[];

    const { rows } = await pool.query<{ id: string }>(
      `SELECT c.id FROM chunks c JOIN document_versions v ON v.id = c.document_version_id
       WHERE v.document_id = $1 AND c.chunk_index = 1`,
      [documentId],
    );
    const at = markdown.indexOf('chunk 1 of atlas.md');
    expect(result.match).toEqual({
      versionId: result.latestVersion.id,
      chunkId: rows[0].id,
      charStart: at,
      charEnd: at + 'chunk 1 of atlas.md'.length,
    });
  });

  it('gives a best Chunk not found in the Converted Markdown no range', async () => {
    const session = await loginAsNewUser('searcher-nomatch@example.com');
    const notebookId = await createNotebook(session, 'No ranges');
    await seedDocument(notebookId, 'loose.md', [{ status: 'ready', chunks: [axis(0)] }]);
    queryVectors.set('loose', axis(0));

    const [result] = (await search(session, notebookId, 'loose')).json() as {
      match: { charStart: number | null; charEnd: number | null };
    }[];

    expect(result.match.charStart).toBeNull();
    expect(result.match.charEnd).toBeNull();
  });

  it('embeds the query itself, through the configured embedding model', async () => {
    const session = await loginAsNewUser('searcher2@example.com');
    const notebookId = await createNotebook(session, 'One Document');
    await seedDocument(notebookId, 'only.md', [
      { status: 'ready', abstract: 'The only one.', chunks: [axis(0)] },
    ]);
    queryVectors.set('a very particular question', axis(0));
    embeddingRequests.length = 0;

    await search(session, notebookId, 'a very particular question');

    expect(embeddingRequests).toEqual([
      { model: 'qwen/qwen3-embedding-4b', input: ['a very particular question'] },
    ]);
  });

  it('returns a Document once, however many of its Chunks match', async () => {
    const session = await loginAsNewUser('searcher3@example.com');
    const notebookId = await createNotebook(session, 'Rolled up');

    // Three Chunks, two of them on the query's axis: a Chunk-level result
    // set would list this Document twice.
    await seedDocument(notebookId, 'long.md', [
      { status: 'ready', abstract: 'A long document.', chunks: [axis(0), axis(1), axis(0)] },
    ]);
    queryVectors.set('rolled up', axis(0));

    const response = await search(session, notebookId, 'rolled up');

    const results = response.json() as { id: string; filename: string; score: number }[];
    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe('long.md');
    // Scored by its *best* Chunk, not its average.
    expect(results[0].score).toBeCloseTo(1, 5);
  });

  // GLOSSARY.md: "'ready' is the end of the pipeline and the only status
  // that means a Document is safe to rely on for chat."
  it("searches only Document Versions that are 'ready'", async () => {
    const session = await loginAsNewUser('searcher4@example.com');
    const notebookId = await createNotebook(session, 'Mid-ingestion');

    await seedDocument(notebookId, 'ready.md', [
      { status: 'ready', abstract: 'Finished ingesting.', chunks: [axis(0)] },
    ]);
    // Same perfectly-matching Chunk, but this Version is still in stage 3.
    await seedDocument(notebookId, 'indexing.md', [
      { status: 'indexing', abstract: 'Still ingesting.', chunks: [axis(0)] },
    ]);
    await seedDocument(notebookId, 'failed.md', [
      { status: 'failed', abstract: 'Gave up ingesting.', chunks: [axis(0)] },
    ]);
    queryVectors.set('ready only', axis(0));

    const response = await search(session, notebookId, 'ready only');

    const results = response.json() as { filename: string }[];
    expect(results.map((r) => r.filename)).toEqual(['ready.md']);
  });

  it('does not fall back to an older ready Version when the latest one is still ingesting', async () => {
    const session = await loginAsNewUser('searcher5@example.com');
    const notebookId = await createNotebook(session, 'Re-uploaded');

    // v1 finished and matches the query exactly; v2 is a re-upload still in
    // stage 3. Answering from v1 would serve content the user has already
    // replaced, so this Document must be absent entirely.
    await seedDocument(notebookId, 'superseded.md', [
      { status: 'ready', abstract: 'The old content.', chunks: [axis(0)] },
      { status: 'indexing', abstract: null, chunks: [] },
    ]);
    queryVectors.set('superseded', axis(0));

    const response = await search(session, notebookId, 'superseded');

    expect(response.json()).toEqual([]);
  });

  // GLOSSARY.md: "only a Document's latest Version is searched in chat;
  // older Versions stay retrievable through Citations".
  it("matches only the latest Version's Chunks", async () => {
    const session = await loginAsNewUser('searcher6@example.com');
    const notebookId = await createNotebook(session, 'Two ready Versions');

    // Both Versions are ready. v1's Chunk is an exact match for the query
    // and v2's is orthogonal to it — so a score near 1 would prove the old
    // Version's Chunks were searched.
    await seedDocument(notebookId, 'revised.md', [
      { status: 'ready', abstract: 'The first draft.', chunks: [axis(0)] },
      { status: 'ready', abstract: 'The current draft.', chunks: [axis(1)] },
    ]);
    queryVectors.set('what the first draft said', axis(0));

    const response = await search(session, notebookId, 'what the first draft said');

    const results = response.json() as { abstract: string; score: number }[];
    expect(results).toHaveLength(1);
    // The latest Version's Abstract, scored against the latest Version's
    // Chunks.
    expect(results[0].abstract).toBe('The current draft.');
    expect(results[0].score).toBeCloseTo(0, 5);
  });

  it('ignores a deleted latest Version and searches the newest surviving one', async () => {
    const session = await loginAsNewUser('searcher7@example.com');
    const notebookId = await createNotebook(session, 'Deleted Version');

    await seedDocument(notebookId, 'partly-deleted.md', [
      { status: 'ready', abstract: 'The surviving Version.', chunks: [axis(0)] },
      { status: 'ready', abstract: 'The deleted Version.', chunks: [axis(1)], deleted: true },
    ]);
    queryVectors.set('surviving', axis(0));

    const response = await search(session, notebookId, 'surviving');

    const results = response.json() as { abstract: string; score: number }[];
    expect(results).toHaveLength(1);
    expect(results[0].abstract).toBe('The surviving Version.');
    expect(results[0].score).toBeCloseTo(1, 5);
  });

  it('returns nothing from other Notebooks or from soft-deleted Documents', async () => {
    const session = await loginAsNewUser('searcher8@example.com');
    const notebookId = await createNotebook(session, 'Mine');
    const otherNotebookId = await createNotebook(session, "Someone else's");

    await seedDocument(
      notebookId,
      'deleted.md',
      [{ status: 'ready', abstract: 'Soft-deleted.', chunks: [axis(0)] }],
      { deleted: true },
    );
    await seedDocument(otherNotebookId, 'elsewhere.md', [
      { status: 'ready', abstract: 'In another Notebook.', chunks: [axis(0)] },
    ]);
    queryVectors.set('scoping', axis(0));

    const response = await search(session, notebookId, 'scoping');

    expect(response.json()).toEqual([]);
  });

  it("returns 404 for a Notebook that doesn't exist", async () => {
    const session = await loginAsNewUser('searcher9@example.com');
    queryVectors.set('nowhere', axis(0));

    const response = await search(session, '00000000-0000-0000-0000-000000000000', 'nowhere');

    expect(response.statusCode).toBe(404);
  });

  it('rejects a blank query with 400', async () => {
    const session = await loginAsNewUser('searcher10@example.com');
    const notebookId = await createNotebook(session, 'Blank query');

    const response = await app.inject({
      method: 'GET',
      url: `/notebooks/${notebookId}/search?q=%20%20`,
      cookies: { session },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns at most `limit` Documents, best first', async () => {
    const session = await loginAsNewUser('searcher11@example.com');
    const notebookId = await createNotebook(session, 'Many Documents');

    // Axis 0 is the query. Each Document's Chunk is a blend of axis 0 and
    // its own axis, weighted so "near.md" is closest and "far.md" furthest:
    // cosine similarity to axis 0 is just the axis-0 component.
    await seedDocument(notebookId, 'near.md', [
      { status: 'ready', abstract: 'Closest.', chunks: [blend(0.9, 1)] },
    ]);
    await seedDocument(notebookId, 'middle.md', [
      { status: 'ready', abstract: 'In between.', chunks: [blend(0.6, 2)] },
    ]);
    await seedDocument(notebookId, 'far.md', [
      { status: 'ready', abstract: 'Furthest.', chunks: [blend(0.2, 3)] },
    ]);
    queryVectors.set('limited', axis(0));

    const all = await search(session, notebookId, 'limited');
    expect((all.json() as { filename: string }[]).map((r) => r.filename)).toEqual([
      'near.md',
      'middle.md',
      'far.md',
    ]);

    const limited = await search(session, notebookId, 'limited', 2);
    expect((limited.json() as { filename: string }[]).map((r) => r.filename)).toEqual([
      'near.md',
      'middle.md',
    ]);
  });

  it('answers 503 when no embedding model is configured', async () => {
    const session = await loginAsNewUser('searcher12@example.com');
    const notebookId = await createNotebook(session, 'No key');
    // The same app, built the way `server.ts` builds it with no
    // OPENROUTER_API_KEY: the route is still there, and says why it can't
    // answer rather than 404-ing as if search didn't exist.
    const keyless = await buildApp({ pool });

    const response = await keyless.inject({
      method: 'GET',
      url: `/notebooks/${notebookId}/search?q=anything`,
      cookies: { session },
    });

    expect(response.statusCode).toBe(503);
    expect((response.json() as { message: string }).message).toContain('OPENROUTER_API_KEY');
    await keyless.close();
  });
});
