import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { createOpenRouterEmbedder } from '../src/llm/embeddings.js';
import { EMBEDDING_DIMENSIONS } from '../src/llm/models.js';
import { createOpenRouterCompleter } from '../src/llm/openrouter.js';
import { capturedLogger, LEVEL } from './support/captured-logger.js';

/**
 * NBK-95: only its author deletes a Chat Thread, softly — its messages and
 * their Citations are kept — and only an Administrator (an email in the
 * backend's `ADMIN_EMAILS`) restores one (GLOSSARY.md, ADR-0001 amendment).
 */
describe('Chat Thread deletion', () => {
  const ADMINISTRATOR = 'root@example.com';
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
    // Configured the way server.ts reads ADMIN_EMAILS: any case, any spacing.
    app = await buildApp({ pool, administrators: [' Root@Example.com '] });
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
  });

  afterEach(() => vi.restoreAllMocks());

  let users = 0;
  /** Registers a fresh user (or the given email) and returns their session cookie. */
  async function signIn(email = `user-${++users}@example.com`): Promise<string> {
    const payload = { email, password: 'correct-horse-battery-staple' };
    await app.inject({ method: 'POST', url: '/auth/register', payload });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload });
    return login.cookies.find((c) => c.name === 'session')!.value;
  }

  /** A Notebook with one Chat Thread, started by `session`'s user, holding one message. */
  async function threadOf(session: string) {
    const notebook = await app.inject({
      method: 'POST',
      url: '/notebooks',
      cookies: { session },
      payload: { title: 'Research' },
    });
    const notebookId = (notebook.json() as { id: string }).id;
    const created = await app.inject({
      method: 'POST',
      url: `/notebooks/${notebookId}/threads`,
      cookies: { session },
      payload: { title: 'Revenue questions' },
    });
    const thread = created.json() as { id: string; author: { id: string } };
    await pool.query(
      `INSERT INTO chat_messages (chat_thread_id, asked_by, role, content)
       VALUES ($1, $2, 'user', 'What was revenue in Q3?')`,
      [thread.id, thread.author.id],
    );
    return {
      notebookId,
      threadId: thread.id,
      url: `/notebooks/${notebookId}/threads/${thread.id}`,
    };
  }

  const remove = (url: string, session: string, on = app) =>
    on.inject({ method: 'DELETE', url, cookies: { session } });
  const restore = (url: string, session: string, on = app) =>
    on.inject({ method: 'POST', url: `${url}/restore`, cookies: { session } });
  const listed = async (notebookId: string, session: string) =>
    (
      (
        await app.inject({
          method: 'GET',
          url: `/notebooks/${notebookId}/threads`,
          cookies: { session },
        })
      ).json() as { id: string }[]
    ).map((t) => t.id);

  describe('DELETE /notebooks/:notebookId/threads/:threadId', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const author = await signIn();
      const { url } = await threadOf(author);

      expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(401);
    });

    it("deletes its author's Chat Thread: gone from the list, and from every route", async () => {
      const author = await signIn();
      const { notebookId, threadId, url } = await threadOf(author);

      expect((await remove(url, author)).statusCode).toBe(204);

      expect(await listed(notebookId, author)).not.toContain(threadId);
      const read = await app.inject({
        method: 'GET',
        url: `${url}/messages`,
        cookies: { session: author },
      });
      expect(read.statusCode).toBe(404);
      const rename = await app.inject({
        method: 'PATCH',
        url,
        cookies: { session: author },
        payload: { title: 'Renamed' },
      });
      expect(rename.statusCode).toBe(404);
      expect((await remove(url, author)).statusCode).toBe(404);
    });

    it('keeps the deleted Chat Thread and its messages in the database', async () => {
      const author = await signIn();
      const { threadId, url } = await threadOf(author);

      await remove(url, author);

      const { rows } = await pool.query(
        `SELECT t.deleted_at, count(m.id)::int AS messages
         FROM chat_threads t LEFT JOIN chat_messages m ON m.chat_thread_id = t.id
         WHERE t.id = $1 GROUP BY t.deleted_at`,
        [threadId],
      );
      expect(rows[0].deleted_at).not.toBeNull();
      expect(rows[0].messages).toBe(1);
    });

    it('refuses anyone but the author with 403, and leaves the Chat Thread be', async () => {
      const author = await signIn();
      const someoneElse = await signIn();
      const { notebookId, threadId, url } = await threadOf(author);

      const response = await remove(url, someoneElse);

      expect(response.statusCode).toBe(403);
      expect(await listed(notebookId, author)).toContain(threadId);
    });

    it('says the Chat Thread was deleted to someone who asks in it afterwards', async () => {
      const author = await signIn();
      const { url } = await threadOf(author);
      await remove(url, author);

      const ask = await app.inject({
        method: 'POST',
        url: `${url}/messages`,
        cookies: { session: author },
        payload: { content: 'And in Q4?' },
      });

      expect(ask.statusCode).toBe(404);
      expect(ask.json()).toEqual({ message: 'This Chat Thread was deleted.' });
    });

    // The author deletes the Thread while an answer is still being written
    // in it: the exchange must not land in a deleted Thread (NBK-95: every
    // write treats a deleted Thread as absent), and the asker is told why.
    it('records nothing in a Chat Thread deleted while its answer was being written', async () => {
      const author = await signIn();
      const { threadId, url } = await threadOf(author);
      const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { input?: unknown };
        const json = (payload: unknown) =>
          new Response(JSON.stringify(payload), {
            headers: { 'content-type': 'application/json' },
          });
        if (String(input).endsWith('/embeddings')) {
          // Mid-answer — after the route found the Thread, before it writes
          // — the author's delete lands. Embedding the question is the one
          // call every answer makes (with no Documents the model is not
          // asked at all).
          await pool.query('UPDATE chat_threads SET deleted_at = now() WHERE id = $1', [threadId]);
          const texts = (Array.isArray(body.input) ? body.input : [body.input]) as string[];
          return json({
            data: texts.map((_, index) => ({
              index,
              embedding: new Array<number>(EMBEDDING_DIMENSIONS).fill(1),
            })),
          });
        }
        return json({ choices: [{ message: { content: 'Revenue was 12.4M.' } }] });
      }) as typeof globalThis.fetch;
      const withChat = await buildApp({
        pool,
        chat: {
          complete: createOpenRouterCompleter({ apiKey: 'k', fetch: stubFetch, retries: 0 }),
          embed: createOpenRouterEmbedder({
            apiKey: 'k',
            model: 'e',
            fetch: stubFetch,
            retries: 0,
          }),
          model: 'm',
        },
      });
      try {
        const ask = await withChat.inject({
          method: 'POST',
          url: `${url}/messages`,
          cookies: { session: author },
          payload: { content: 'And in Q4?' },
        });

        expect(ask.statusCode).toBe(404);
        expect(ask.json()).toEqual({ message: 'This Chat Thread was deleted.' });
        const { rows } = await pool.query(
          'SELECT count(*)::int AS n FROM chat_messages WHERE chat_thread_id = $1',
          [threadId],
        );
        expect(rows[0].n).toBe(1);
      } finally {
        await withChat.close();
      }
    });

    // Read back through the backend's logger (NBK-113): the line
    // docs/administration.md tells an Administrator to look for, and its
    // fields for a log tool.
    it('logs the deletion with what an Administrator needs to find it', async () => {
      const { logger, lines } = capturedLogger();
      const logged = await buildApp({ pool, logger });
      try {
        const author = await signIn('ada@example.com');
        const { notebookId, threadId, url } = await threadOf(author);

        await remove(url, author, logged);

        const line = lines.find((l) => l.msg?.startsWith('Chat Thread deleted'));
        expect(line).toMatchObject({
          level: LEVEL.info,
          threadId,
          notebookId,
          title: 'Revenue questions',
          author: 'ada@example.com',
        });
        expect(line?.msg).toContain(threadId);
      } finally {
        await logged.close();
      }
    });
  });

  describe('POST /notebooks/:notebookId/threads/:threadId/restore', () => {
    it('lets an Administrator bring a deleted Chat Thread back, with its messages', async () => {
      const author = await signIn();
      const administrator = await signIn(ADMINISTRATOR);
      const { notebookId, threadId, url } = await threadOf(author);
      await remove(url, author);

      const response = await restore(url, administrator);

      expect(response.statusCode).toBe(200);
      expect((response.json() as { id: string }).id).toBe(threadId);
      expect(await listed(notebookId, author)).toContain(threadId);
      const read = await app.inject({
        method: 'GET',
        url: `${url}/messages`,
        cookies: { session: author },
      });
      expect((read.json() as unknown[]).length).toBe(1);
    });

    it('refuses anyone else, its author included, with 403', async () => {
      const author = await signIn();
      const { notebookId, threadId, url } = await threadOf(author);
      await remove(url, author);

      expect((await restore(url, author)).statusCode).toBe(403);
      expect(await listed(notebookId, author)).not.toContain(threadId);
    });

    it('has no Administrator at all when none is configured', async () => {
      const unconfigured = await buildApp({ pool });
      try {
        const author = await signIn();
        const administrator = await signIn(ADMINISTRATOR);
        const { url } = await threadOf(author);
        await remove(url, author);

        expect((await restore(url, administrator, unconfigured)).statusCode).toBe(403);
      } finally {
        await unconfigured.close();
      }
    });

    it('answers 404 for a Chat Thread that is not deleted', async () => {
      const author = await signIn();
      const administrator = await signIn(ADMINISTRATOR);
      const { url } = await threadOf(author);

      expect((await restore(url, administrator)).statusCode).toBe(404);
    });
  });
});
