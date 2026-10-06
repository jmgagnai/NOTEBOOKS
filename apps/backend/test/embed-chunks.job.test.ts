import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import {
  createAppEventSubscriber,
  type AppEvent,
  type AppEventSubscriber,
} from '../src/events/bus.js';
import { createOpenRouterEmbedder } from '../src/llm/embeddings.js';
import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '../src/llm/models.js';
import { runEmbedChunksJob } from '../src/ingestion/embed-chunks.js';

/**
 * Seam-2 tests for ingestion stage 3 (NBK-8) — the same seam as
 * test/summarize-document.job.test.ts: invoke the pg_boss job handler
 * directly with a constructed payload, against a real Postgres with pgvector,
 * and assert on the resulting rows and the app events actually published over
 * LISTEN/NOTIFY.
 *
 * OpenRouter is stubbed at its *HTTP* boundary, not at the module boundary:
 * the job runs the real `createOpenRouterEmbedder` with a stub `fetch`, so
 * request construction (the embeddings path, the auth header, the model id,
 * the batched `input` array) and response parsing are under test here too,
 * and only the network itself is fake. No test makes a real OpenRouter call.
 *
 * No MinIO container: like stage 2, stage 3 reads the Converted Markdown off
 * the Document Version — per GLOSSARY.md "the single input every later Stage
 * ... reads from" — so object storage is not in this stage's path at all.
 */
describe('embed-chunks job', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let pool: Pool;
  let subscriber: AppEventSubscriber;
  let received: AppEvent[];
  let stopCollecting: () => void;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = createPool(pgContainer.getConnectionUri());
    // The app's own migrations assume the extension is already enabled — in a
    // real deployment infra/postgres/init/001-pgvector.sql does it.
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await runMigrations(pool);
    subscriber = await createAppEventSubscriber(pgContainer.getConnectionUri());
  }, 180_000);

  afterAll(async () => {
    stopCollecting?.();
    await subscriber.close();
    await pool.end();
    await pgContainer.stop();
  });

  beforeEach(() => {
    stopCollecting?.();
    received = [];
    stopCollecting = subscriber.subscribe((event) => received.push(event));
  });

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
  }

  /**
   * Inserts the exact state ingestion stage 2 leaves behind: a Document
   * Version at "summarized", carrying the Converted Markdown stage 3 chunks.
   */
  async function seedSummarizedVersion(filename: string, markdown: string): Promise<SeededVersion> {
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
    const { rows: versionRows } = await pool.query<{ id: string }>(
      `INSERT INTO document_versions
         (document_id, version_number, mime_type, size_bytes, storage_key,
          ingestion_status, markdown, converted_at, summarized_at, abstract)
       VALUES ($1, 1, 'text/markdown', $2, $3, 'summarized', $4, now(), now(), 'An abstract.')
       RETURNING id`,
      [
        documentId,
        Buffer.byteLength(markdown),
        `notebooks/${notebookId}/${documentId}-${filename}`,
        markdown,
      ],
    );
    return { notebookId, documentId, versionId: versionRows[0].id };
  }

  async function readVersion(versionId: string) {
    const { rows } = await pool.query<{
      ingestion_status: string;
      markdown: string | null;
      abstract: string | null;
      ingestion_error: string | null;
      embedded_at: Date | null;
    }>(
      `SELECT ingestion_status, markdown, abstract, ingestion_error, embedded_at
       FROM document_versions WHERE id = $1`,
      [versionId],
    );
    return rows[0];
  }

  interface StoredChunk {
    chunkIndex: number;
    headingPath: string[];
    text: string;
    dimensions: number;
    embedding: number[];
  }

  /**
   * Reads back the stored chunks of one Document Version, in order.
   *
   * `vector_dims` and the vector's own text form come straight from pgvector,
   * so what is asserted is what the database actually holds in a `vector`
   * column — not a JavaScript array the job happened to hand over.
   */
  async function readChunks(versionId: string): Promise<StoredChunk[]> {
    const { rows } = await pool.query<{
      chunk_index: number;
      heading_path: string[];
      text: string;
      dims: number;
      embedding: string;
    }>(
      `SELECT chunk_index, heading_path, text, vector_dims(embedding) AS dims, embedding::text AS embedding
       FROM chunks WHERE document_version_id = $1 ORDER BY chunk_index`,
      [versionId],
    );
    return rows.map((row) => ({
      chunkIndex: row.chunk_index,
      headingPath: row.heading_path,
      text: row.text,
      dimensions: Number(row.dims),
      // pgvector's text form is `[1,2,3]`, which is also valid JSON.
      embedding: JSON.parse(row.embedding) as number[],
    }));
  }

  /** One recorded OpenRouter embeddings HTTP call, decoded. */
  interface RecordedCall {
    url: string;
    authorization: string | null;
    model: string;
    input: string[];
  }

  /**
   * A stub standing exactly where the network does, scripting one vector per
   * input string.
   *
   * The scripted vector is mostly zeroes with a marker in its first slot
   * derived from the input text, so a test can prove the vector stored
   * against a chunk is the one the API returned *for that chunk* — which is
   * the thing batching could silently get wrong.
   */
  function stubEmbeddings(vectorFor: (text: string) => number[] = markerVector) {
    const calls: RecordedCall[] = [];
    const fetchStub: typeof globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model: string;
        input: string | string[];
      };
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      const texts = Array.isArray(body.input) ? body.input : [body.input];
      calls.push({
        url: String(input),
        authorization: headers.get('authorization'),
        model: body.model,
        input: texts,
      });
      return new Response(
        JSON.stringify({
          object: 'list',
          model: 'Qwen/Qwen3-Embedding-4B',
          data: texts.map((text, index) => ({
            object: 'embedding',
            index,
            embedding: vectorFor(text),
          })),
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    return { calls, fetchStub };
  }

  /** A stable, text-derived marker in slot 0 of an otherwise zero vector. */
  function marker(text: string): number {
    let hash = 0;
    for (const char of text) hash = (hash * 31 + char.codePointAt(0)!) % 100_000;
    return hash;
  }

  function markerVector(text: string): number[] {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    vector[0] = marker(text);
    return vector;
  }

  function depsWith(fetchStub: typeof globalThis.fetch) {
    return {
      pool,
      embed: createOpenRouterEmbedder({
        apiKey: 'test-key',
        model: DEFAULT_EMBEDDING_MODEL,
        fetch: fetchStub,
      }),
    };
  }

  it('chunks the Converted Markdown, embeds each chunk, and leaves the Version ready', async () => {
    const seeded = await seedSummarizedVersion(
      'handbook.md',
      '# Field Handbook\n\nSoil sampling begins with a clean auger.\n',
    );

    const { calls, fetchStub } = stubEmbeddings();

    await runEmbedChunksJob(depsWith(fetchStub), {
      payload: { documentId: seeded.documentId, versionId: seeded.versionId },
      willRetry: false,
    });

    const version = await readVersion(seeded.versionId);
    expect(version.ingestion_status).toBe('ready');
    expect(version.ingestion_error).toBeNull();
    expect(version.embedded_at).not.toBeNull();
    // Stage 3's inputs and stage 2's outputs must both survive it untouched.
    expect(version.markdown).toContain('Soil sampling');
    expect(version.abstract).toBe('An abstract.');

    const chunks = await readChunks(seeded.versionId);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].text).toContain('Soil sampling begins with a clean auger.');
    // The heading path is what a Citation will later surface (GLOSSARY.md).
    expect(chunks[0].headingPath).toEqual(['Field Handbook']);
    // The column is sized to the dimension Qwen3-Embedding-4B actually
    // returns on OpenRouter, confirmed against the live API before the
    // migration was written (NBK-1: "confirm this value ... rather than
    // assuming a number").
    expect(chunks[0].dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(chunks[0].embedding[0]).toBe(marker(chunks[0].text));

    // The real embedder built this call, not a stub: OpenRouter's
    // OpenAI-compatible embeddings path, the key as a bearer token, and the
    // model fixed in server-side configuration (NBK-1 puts a user-facing
    // model picker out of scope).
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(calls[0].authorization).toBe('Bearer test-key');
    expect(calls[0].model).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(calls[0].input).toEqual([chunks[0].text]);

    const events = await waitForEvents(
      (all) =>
        all.filter((e) => (e.data as { versionId?: string }).versionId === seeded.versionId)
          .length >= 2,
    );
    const mine = events.filter(
      (e) => (e.data as { versionId?: string }).versionId === seeded.versionId,
    );
    expect(mine.map((e) => (e.data as { status?: string }).status)).toEqual(['indexing', 'ready']);
    expect(mine[0].type).toBe('document-version-status-changed');
    expect(mine[0].topic).toBe(`notebook:${seeded.notebookId}`);
    expect(mine[1].data).toMatchObject({
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      status: 'ready',
      filename: 'handbook.md',
    });
  });

  /** `count` paragraphs of distinguishable prose, as one section's body. */
  function prose(marker: string, count: number): string {
    return Array.from(
      { length: count },
      (_, i) =>
        `Paragraph ${i + 1} of the ${marker} material. It runs to a couple of sentences so that the ` +
        `recursive split has real paragraph and sentence boundaries to prefer over cutting mid-word.`,
    ).join('\n\n');
  }

  /**
   * Where each chunk sits in the text it came from, found by searching rather
   * than by trusting the chunker's own bookkeeping.
   *
   * Together with the assertions below this pins the contract a
   * `RecursiveCharacterTextSplitter` has to meet: the chunks *tile* their
   * section — start at its beginning, end at its end, never leave a gap, and
   * each one begins inside the one before it (that is the overlap).
   */
  function locate(content: string, texts: string[]): { start: number; end: number }[] {
    const spans: { start: number; end: number }[] = [];
    let from = 0;
    for (const text of texts) {
      const start = content.indexOf(text, from);
      if (start === -1)
        throw new Error(
          `Chunk text is not a contiguous slice of its section: ${text.slice(0, 80)}...`,
        );
      spans.push({ start, end: start + text.length });
      // Next chunk starts after this one started, but may start before it
      // ended — that overlap is the point.
      from = start + 1;
    }
    return spans;
  }

  it('splits a section longer than the chunk size into overlapping chunks that tile it', async () => {
    const content = prose('drilling', 20);
    const seeded = await seedSummarizedVersion('drilling.md', `# Drilling Manual\n\n${content}\n`);
    expect(content.length).toBeGreaterThan(3000);

    const { calls, fetchStub } = stubEmbeddings();
    await runEmbedChunksJob(depsWith(fetchStub), {
      payload: { documentId: seeded.documentId, versionId: seeded.versionId },
      willRetry: false,
    });

    expect((await readVersion(seeded.versionId)).ingestion_status).toBe('ready');

    const chunks = await readChunks(seeded.versionId);
    expect(chunks.length).toBeGreaterThan(3);

    // NBK-1's chunk_size=1000: no chunk exceeds it.
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1000);
      expect(chunk.text.trim()).not.toBe('');
      // Every chunk of one section carries that section's heading path, so a
      // Citation into any of them can say where it points.
      expect(chunk.headingPath).toEqual(['Drilling Manual']);
    }
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));

    const spans = locate(
      content,
      chunks.map((c) => c.text),
    );
    // The chunks cover the whole section, start to end, with no gap...
    expect(spans[0].start).toBe(0);
    expect(spans[spans.length - 1].end).toBe(content.length);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i].start).toBeLessThanOrEqual(spans[i - 1].end);
      // ...and each chunk begins *inside* the one before it, which is
      // chunk_overlap=150 doing its job: a sentence that straddles a cut is
      // still whole in one of the two chunks.
      expect(spans[i].start).toBeLessThan(spans[i - 1].end);
      expect(spans[i].start).toBeGreaterThan(spans[i - 1].start);
      const overlap = spans[i - 1].end - spans[i].start;
      expect(overlap).toBeGreaterThan(0);
      expect(overlap).toBeLessThanOrEqual(150);
    }

    // Every chunk got its own vector, and the right one.
    for (const chunk of chunks) {
      expect(chunk.dimensions).toBe(EMBEDDING_DIMENSIONS);
      expect(chunk.embedding[0]).toBe(marker(chunk.text));
    }
    // One request for all of them: OpenRouter's embeddings endpoint takes an
    // array `input`, and a 200-page document is far too many chunks for one
    // round trip each.
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual(chunks.map((c) => c.text));
  });

  /**
   * Found by running stage 3 against the real OpenRouter API over this repo's
   * own `docs/ingestion-summaries.md`, not by the suite: one chunk came back
   * at 1061 characters, over NBK-1's chunk_size=1000.
   *
   * The cause is the overlap. A chunk that ends on a long paragraph carries
   * that paragraph's 150-character tail into the next chunk, and if the next
   * paragraph is itself near the full chunk size, tail + paragraph exceeds
   * the budget. Alternating long and short paragraphs is the shape that
   * triggers it — which is what a real document's prose-then-aside rhythm
   * looks like.
   *
   * It matters because the chunk size is the budget every downstream prompt
   * is built on: a retrieval pass that packs N chunks into a context window
   * computes what fits from that number.
   */
  it('keeps every chunk inside the chunk size even when the overlap lands on a long paragraph', async () => {
    const long = `A long paragraph. ${'x'.repeat(880)}`;
    const short = `A short aside. ${'y'.repeat(100)}`;
    const content = [long, short, long, short, long].join('\n\n');
    const seeded = await seedSummarizedVersion('mixed.md', `# Mixed\n\n${content}\n`);

    const { fetchStub } = stubEmbeddings();
    await runEmbedChunksJob(depsWith(fetchStub), {
      payload: { documentId: seeded.documentId, versionId: seeded.versionId },
      willRetry: false,
    });

    const chunks = await readChunks(seeded.versionId);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1000);
    }
    // The cap is not bought by dropping content: the chunks still tile the
    // section end to end.
    const spans = locate(
      content,
      chunks.map((c) => c.text),
    );
    expect(spans[0].start).toBe(0);
    expect(spans[spans.length - 1].end).toBe(content.length);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i].start).toBeLessThanOrEqual(spans[i - 1].end);
    }
  });

  it('gives every chunk the heading path of the section it came from', async () => {
    const markdown = [
      '# Annual Report 2025',
      '',
      'The board presents the results for the year.',
      '',
      '## 2. Distribution network',
      '',
      '### 2.1 Europe',
      '',
      prose('europe', 10),
      '',
      '## Risks',
      '',
      'Commodity prices remain volatile at 12.4M exposure.',
      '',
    ].join('\n');
    const seeded = await seedSummarizedVersion('annual-report.md', markdown);

    const { fetchStub } = stubEmbeddings();
    await runEmbedChunksJob(depsWith(fetchStub), {
      payload: { documentId: seeded.documentId, versionId: seeded.versionId },
      willRetry: false,
    });

    const chunks = await readChunks(seeded.versionId);
    const paths = chunks.map((c) => c.headingPath);

    // "## 2. Distribution network" has no body of its own, so it contributes
    // no chunk — there is nothing to embed — but it still appears in its
    // child's path, which is how a Citation into 2.1 can say where it sits.
    expect(paths).not.toContainEqual(['Annual Report 2025', '2. Distribution network']);
    expect(paths).toContainEqual(['Annual Report 2025', '2. Distribution network', '2.1 Europe']);
    expect(paths).toContainEqual(['Annual Report 2025']);
    expect(paths).toContainEqual(['Annual Report 2025', 'Risks']);

    // No chunk straddles two sections: the long 2.1 Europe section is split
    // several times, and every one of those pieces carries 2.1's path and
    // none of the neighbouring text.
    const europe = chunks.filter((c) => c.headingPath.at(-1) === '2.1 Europe');
    expect(europe.length).toBeGreaterThan(1);
    for (const chunk of europe) {
      expect(chunk.text).not.toContain('Commodity prices');
      expect(chunk.text).not.toContain('The board presents');
    }

    // The short sections stay whole rather than being padded or merged with
    // their neighbours.
    const risks = chunks.filter((c) => c.headingPath.at(-1) === 'Risks');
    expect(risks).toHaveLength(1);
    expect(risks[0].text).toBe('Commodity prices remain volatile at 12.4M exposure.');

    // Chunk order follows document order, which is what `chunk_index` means.
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    expect(paths[0]).toEqual(['Annual Report 2025']);
    expect(paths.at(-1)).toEqual(['Annual Report 2025', 'Risks']);
  });

  it('embeds in batches and pairs each vector with its own chunk by the index the API reports', async () => {
    const seeded = await seedSummarizedVersion('long.md', `# Long\n\n${prose('batching', 40)}\n`);

    const calls: RecordedCall[] = [];
    // Responses come back in reverse order, each entry still carrying its own
    // `index`. A client that trusted arrival order would attach every vector
    // to the wrong chunk — a wrong Citation nothing downstream could detect.
    const fetchStub: typeof globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; input: string[] };
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      calls.push({
        url: String(input),
        authorization: headers.get('authorization'),
        model: body.model,
        input: body.input,
      });
      const data = body.input
        .map((text, index) => ({ object: 'embedding', index, embedding: markerVector(text) }))
        .reverse();
      return new Response(
        JSON.stringify({ object: 'list', data, usage: { prompt_tokens: 1, total_tokens: 1 } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    await runEmbedChunksJob(
      {
        pool,
        embed: createOpenRouterEmbedder({
          apiKey: 'test-key',
          model: DEFAULT_EMBEDDING_MODEL,
          fetch: fetchStub,
          batchSize: 3,
        }),
      },
      { payload: { documentId: seeded.documentId, versionId: seeded.versionId }, willRetry: false },
    );

    const chunks = await readChunks(seeded.versionId);
    expect(chunks.length).toBeGreaterThan(6);
    expect((await readVersion(seeded.versionId)).ingestion_status).toBe('ready');

    // Several requests, none over the batch size, and together they carry
    // every chunk exactly once in document order.
    expect(calls.length).toBe(Math.ceil(chunks.length / 3));
    for (const call of calls) {
      expect(call.input.length).toBeLessThanOrEqual(3);
      expect(call.url).toBe('https://openrouter.ai/api/v1/embeddings');
    }
    expect(calls.flatMap((c) => c.input)).toEqual(chunks.map((c) => c.text));

    // And every stored vector is the one scripted for *that* chunk's text.
    for (const chunk of chunks) {
      expect(chunk.dimensions).toBe(EMBEDDING_DIMENSIONS);
      expect(chunk.embedding[0]).toBe(marker(chunk.text));
    }
  });

  it("replaces a Version's chunks on a re-run instead of accumulating them", async () => {
    const seeded = await seedSummarizedVersion('rerun.md', `# Rerun\n\n${prose('first', 20)}\n`);

    const { fetchStub } = stubEmbeddings();
    const invocation = {
      payload: { documentId: seeded.documentId, versionId: seeded.versionId },
      willRetry: false,
    };
    await runEmbedChunksJob(depsWith(fetchStub), invocation);
    const first = await readChunks(seeded.versionId);
    expect(first.length).toBeGreaterThan(3);

    // The Converted Markdown shrinks (a re-converted Version, say), so the
    // re-run produces strictly fewer chunks. An upsert would leave the
    // surplus behind — stale passages a Citation could still point at.
    await pool.query('UPDATE document_versions SET markdown = $2 WHERE id = $1', [
      seeded.versionId,
      '# Rerun\n\nJust one short paragraph now.\n',
    ]);
    await runEmbedChunksJob(depsWith(fetchStub), invocation);

    const second = await readChunks(seeded.versionId);
    expect(second).toHaveLength(1);
    expect(second[0].chunkIndex).toBe(0);
    expect(second[0].text).toBe('Just one short paragraph now.');
    expect((await readVersion(seeded.versionId)).ingestion_status).toBe('ready');
  });

  it('returns the Version to summarized when embedding fails and a retry is still pending', async () => {
    const seeded = await seedSummarizedVersion(
      'rate-limited.md',
      `# Limited\n\n${prose('limited', 4)}\n`,
    );

    const fetchStub: typeof globalThis.fetch = async () =>
      new Response('rate limit exceeded', {
        status: 429,
        headers: { 'content-type': 'text/plain' },
      });

    await expect(
      runEmbedChunksJob(
        {
          pool,
          embed: createOpenRouterEmbedder({
            apiKey: 'test-key',
            model: DEFAULT_EMBEDDING_MODEL,
            fetch: fetchStub,
            retries: 0,
          }),
        },
        {
          payload: { documentId: seeded.documentId, versionId: seeded.versionId },
          willRetry: true,
        },
      ),
    ).rejects.toThrow(/429/);

    const version = await readVersion(seeded.versionId);
    // Back to the status stage 3 *consumes*, not "failed" and not forward:
    // a retry is still coming, and it must find the state it expects.
    expect(version.ingestion_status).toBe('summarized');
    expect(version.ingestion_error).toMatch(/429/);
    expect(version.embedded_at).toBeNull();
    // Stage 2's output is untouched, so the retry costs no OpenRouter
    // generation calls.
    expect(version.abstract).toBe('An abstract.');
    expect(await readChunks(seeded.versionId)).toEqual([]);

    const events = await waitForEvents(
      (all) =>
        all.filter((e) => (e.data as { versionId?: string }).versionId === seeded.versionId)
          .length >= 2,
    );
    const mine = events.filter(
      (e) => (e.data as { versionId?: string }).versionId === seeded.versionId,
    );
    expect(mine.map((e) => (e.data as { status?: string }).status)).toEqual([
      'indexing',
      'summarized',
    ]);
    expect(mine[1].data).toMatchObject({ error: expect.stringMatching(/429/) });
  });

  it("marks the Version failed when embedding can't be retried", async () => {
    const seeded = await seedSummarizedVersion('broken.md', `# Broken\n\n${prose('broken', 4)}\n`);

    const fetchStub: typeof globalThis.fetch = async () =>
      new Response('no such model', { status: 404, headers: { 'content-type': 'text/plain' } });

    await expect(
      runEmbedChunksJob(
        {
          pool,
          embed: createOpenRouterEmbedder({
            apiKey: 'test-key',
            model: 'qwen/nope',
            fetch: fetchStub,
          }),
        },
        {
          payload: { documentId: seeded.documentId, versionId: seeded.versionId },
          willRetry: false,
        },
      ),
    ).rejects.toThrow(/404/);

    const version = await readVersion(seeded.versionId);
    expect(version.ingestion_status).toBe('failed');
    expect(version.ingestion_error).toMatch(/404/);
    // The Converted Markdown and the summaries survive a failed stage 3, so
    // re-driving it never costs a conversion or a regeneration.
    expect(version.markdown).toContain('Paragraph 1 of the broken material');
    expect(version.abstract).toBe('An abstract.');
    expect(await readChunks(seeded.versionId)).toEqual([]);
  });

  it("refuses a vector whose dimension doesn't match the column rather than storing it", async () => {
    const seeded = await seedSummarizedVersion(
      'wrong-dims.md',
      '# Wrong\n\nA single short section.\n',
    );

    // What swapping the embedding model for one of a different size looks
    // like. Per ADR-0002 that is "a real migration, not a config change", so
    // it has to fail loudly and name the dimension.
    const { fetchStub } = stubEmbeddings(() => new Array<number>(1024).fill(0.5));

    await expect(
      runEmbedChunksJob(depsWith(fetchStub), {
        payload: { documentId: seeded.documentId, versionId: seeded.versionId },
        willRetry: false,
      }),
    ).rejects.toThrow(/1024-dimension vector/);

    const version = await readVersion(seeded.versionId);
    expect(version.ingestion_status).toBe('failed');
    expect(version.ingestion_error).toMatch(new RegExp(`vector\\(${EMBEDDING_DIMENSIONS}\\)`));
    expect(await readChunks(seeded.versionId)).toEqual([]);
  });

  it('fails rather than embedding nothing when the Converted Markdown is missing', async () => {
    const seeded = await seedSummarizedVersion('empty.md', 'placeholder');
    await pool.query('UPDATE document_versions SET markdown = NULL WHERE id = $1', [
      seeded.versionId,
    ]);

    const { calls, fetchStub } = stubEmbeddings();

    await expect(
      runEmbedChunksJob(depsWith(fetchStub), {
        payload: { documentId: seeded.documentId, versionId: seeded.versionId },
        willRetry: false,
      }),
    ).rejects.toThrow(/no Converted Markdown/);

    expect(calls).toEqual([]);
    const version = await readVersion(seeded.versionId);
    expect(version.ingestion_status).toBe('failed');
    expect(await readChunks(seeded.versionId)).toEqual([]);
  });

  it('does nothing for a Document Version that no longer exists', async () => {
    const { calls, fetchStub } = stubEmbeddings();

    // A hard-deleted Version between enqueue and now: nothing to chunk and
    // nothing to retry, so the handler must not make pg_boss keep trying.
    await expect(
      runEmbedChunksJob(depsWith(fetchStub), {
        payload: {
          documentId: '11111111-1111-1111-1111-111111111111',
          versionId: '22222222-2222-2222-2222-222222222222',
        },
        willRetry: true,
      }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([]);
  });
});
