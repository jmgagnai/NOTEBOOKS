import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';

/**
 * NBK-97: a Notebook's Chat Threads searched by keyword — Postgres full-text
 * search over every message, no embedding and no OpenRouter call — one result
 * per matching **Exchange** (a question and the answer it produced;
 * GLOSSARY.md), with the matched words marked in excerpts of both.
 */
describe('Chat Thread search', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
    // No `embed`, no `chat`: this search needs neither.
    app = await buildApp({ pool });
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
  });

  let users = 0;
  async function signIn(email = `searcher-${++users}@example.com`) {
    const payload = { email, password: 'correct-horse-battery-staple' };
    await app.inject({ method: 'POST', url: '/auth/register', payload });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload });
    return login.cookies.find((c) => c.name === 'session')!.value;
  }

  async function notebookOf(session: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: '/notebooks',
      cookies: { session },
      payload: { title: 'Lupin' },
    });
    return (r.json() as { id: string }).id;
  }

  /** A Chat Thread holding the given Exchanges, in order; returns its id and theirs. */
  async function threadWith(
    session: string,
    notebookId: string,
    title: string,
    exchanges: [question: string, answer: string][],
  ) {
    const created = await app.inject({
      method: 'POST',
      url: `/notebooks/${notebookId}/threads`,
      cookies: { session },
      payload: { title },
    });
    const thread = created.json() as { id: string; author: { id: string } };
    const ids: { question: string; answer: string }[] = [];
    for (const [question, answer] of exchanges) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO chat_messages (chat_thread_id, asked_by, role, content)
         VALUES ($1, $2, 'user', $3), ($1, $2, 'assistant', $4) RETURNING id`,
        [thread.id, thread.author.id, question, answer],
      );
      ids.push({ question: rows[0].id, answer: rows[1].id });
    }
    return { threadId: thread.id, exchanges: ids };
  }

  interface Segment {
    text: string;
    match: boolean;
  }
  interface ExchangeResult {
    threadId: string;
    threadTitle: string;
    askedBy: { id: string; email: string };
    askedAt: string;
    questionId: string;
    answerId: string;
    question: Segment[];
    answer: Segment[];
  }

  async function search(
    session: string,
    notebookId: string,
    q: string,
    params: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'GET',
      url: `/notebooks/${notebookId}/search/threads?${new URLSearchParams({ q, ...params })}`,
      cookies: { session },
    });
  }
  /** The response body: the Exchanges, and the query searched if it was corrected (NBK-105). */
  const answer = async (
    session: string,
    notebookId: string,
    q: string,
    params: Record<string, string> = {},
  ) =>
    (await search(session, notebookId, q, params)).json() as {
      correctedQuery: string | null;
      results: ExchangeResult[];
    };
  const results = async (session: string, notebookId: string, q: string) =>
    (await answer(session, notebookId, q)).results;
  const plain = (segments: Segment[]) => segments.map((s) => s.text).join('');
  const marked = (segments: Segment[]) => segments.filter((s) => s.match).map((s) => s.text);

  it('rejects an unauthenticated search with 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/notebooks/00000000-0000-0000-0000-000000000000/search/threads?q=lupin',
    });
    expect(response.statusCode).toBe(401);
  });

  it('finds the Exchange whose answer holds the word, marking it, without an OpenRouter key', async () => {
    const session = await signIn('ada@example.com');
    const notebookId = await notebookOf(session);
    const { threadId, exchanges } = await threadWith(session, notebookId, 'Who is who', [
      ['Who helps Hortense?', 'Prince Rénine helps her escape Rossigny, her suitor.'],
    ]);

    const response = await search(session, notebookId, 'rossigny');

    expect(response.statusCode).toBe(200);
    const [hit] = (response.json() as { results: ExchangeResult[] }).results;
    expect(hit).toMatchObject({
      threadId,
      threadTitle: 'Who is who',
      askedBy: { email: 'ada@example.com' },
      questionId: exchanges[0].question,
      answerId: exchanges[0].answer,
    });
    expect(plain(hit.question)).toBe('Who helps Hortense?');
    expect(marked(hit.answer)).toEqual(['Rossigny']);
  });

  it('finds the Exchange whose question holds the word, and shows the question whole', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await threadWith(session, notebookId, 'Questions', [
      ['Where does Lupin hide the Aiguille treasure?', 'In the hollow needle at Étretat.'],
    ]);

    const [hit] = await results(session, notebookId, 'aiguille');

    expect(plain(hit.question)).toBe('Where does Lupin hide the Aiguille treasure?');
    expect(marked(hit.question)).toEqual(['Aiguille']);
  });

  it('gives each matching Exchange of one Chat Thread its own result, and one for both halves', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await threadWith(session, notebookId, 'Cagliostro', [
      ['Who is Cagliostro?', 'Josine, the Comtesse de Cagliostro.'],
      ['Is she older than Lupin?', 'She claims to be.'],
      ['How does Cagliostro end?', 'With her revenge.'],
    ]);

    const hits = await results(session, notebookId, 'cagliostro');

    expect(hits).toHaveLength(2);
    expect(hits.map((h) => plain(h.question)).sort()).toEqual([
      'How does Cagliostro end?',
      'Who is Cagliostro?',
    ]);
  });

  it('ranks the best match first and returns at most 20', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await threadWith(
      session,
      notebookId,
      'Many',
      Array.from({ length: 24 }, (_, i): [string, string] => [`Question ${i}?`, `Ganimard ${i}.`]),
    );
    await threadWith(session, notebookId, 'Best', [
      ['Ganimard and Ganimard again?', 'Ganimard, Ganimard and Ganimard.'],
    ]);

    const body = await answer(session, notebookId, 'ganimard');

    expect(body.results).toHaveLength(20);
    expect(body.results[0].threadTitle).toBe('Best');
    // How many matched in all, so the page can say the list is cut.
    expect((body as unknown as { total: number }).total).toBe(25);
  });

  it('counts every match even when all are shown', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await threadWith(session, notebookId, 'Few', [['Ganimard?', 'Yes.']]);

    expect(await answer(session, notebookId, 'ganimard')).toMatchObject({ total: 1 });
    expect(await answer(session, notebookId, 'zzz')).toMatchObject({ total: 0, results: [] });
  });

  it('leaves out deleted Chat Threads and other Notebooks', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    const other = await notebookOf(session);
    const gone = await threadWith(session, notebookId, 'Gone', [['Herlock?', 'Sholmès.']]);
    await threadWith(session, other, 'Elsewhere', [['Herlock?', 'Sholmès.']]);
    await app.inject({
      method: 'DELETE',
      url: `/notebooks/${notebookId}/threads/${gone.threadId}`,
      cookies: { session },
    });

    expect(await results(session, notebookId, 'sholmès')).toEqual([]);
  });

  it('treats a deleted Notebook as gone: 404, its Chat Threads unsearched', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await threadWith(session, notebookId, 'Kept', [['Herlock?', 'Sholmès.']]);
    await pool.query('UPDATE notebooks SET deleted_at = now() WHERE id = $1', [notebookId]);

    const response = await search(session, notebookId, 'sholmès');

    expect(response.statusCode).toBe(404);
  });

  // NBK-104: the same matching as Documents — accents and case ignored.
  it('ignores accents and case, both ways', async () => {
    const session = await signIn('ada@example.com');
    const notebookId = await notebookOf(session);
    await threadWith(session, notebookId, 'Where', [
      ['Where is the needle?', 'At Étretat, in the sea.'],
    ]);

    const unaccented = await results(session, notebookId, 'etretat');
    const accented = await results(session, notebookId, 'ÉTRÉTAT');

    expect(unaccented.map((hit) => marked(hit.answer))).toEqual([['Étretat']]);
    expect(accented).toHaveLength(1);
  });

  it('finds nothing for a query that only excludes', async () => {
    const session = await signIn('ada@example.com');
    const notebookId = await notebookOf(session);
    await threadWith(session, notebookId, 'Any', [['Anything?', 'Something.']]);

    const response = await search(session, notebookId, '-lupin');

    expect(response.json()).toMatchObject({ correctedQuery: null, results: [] });
  });

  it("keeps angle brackets in an answer's Excerpt as text", async () => {
    const session = await signIn('ada@example.com');
    const notebookId = await notebookOf(session);
    await threadWith(session, notebookId, 'Code', [
      ['What type?', 'Use List<String> for the Lupin names.'],
    ]);

    const [hit] = await results(session, notebookId, 'lupin');

    expect(plain(hit.answer)).toContain('List<String>');
  });

  // NBK-105: a misspelt word is corrected to the closest word the
  // Notebook really holds, as for Documents.
  it('finds the Exchange for a misspelt word, and says what it searched', async () => {
    const session = await signIn('ada@example.com');
    const notebookId = await notebookOf(session);
    await threadWith(session, notebookId, 'Who is who', [
      ['Who helps Hortense?', 'Prince Rénine, at Rossigny.'],
    ]);

    const body = await answer(session, notebookId, 'rosigny');

    expect(body.correctedQuery).toBe('rossigny');
    expect(body.results.map((hit) => marked(hit.answer))).toEqual([['Rossigny']]);
    expect((body as unknown as { words: string[] }).words).toEqual(['rossigny']);
    expect(await answer(session, notebookId, 'rosigny', { exact: 'true' })).toMatchObject({
      correctedQuery: null,
      results: [],
    });
  });

  it('corrects every misspelt word, as for Documents', async () => {
    const session = await signIn('ada@example.com');
    const notebookId = await notebookOf(session);
    await threadWith(session, notebookId, 'Who', [['Who helps Hortense?', 'Rénine.']]);

    const body = await answer(session, notebookId, 'hortnse');

    expect(body.correctedQuery).toBe('hortense');
    expect(body.results).toHaveLength(1);
  });

  it('ranks what matched as typed above what needed a correction', async () => {
    const session = await signIn('ada@example.com');
    const notebookId = await notebookOf(session);
    await threadWith(session, notebookId, 'Both', [
      ['Rossigny, Rossigny, Rossigny?', 'Rossigny again.'],
      ['Where is Ganimard?', 'Waiting.'],
    ]);

    const body = await answer(session, notebookId, 'rosigny or ganimard');

    expect(body.results.map((hit) => plain(hit.question))).toEqual([
      'Where is Ganimard?',
      'Rossigny, Rossigny, Rossigny?',
    ]);
  });

  it('returns no results for a blank query', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await threadWith(session, notebookId, 'Any', [['Anything?', 'Something.']]);

    const response = await search(session, notebookId, '   ');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ correctedQuery: null, results: [] });
  });

  it("returns 404 for a Notebook that doesn't exist", async () => {
    const session = await signIn();
    const response = await search(session, '00000000-0000-0000-0000-000000000000', 'lupin');
    expect(response.statusCode).toBe(404);
  });

  it('hands message text back as text, markup and all, never as markup', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await threadWith(session, notebookId, 'Markup', [
      ['What does <script>alert(1)</script> do near Étretat?', 'Nothing at Étretat.'],
    ]);

    const [hit] = await results(session, notebookId, 'étretat');

    expect(plain(hit.question)).toBe('What does <script>alert(1)</script> do near Étretat?');
    expect(marked(hit.question)).toEqual(['Étretat']);
  });
});
