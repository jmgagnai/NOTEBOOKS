import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { createOpenRouterEmbedder } from '../src/llm/embeddings.js';
import { EMBEDDING_DIMENSIONS } from '../src/llm/models.js';
import { createOpenRouterCompleter } from '../src/llm/openrouter.js';

// Seam-1 test (per NBK-1's testing decisions, and explicitly called for by
// NBK-10's acceptance criteria): drive the real Fastify app through
// app.inject() against a real Postgres+pgvector container, stubbing only
// OpenRouter — and stubbing it at its `fetch` boundary, so the request
// building and response parsing in src/llm/* stay under test. Both calls the
// ask path makes are stubbed there: the query embedding and the chat
// completion.
//
// No MinIO container: chat reads the Converted Markdown's *chunks* and the
// Chat Snippet off Postgres, never object storage, so the only thing the
// tests have to arrange is rows.
describe('Chat routes', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
    app = await buildApp({ pool });
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

  // ---------------------------------------------------------------------
  // The ask/answer path's fixtures.
  // ---------------------------------------------------------------------

  // Embeddings are opaque numbers, so the tests pin them to something they
  // can reason about: one orthonormal basis vector per topic. A chunk about
  // revenue and a question about revenue both embed to e0, giving cosine
  // distance 0; anything else is a different axis, distance 1. That makes
  // "the right chunk ranked first" an assertion about retrieval rather than
  // about a particular embedding model's geometry.
  //
  // Unit vectors also match what the real model produces: Qwen3-Embedding-4B
  // returns L2-normalised vectors (verified live in NBK-8).
  const TOPICS = ['revenue', 'supply chain'];

  function vectorFor(text: string): number[] {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const topic = TOPICS.findIndex((t) => text.toLowerCase().includes(t));
    // An off-topic text gets its own axis, orthogonal to every topic.
    vector[topic >= 0 ? topic : TOPICS.length] = 1;
    return vector;
  }

  /**
   * Stubs OpenRouter at the `fetch` boundary — the seam NBK-1 names, and the
   * one that keeps the real request building and response parsing in
   * src/llm/* under test. Both calls the ask path makes land here: the query
   * embedding and the chat completion.
   */
  function openRouterStub(answer = 'Revenue was 12.4M in Q3.') {
    const embeddingRequests: string[][] = [];
    const completionRequests: { model: string; system: string; user: string }[] = [];

    const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      if (url.endsWith('/embeddings')) {
        const texts = (Array.isArray(body.input) ? body.input : [body.input]) as string[];
        embeddingRequests.push(texts);
        return json({ data: texts.map((text, index) => ({ index, embedding: vectorFor(text) })) });
      }
      if (url.endsWith('/chat/completions')) {
        const messages = body.messages as { role: string; content: string }[];
        completionRequests.push({
          model: body.model as string,
          system: messages.find((m) => m.role === 'system')!.content,
          user: messages.find((m) => m.role === 'user')!.content,
        });
        return json({ choices: [{ message: { content: answer } }] });
      }
      throw new Error(`The chat path called an unexpected OpenRouter endpoint: ${url}`);
    }) as typeof globalThis.fetch;

    return { embeddingRequests, completionRequests, stubFetch };
  }

  /**
   * Builds a second app over the same container with chat wired to the real
   * OpenRouter clients, their `fetch` replaced by the stub.
   */
  async function appWithChat(
    stubFetch: typeof globalThis.fetch,
    model = 'test/chat-model',
  ): Promise<FastifyInstance> {
    return buildApp({
      pool,
      chat: {
        complete: createOpenRouterCompleter({ apiKey: 'test-key', fetch: stubFetch, retries: 0 }),
        embed: createOpenRouterEmbedder({
          apiKey: 'test-key',
          model: 'test/embedding-model',
          fetch: stubFetch,
          retries: 0,
        }),
        model,
      },
    });
  }

  interface SeededDocument {
    filename: string;
    /** The Chat Snippet ingestion stage 2 generated for it. */
    chatSnippet: string;
    /** One chunk per entry; each is embedded with `vectorFor` on its text. */
    chunks: { text: string; headingPath?: string[] }[];
    /** Defaults to 'ready' — the only status chat is allowed to rely on. */
    status?: string;
    /** Extra, superseded Versions created *before* the latest one. */
    olderVersions?: { chunks: { text: string }[]; status?: string }[];
  }

  /**
   * Writes a Document straight into Postgres in the state ingestion would
   * have left it: a Version with its Chat Snippet and its embedded Chunks.
   *
   * Arranging rows directly rather than driving the pipeline is deliberate —
   * that the pipeline produces them is proven at seam 2
   * (test/embed-chunks.job.test.ts). Every *assertion* here still goes
   * through HTTP.
   */
  async function seedDocument(notebookId: string, spec: SeededDocument): Promise<void> {
    const { rows: docRows } = await pool.query<{ id: string }>(
      'INSERT INTO documents (notebook_id, filename) VALUES ($1, $2) RETURNING id',
      [notebookId, spec.filename],
    );
    const documentId = docRows[0].id;

    const versions = [
      ...(spec.olderVersions ?? []).map((v) => ({
        chunks: v.chunks.map((c) => ({ text: c.text, headingPath: [] as string[] })),
        status: v.status ?? 'ready',
      })),
      {
        chunks: spec.chunks.map((c) => ({ text: c.text, headingPath: c.headingPath ?? [] })),
        status: spec.status ?? 'ready',
      },
    ];

    for (const [index, version] of versions.entries()) {
      const { rows: versionRows } = await pool.query<{ id: string }>(
        `INSERT INTO document_versions
           (document_id, version_number, mime_type, size_bytes, storage_key,
            ingestion_status, markdown, chat_snippet)
         VALUES ($1, $2, 'text/markdown', 10, $3, $4, $5, $6)
         RETURNING id`,
        [
          documentId,
          index + 1,
          `${documentId}/${index + 1}`,
          version.status,
          version.chunks.map((c) => c.text).join('\n\n'),
          spec.chatSnippet,
        ],
      );
      const versionId = versionRows[0].id;

      for (const [chunkIndex, chunk] of version.chunks.entries()) {
        await pool.query(
          `INSERT INTO chunks (document_version_id, chunk_index, heading_path, text, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [
            versionId,
            chunkIndex,
            chunk.headingPath,
            chunk.text,
            `[${vectorFor(chunk.text).join(',')}]`,
          ],
        );
      }
    }
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

  describe('POST /notebooks/:notebookId/threads', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/notebooks/00000000-0000-0000-0000-000000000000/threads',
        payload: { title: 'Anonymous' },
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns 404 for a Notebook that doesn't exist", async () => {
      const session = await loginAsNewUser('thread-creator-404@example.com');

      const response = await app.inject({
        method: 'POST',
        url: '/notebooks/00000000-0000-0000-0000-000000000000/threads',
        cookies: { session },
        payload: { title: 'Nowhere' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('creates a Chat Thread recording its author, and lists it in the Notebook', async () => {
      const session = await loginAsNewUser('thread-author@example.com');
      const notebookId = await createNotebook(session, 'Chat Notebook');

      const response = await app.inject({
        method: 'POST',
        url: `/notebooks/${notebookId}/threads`,
        cookies: { session },
        payload: { title: 'Revenue questions' },
      });

      expect(response.statusCode).toBe(201);
      const thread = response.json() as {
        id: string;
        notebookId: string;
        title: string;
        author: { id: string; email: string };
      };
      expect(thread.title).toBe('Revenue questions');
      expect(thread.notebookId).toBe(notebookId);
      // Per GLOSSARY.md a Chat Thread is "started by one user (its author)".
      // That is attribution, not access control (ADR-0001) — but it has to
      // actually be recorded.
      expect(thread.author.email).toBe('thread-author@example.com');

      const listResponse = await app.inject({
        method: 'GET',
        url: `/notebooks/${notebookId}/threads`,
        cookies: { session },
      });
      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()).toEqual([thread]);
    });
  });

  describe('GET /notebooks/:notebookId/threads', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/notebooks/00000000-0000-0000-0000-000000000000/threads',
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns an empty list for a Notebook with no Chat Threads', async () => {
      const session = await loginAsNewUser('thread-lister-empty@example.com');
      const notebookId = await createNotebook(session, 'No chat yet');

      const response = await app.inject({
        method: 'GET',
        url: `/notebooks/${notebookId}/threads`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    // NBK-10: "list every thread in a Notebook regardless of who started it".
    // Per GLOSSARY.md a Chat Thread is "visible to every user who opens the
    // Notebook, the same as Documents" — so the listing must not be scoped
    // to the asking user, and each entry has to say whose it is.
    it('lists every Thread in the Notebook, whoever started it, each with its author', async () => {
      const alice = await loginAsNewUser('threads-alice@example.com');
      const bob = await loginAsNewUser('threads-bob@example.com');
      const notebookId = await createNotebook(alice, 'Shared chat');

      await app.inject({
        method: 'POST',
        url: `/notebooks/${notebookId}/threads`,
        cookies: { session: alice },
        payload: { title: 'Alice asks about revenue' },
      });
      await app.inject({
        method: 'POST',
        url: `/notebooks/${notebookId}/threads`,
        cookies: { session: bob },
        payload: { title: 'Bob asks about risk' },
      });

      // Read by Alice: she must see Bob's Thread too, attributed to Bob.
      const response = await app.inject({
        method: 'GET',
        url: `/notebooks/${notebookId}/threads`,
        cookies: { session: alice },
      });

      expect(response.statusCode).toBe(200);
      const threads = response.json() as Array<{ title: string; author: { email: string } }>;
      expect(
        threads.map((t) => [t.title, t.author.email]).sort((a, b) => a[0].localeCompare(b[0])),
      ).toEqual([
        ['Alice asks about revenue', 'threads-alice@example.com'],
        ['Bob asks about risk', 'threads-bob@example.com'],
      ]);
    });

    it('does not leak Threads from another Notebook', async () => {
      const session = await loginAsNewUser('threads-scoped@example.com');
      const mine = await createNotebook(session, 'Mine');
      const other = await createNotebook(session, 'Other');
      await app.inject({
        method: 'POST',
        url: `/notebooks/${other}/threads`,
        cookies: { session },
        payload: { title: 'Elsewhere' },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/notebooks/${mine}/threads`,
        cookies: { session },
      });

      expect(response.json()).toEqual([]);
    });
  });

  describe('PATCH /notebooks/:notebookId/threads/:threadId', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/notebooks/00000000-0000-0000-0000-000000000000/threads/00000000-0000-0000-0000-000000000000',
        payload: { title: 'Renamed' },
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns 404 for a Thread that doesn't exist", async () => {
      const session = await loginAsNewUser('rename-404@example.com');
      const notebookId = await createNotebook(session, 'Rename 404');

      const response = await app.inject({
        method: 'PATCH',
        url: `/notebooks/${notebookId}/threads/00000000-0000-0000-0000-000000000000`,
        cookies: { session },
        payload: { title: 'Renamed' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('renames a Thread, keeping its original author', async () => {
      const session = await loginAsNewUser('renamer@example.com');
      const notebookId = await createNotebook(session, 'Renaming');
      const created = await app.inject({
        method: 'POST',
        url: `/notebooks/${notebookId}/threads`,
        cookies: { session },
        payload: { title: 'Untitled' },
      });
      const { id: threadId } = created.json() as { id: string };

      const response = await app.inject({
        method: 'PATCH',
        url: `/notebooks/${notebookId}/threads/${threadId}`,
        cookies: { session },
        payload: { title: 'Q3 supply chain' },
      });

      expect(response.statusCode).toBe(200);
      const renamed = response.json() as { title: string; author: { email: string } };
      expect(renamed.title).toBe('Q3 supply chain');
      // Renaming is not re-authoring: the Thread's author is who *started*
      // it (GLOSSARY.md), so it must survive an edit by anyone.
      expect(renamed.author.email).toBe('renamer@example.com');
    });
  });

  // The heart of NBK-10: "sending a message retrieves relevant chunks from
  // the Notebook's latest-version Documents and returns one full-text answer
  // via OpenRouter (fixed model)".
  //
  // No streaming and no Citations here — NBK-11 and NBK-12 add those.
  describe('POST /notebooks/:notebookId/threads/:threadId/messages', () => {
    /** A Notebook with two ready Documents on two different topics. */
    async function seedNotebook(session: string, title: string): Promise<string> {
      const notebookId = await createNotebook(session, title);
      await seedDocument(notebookId, {
        filename: 'quarterly.md',
        chatSnippet: 'Quarterly report: FY26 revenue, margins and segment performance.',
        chunks: [
          {
            text: 'Revenue in Q3 was 12.4M, up 8% year on year.',
            headingPath: ['FY26', 'Revenue'],
          },
        ],
      });
      await seedDocument(notebookId, {
        filename: 'logistics.md',
        chatSnippet: 'Logistics review: supply chain lead times and carrier performance.',
        chunks: [{ text: 'Supply chain lead times lengthened to 14 weeks.' }],
      });
      return notebookId;
    }

    it('rejects an unauthenticated request with 401', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/notebooks/00000000-0000-0000-0000-000000000000/threads/00000000-0000-0000-0000-000000000000/messages',
        payload: { content: 'Hello?' },
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns 404 for a Thread that doesn't exist", async () => {
      const { stubFetch } = openRouterStub();
      const chatApp = await appWithChat(stubFetch);
      try {
        const session = await loginAsNewUser('ask-404@example.com');
        const notebookId = await createNotebook(session, 'Ask 404');

        const response = await chatApp.inject({
          method: 'POST',
          url: `/notebooks/${notebookId}/threads/00000000-0000-0000-0000-000000000000/messages`,
          cookies: { session },
          payload: { content: 'Anyone there?' },
        });

        expect(response.statusCode).toBe(404);
      } finally {
        await chatApp.close();
      }
    });

    it("answers a question from the Notebook's chunks, recording both messages against the asker", async () => {
      const stub = openRouterStub('Revenue in Q3 was 12.4M, an 8% increase year on year.');
      const chatApp = await appWithChat(stub.stubFetch);
      try {
        const session = await loginAsNewUser('asker@example.com');
        const notebookId = await seedNotebook(session, 'Grounded chat');
        const threadId = await startThread(session, notebookId, 'Revenue');

        const response = await chatApp.inject({
          method: 'POST',
          url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
          cookies: { session },
          payload: { content: 'What was revenue in Q3?' },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json() as {
          question: { role: string; content: string; askedBy: { email: string }; threadId: string };
          answer: { role: string; content: string; askedBy: { email: string } };
        };

        // One full-text answer, returned synchronously — not a stream, not a
        // job id to poll (NBK-11 upgrades the delivery, not the shape).
        expect(body.answer.role).toBe('assistant');
        expect(body.answer.content).toBe('Revenue in Q3 was 12.4M, an 8% increase year on year.');

        // Attribution on both rows: per GLOSSARY.md "every message in it
        // records which user asked it", and the asker of an answer is
        // whoever's question produced it.
        expect(body.question.role).toBe('user');
        expect(body.question.content).toBe('What was revenue in Q3?');
        expect(body.question.threadId).toBe(threadId);
        expect(body.question.askedBy.email).toBe('asker@example.com');
        expect(body.answer.askedBy.email).toBe('asker@example.com');

        // The question was embedded, once, to retrieve against.
        expect(stub.embeddingRequests).toEqual([['What was revenue in Q3?']]);

        // Exactly one generation call, on the server-fixed model — NBK-1 puts
        // a user-facing model picker out of scope.
        expect(stub.completionRequests).toHaveLength(1);
        const [completion] = stub.completionRequests;
        expect(completion.model).toBe('test/chat-model');

        // Grounding reached the model: the retrieved Chunk text verbatim
        // (GLOSSARY.md: a Chunk is "a verbatim, contiguous slice of the
        // Converted Markdown"), and the Chat Snippet — the artifact
        // GLOSSARY.md says is "written to be injected into the LLM's chat
        // context as grounding about that source".
        expect(completion.user).toContain('Revenue in Q3 was 12.4M, up 8% year on year.');
        expect(completion.user).toContain(
          'Quarterly report: FY26 revenue, margins and segment performance.',
        );
        // And it says which source each passage came from, so the model can
        // attribute rather than blend.
        expect(completion.user).toContain('quarterly.md');
        // The user's question is in the prompt too, not only the grounding.
        expect(completion.user).toContain('What was revenue in Q3?');

        // The on-topic chunk outranks the off-topic one.
        expect(completion.user.indexOf('Revenue in Q3 was 12.4M')).toBeLessThan(
          completion.user.indexOf('Supply chain lead times'),
        );
      } finally {
        await chatApp.close();
      }
    });

    it("carries the Thread's earlier messages into the next question", async () => {
      const stub = openRouterStub('It rose 8%.');
      const chatApp = await appWithChat(stub.stubFetch);
      try {
        const session = await loginAsNewUser('follow-up@example.com');
        const notebookId = await seedNotebook(session, 'Follow-up chat');
        const threadId = await startThread(session, notebookId, 'Revenue');

        await chatApp.inject({
          method: 'POST',
          url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
          cookies: { session },
          payload: { content: 'What was revenue in Q3?' },
        });
        await chatApp.inject({
          method: 'POST',
          url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
          cookies: { session },
          payload: { content: 'And how much did it change?' },
        });

        // A Thread is "a named sequence of messages" (GLOSSARY.md), so the
        // second question is asked in the context of the first — otherwise
        // "it" in a follow-up refers to nothing.
        const [, second] = stub.completionRequests;
        expect(second.user).toContain('What was revenue in Q3?');
        expect(second.user).toContain('And how much did it change?');
      } finally {
        await chatApp.close();
      }
    });

    // GLOSSARY.md: "'ready' is the end of the pipeline and the only status
    // that means a Document is safe to rely on for chat."
    it("ignores Documents whose latest Version has not reached 'ready'", async () => {
      const stub = openRouterStub();
      const chatApp = await appWithChat(stub.stubFetch);
      try {
        const session = await loginAsNewUser('not-ready@example.com');
        const notebookId = await createNotebook(session, 'Mid-ingestion');
        await seedDocument(notebookId, {
          filename: 'indexing.md',
          chatSnippet: 'A Document still being indexed.',
          status: 'indexing',
          chunks: [{ text: 'Revenue figures from a half-ingested Document.' }],
        });
        const threadId = await startThread(session, notebookId, 'Too early');

        const response = await chatApp.inject({
          method: 'POST',
          url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
          cookies: { session },
          payload: { content: 'What was revenue?' },
        });

        expect(response.statusCode).toBe(201);
        // Nothing to ground an answer in, so the model is never called —
        // that would be a paid request whose only possible output is a
        // guess.
        expect(stub.completionRequests).toEqual([]);
        const body = response.json() as { answer: { content: string } };
        expect(body.answer.content).toMatch(/no .*(source|document)/i);
      } finally {
        await chatApp.close();
      }
    });

    // GLOSSARY.md: "Only a Document's latest Version is searched in chat."
    it("retrieves only from a Document's latest Version, not superseded ones", async () => {
      const stub = openRouterStub();
      const chatApp = await appWithChat(stub.stubFetch);
      try {
        const session = await loginAsNewUser('latest-version@example.com');
        const notebookId = await createNotebook(session, 'Versioned chat');
        await seedDocument(notebookId, {
          filename: 'contract.md',
          chatSnippet: 'A contract, revised.',
          olderVersions: [{ chunks: [{ text: 'Revenue share was 20% under the old terms.' }] }],
          chunks: [{ text: 'Revenue share is 35% under the current terms.' }],
        });
        const threadId = await startThread(session, notebookId, 'Terms');

        await chatApp.inject({
          method: 'POST',
          url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
          cookies: { session },
          payload: { content: 'What is the revenue share?' },
        });

        const [completion] = stub.completionRequests;
        expect(completion.user).toContain('Revenue share is 35% under the current terms.');
        // The superseded Version's chunks still exist (a Citation has to be
        // able to reach them, per GLOSSARY.md) but must never be retrieved.
        expect(completion.user).not.toContain('Revenue share was 20% under the old terms.');
      } finally {
        await chatApp.close();
      }
    });

    it("does not retrieve from another Notebook's Documents", async () => {
      const stub = openRouterStub();
      const chatApp = await appWithChat(stub.stubFetch);
      try {
        const session = await loginAsNewUser('cross-notebook@example.com');
        const mine = await createNotebook(session, 'Mine');
        const other = await createNotebook(session, 'Other');
        await seedDocument(mine, {
          filename: 'mine.md',
          chatSnippet: 'My own source.',
          chunks: [{ text: 'Revenue here is mine.' }],
        });
        await seedDocument(other, {
          filename: 'theirs.md',
          chatSnippet: "Someone else's source.",
          chunks: [{ text: 'Revenue there is theirs.' }],
        });
        const threadId = await startThread(session, mine, 'Scoped');

        await chatApp.inject({
          method: 'POST',
          url: `/notebooks/${mine}/threads/${threadId}/messages`,
          cookies: { session },
          payload: { content: 'What about revenue?' },
        });

        const [completion] = stub.completionRequests;
        expect(completion.user).toContain('Revenue here is mine.');
        expect(completion.user).not.toContain('Revenue there is theirs.');
      } finally {
        await chatApp.close();
      }
    });

    it('reports 503 and records nothing when chat is not configured', async () => {
      const session = await loginAsNewUser('unconfigured@example.com');
      const notebookId = await createNotebook(session, 'No OpenRouter');
      const threadId = await startThread(session, notebookId, 'Unanswerable');

      // `app` is built without chat deps — the shape a deployment with no
      // OPENROUTER_API_KEY has.
      const response = await app.inject({
        method: 'POST',
        url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
        cookies: { session },
        payload: { content: 'Anything?' },
      });

      expect(response.statusCode).toBe(503);
      const messages = await app.inject({
        method: 'GET',
        url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
        cookies: { session },
      });
      // A question that could never be answered must not be left in a
      // shared Thread looking like one nobody replied to.
      expect(messages.json()).toEqual([]);
    });

    it('records nothing when the generation call fails', async () => {
      const failingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/embeddings')) {
          const body = JSON.parse(String(init?.body)) as { input: string[] };
          return new Response(
            JSON.stringify({
              data: body.input.map((text, index) => ({ index, embedding: vectorFor(text) })),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('upstream exploded', { status: 502 });
      }) as typeof globalThis.fetch;
      const chatApp = await appWithChat(failingFetch);
      try {
        const session = await loginAsNewUser('generation-fails@example.com');
        const notebookId = await seedNotebook(session, 'Failing chat');
        const threadId = await startThread(session, notebookId, 'Doomed');

        const response = await chatApp.inject({
          method: 'POST',
          url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
          cookies: { session },
          payload: { content: 'What was revenue in Q3?' },
        });

        expect(response.statusCode).toBe(502);
        const messages = await chatApp.inject({
          method: 'GET',
          url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
          cookies: { session },
        });
        expect(messages.json()).toEqual([]);
      } finally {
        await chatApp.close();
      }
    });
  });

  describe('GET /notebooks/:notebookId/threads/:threadId/messages', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/notebooks/00000000-0000-0000-0000-000000000000/threads/00000000-0000-0000-0000-000000000000/messages',
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns 404 for a Thread that doesn't exist", async () => {
      const session = await loginAsNewUser('messages-404@example.com');
      const notebookId = await createNotebook(session, 'Messages 404');

      const response = await app.inject({
        method: 'GET',
        url: `/notebooks/${notebookId}/threads/00000000-0000-0000-0000-000000000000/messages`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  /**
   * A soft-deleted Notebook takes its Chat Threads with it.
   *
   * The same rule as its Documents, and for the same reason: NBK-4 makes a
   * deleted Notebook recoverable, so the rows survive — but holding a Thread
   * id must not keep a deleted Notebook's chat history readable. Listing
   * already enforced it via `notebookExists`; reading or renaming one Thread
   * by id did not.
   */
  describe('a soft-deleted Notebook hides the Chat Threads it contains', () => {
    it('answers 404 for reading, renaming and continuing a Thread in it', async () => {
      const session = await loginAsNewUser('deleted-notebook-thread@example.com');
      const notebookId = await createNotebook(session, 'Doomed Notebook');
      const created = await app.inject({
        method: 'POST',
        url: `/notebooks/${notebookId}/threads`,
        cookies: { session },
        payload: { title: 'Inside a doomed Notebook' },
      });
      const threadId = (created.json() as { id: string }).id;

      await app.inject({ method: 'DELETE', url: `/notebooks/${notebookId}`, cookies: { session } });

      const reads = await app.inject({
        method: 'GET',
        url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
        cookies: { session },
      });
      expect(reads.statusCode).toBe(404);

      const rename = await app.inject({
        method: 'PATCH',
        url: `/notebooks/${notebookId}/threads/${threadId}`,
        cookies: { session },
        payload: { title: 'Renamed from beyond' },
      });
      expect(rename.statusCode).toBe(404);

      const ask = await app.inject({
        method: 'POST',
        url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
        cookies: { session },
        payload: { content: 'Anybody there?' },
      });
      expect(ask.statusCode).toBe(404);

      // Soft-delete, not loss: restoring the Notebook brings the Thread back.
      await app.inject({
        method: 'POST',
        url: `/notebooks/${notebookId}/restore`,
        cookies: { session },
      });
      const afterRestore = await app.inject({
        method: 'GET',
        url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
        cookies: { session },
      });
      expect(afterRestore.statusCode).toBe(200);
      // And the rename above really was refused, not merely reported as 404.
      const listed = await app.inject({
        method: 'GET',
        url: `/notebooks/${notebookId}/threads`,
        cookies: { session },
      });
      expect((listed.json() as Array<{ title: string }>).map((t) => t.title)).toEqual([
        'Inside a doomed Notebook',
      ]);
    });
  });

  // Per ADR-0001 (shared access despite full attribution): a Chat Thread is
  // "visible to and continuable by every user", and attribution is "not an
  // access restriction". This proves that is implemented, not just intended.
  describe('ADR-0001: a Thread someone else started is readable and continuable', () => {
    it('lets a second, unrelated user read and continue a Thread authored by someone else', async () => {
      const stub = openRouterStub('Both of you are asking about the same report.');
      const chatApp = await appWithChat(stub.stubFetch);
      try {
        const alice = await loginAsNewUser('adr0001-chat-alice@example.com');
        const bob = await loginAsNewUser('adr0001-chat-bob@example.com');
        const notebookId = await createNotebook(alice, 'Shared thread');
        await seedDocument(notebookId, {
          filename: 'quarterly.md',
          chatSnippet: 'Quarterly report grounding.',
          chunks: [{ text: 'Revenue in Q3 was 12.4M.' }],
        });

        // Alice starts the Thread and asks the first question.
        const threadId = await startThread(alice, notebookId, "Alice's thread");
        await chatApp.inject({
          method: 'POST',
          url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
          cookies: { session: alice },
          payload: { content: 'Alice: what was revenue?' },
        });

        // Bob, who has nothing to do with it, reads it...
        const readByBob = await chatApp.inject({
          method: 'GET',
          url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
          cookies: { session: bob },
        });
        expect(readByBob.statusCode).toBe(200);
        expect((readByBob.json() as Array<{ content: string }>).map((m) => m.content)).toEqual([
          'Alice: what was revenue?',
          'Both of you are asking about the same report.',
        ]);

        // ...continues it...
        const bobAsks = await chatApp.inject({
          method: 'POST',
          url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
          cookies: { session: bob },
          payload: { content: 'Bob: and the margin?' },
        });
        expect(bobAsks.statusCode).toBe(201);

        // ...and renames it. No ownership check anywhere.
        const bobRenames = await chatApp.inject({
          method: 'PATCH',
          url: `/notebooks/${notebookId}/threads/${threadId}`,
          cookies: { session: bob },
          payload: { title: 'Our thread' },
        });
        expect(bobRenames.statusCode).toBe(200);
        // The author is still Alice: Bob's edits are attributed to Bob, but
        // who *started* the Thread does not change.
        expect((bobRenames.json() as { author: { email: string } }).author.email).toBe(
          'adr0001-chat-alice@example.com',
        );

        // Per-message attribution survives the mixed conversation: each
        // exchange says who asked it, in order.
        const conversation = await chatApp.inject({
          method: 'GET',
          url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
          cookies: { session: alice },
        });
        expect(
          (conversation.json() as Array<{ role: string; askedBy: { email: string } }>).map((m) => [
            m.role,
            m.askedBy.email,
          ]),
        ).toEqual([
          ['user', 'adr0001-chat-alice@example.com'],
          ['assistant', 'adr0001-chat-alice@example.com'],
          ['user', 'adr0001-chat-bob@example.com'],
          ['assistant', 'adr0001-chat-bob@example.com'],
        ]);
      } finally {
        await chatApp.close();
      }
    });
  });
});
