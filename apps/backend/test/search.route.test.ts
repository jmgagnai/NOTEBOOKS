import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { EMBEDDING_DIMENSIONS } from '../src/llm/models.js';

interface Segment {
  text: string;
  match: boolean;
}

interface DocumentSearchResult {
  documentId: string;
  filename: string;
  title: string | null;
  headingPath: string[];
  match: { versionId: string; chunkId: string; charStart: number | null; charEnd: number | null };
  excerpt: Segment[];
}

/** An Excerpt as one string, its matched words in [brackets]: what a reader sees, bold aside. */
const shown = (excerpt: Segment[]) =>
  excerpt.map((s) => (s.match ? `[${s.text}]` : s.text)).join('');

// Seam-1 test: the real Fastify app through app.inject() against a real
// Postgres container with seeded Chunks. Documents are searched by keyword
// since NBK-104, so nothing is stubbed at all: the app is built with no
// embedder, the way `server.ts` builds it without OPENROUTER_API_KEY, which
// is itself the proof that search needs no key and makes no OpenRouter call.
describe('Search routes — Documents, by keyword (NBK-104)', () => {
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

  let users = 0;
  /** Registers a fresh user and logs in, returning their session cookie value. */
  async function signIn(): Promise<string> {
    const email = `searcher${++users}@example.com`;
    const credentials = { email, password: 'correct-horse-battery-staple' };
    await app.inject({ method: 'POST', url: '/auth/register', payload: credentials });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: credentials });
    return login.cookies.find((c) => c.name === 'session')!.value;
  }

  async function notebookOf(session: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/notebooks',
      cookies: { session },
      payload: { title: 'Searched' },
    });
    return (response.json() as { id: string }).id;
  }

  interface SeededChunk {
    text: string;
    headingPath?: string[];
  }

  interface SeededVersion {
    /** Where this Version sits in the Ingestion pipeline (GLOSSARY.md). */
    status?: string;
    chunks: SeededChunk[];
    deleted?: boolean;
    /** The title Stage 2 extracted, if any. */
    title?: string;
  }

  // Every Chunk carries an embedding (the column is NOT NULL, for chat); the
  // same one everywhere, since keyword search never reads it.
  const EMBEDDING = `[${new Array<number>(EMBEDDING_DIMENSIONS).fill(0).fill(1, 0, 1).join(',')}]`;

  /**
   * Seeds a Document with the given Versions (oldest first), writing the
   * rows ingestion would have written. The Converted Markdown is the
   * Chunks' text joined, so each Chunk is found in it and has a range.
   * Deliberately direct SQL: the pipeline that writes them is covered at
   * seam 2 by `embed-chunks.job.test.ts`.
   */
  async function seedDocument(
    notebookId: string,
    filename: string,
    versions: SeededVersion[],
    options: { deleted?: boolean } = {},
  ): Promise<{ documentId: string; versionIds: string[] }> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO documents (notebook_id, filename, deleted_at) VALUES ($1, $2, $3) RETURNING id',
      [notebookId, filename, options.deleted ? new Date() : null],
    );
    const documentId = rows[0].id;
    const versionIds: string[] = [];
    for (const [i, version] of versions.entries()) {
      const { rows: versionRows } = await pool.query<{ id: string }>(
        `INSERT INTO document_versions
           (document_id, version_number, mime_type, size_bytes, storage_key,
            markdown, ingestion_status, metadata, deleted_at)
         VALUES ($1, $2, 'text/markdown', 100, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          documentId,
          i + 1,
          `seed/${documentId}/${i + 1}`,
          version.chunks.map((c) => c.text).join('\n\n'),
          version.status ?? 'ready',
          version.title === undefined ? null : { title: version.title },
          version.deleted ? new Date() : null,
        ],
      );
      const versionId = versionRows[0].id;
      versionIds.push(versionId);
      for (const [chunkIndex, chunk] of version.chunks.entries()) {
        await pool.query(
          `INSERT INTO chunks (document_version_id, chunk_index, heading_path, text, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [versionId, chunkIndex, chunk.headingPath ?? [], chunk.text, EMBEDDING],
        );
      }
    }
    return { documentId, versionIds };
  }

  function search(session: string, notebookId: string, q: string) {
    return app.inject({
      method: 'GET',
      url: `/notebooks/${notebookId}/search?${new URLSearchParams({ q }).toString()}`,
      cookies: { session },
    });
  }

  async function results(session: string, notebookId: string, q: string) {
    const response = await search(session, notebookId, q);
    expect(response.statusCode).toBe(200);
    return response.json() as DocumentSearchResult[];
  }

  it('rejects an unauthenticated search with 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/notebooks/00000000-0000-0000-0000-000000000000/search?q=anything',
    });
    expect(response.statusCode).toBe(401);
  });

  it('finds the Chunk holding the word, as an Excerpt with the word marked, without an OpenRouter key', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    const intro = 'Hortense Daniel meets Prince Rénine at the château.';
    const escape = 'They escape through the woods of Rossigny before dawn.';
    const { documentId, versionIds } = await seedDocument(notebookId, 'renine.md', [
      {
        title: 'Les Huit Coups de l’horloge',
        chunks: [
          { text: intro, headingPath: ['Au sommet de la tour'] },
          { text: escape, headingPath: ['Au sommet de la tour', 'La fuite'] },
        ],
      },
    ]);

    const [hit, ...rest] = await results(session, notebookId, 'rossigny');

    expect(rest).toEqual([]);
    expect(hit).toMatchObject({
      documentId,
      filename: 'renine.md',
      title: 'Les Huit Coups de l’horloge',
      headingPath: ['Au sommet de la tour', 'La fuite'],
      match: {
        versionId: versionIds[0],
        charStart: intro.length + 2,
        charEnd: intro.length + 2 + escape.length,
      },
    });
    expect(shown(hit.excerpt)).toBe('They escape through the woods of [Rossigny] before dawn.');
  });

  it('gives one result per matching Chunk, several from the same Document', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await seedDocument(notebookId, 'lupin.md', [
      {
        chunks: [
          { text: 'Lupin arrives at Étretat.' },
          { text: 'Nothing to see here.' },
          { text: 'Lupin leaves the Aiguille.' },
        ],
      },
    ]);

    const hits = await results(session, notebookId, 'lupin');

    expect(hits.map((h) => shown(h.excerpt)).sort()).toEqual([
      '[Lupin] arrives at Étretat.',
      '[Lupin] leaves the Aiguille.',
    ]);
    expect(new Set(hits.map((h) => h.match.chunkId)).size).toBe(2);
  });

  it('ignores accents and case, both ways', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await seedDocument(notebookId, 'aiguille.md', [
      { chunks: [{ text: 'The needle of Étretat stands in the sea.' }] },
    ]);
    await seedDocument(notebookId, 'plain.md', [
      { chunks: [{ text: 'A postcard from ETRETAT, unaccented.' }] },
    ]);

    const unaccented = await results(session, notebookId, 'etretat');
    const accented = await results(session, notebookId, 'Étrétat');

    expect(unaccented.map((h) => shown(h.excerpt)).sort()).toEqual([
      'A postcard from [ETRETAT], unaccented.',
      'The needle of [Étretat] stands in the sea.',
    ]);
    expect(accented.map((h) => h.filename).sort()).toEqual(['aiguille.md', 'plain.md']);
  });

  it('shows the Excerpt as prose, with Markdown markers stripped', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await seedDocument(notebookId, 'report.md', [
      {
        chunks: [
          {
            text: [
              '## Revenue **growth**',
              '',
              '| Quarter | Total |',
              '| --- | --- |',
              '| Q3 | 12.4M |',
              '',
              '> See [the full report](https://example.com/report) and `appendix` for growth.',
            ].join('\n'),
          },
        ],
      },
    ]);

    const [hit] = await results(session, notebookId, 'growth');

    const text = shown(hit.excerpt);
    expect(text).toContain('Revenue [growth]');
    expect(text).toContain('Q3 12.4M');
    expect(text).toContain('See the full report and appendix for [growth].');
    for (const marker of ['#', '|', '**', '`', '](', '---', '> ']) {
      expect(text).not.toContain(marker);
    }
  });

  it('ranks the Chunk the words occur in most first, and returns at most 20', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await seedDocument(notebookId, 'once.md', [
      { chunks: [{ text: 'Sholmès appears once, among many other words here.' }] },
    ]);
    await seedDocument(notebookId, 'thrice.md', [
      { chunks: [{ text: 'Sholmès, Sholmès and again Sholmès.' }] },
    ]);
    await seedDocument(notebookId, 'many.md', [
      {
        chunks: Array.from({ length: 25 }, (_, i) => ({
          text: `Paragraph ${i} where Sholmès is named among a great many filler words.`,
        })),
      },
    ]);

    const hits = await results(session, notebookId, 'sholmes');

    expect(hits).toHaveLength(20);
    expect(hits[0].filename).toBe('thrice.md');
  });

  it('honours web-search syntax: a word to leave out', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await seedDocument(notebookId, 'both.md', [
      { chunks: [{ text: 'Ganimard chases Lupin.' }, { text: 'Ganimard rests at home.' }] },
    ]);

    const hits = await results(session, notebookId, 'ganimard -lupin');

    expect(hits.map((h) => shown(h.excerpt))).toEqual(['[Ganimard] rests at home.']);
  });

  it("searches only each Document's latest Version, and only when it is ready", async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await seedDocument(notebookId, 'replaced.md', [
      { chunks: [{ text: 'Old draft about the tower.' }] },
      { chunks: [{ text: 'New text about the castle.' }] },
    ]);
    await seedDocument(notebookId, 'ingesting.md', [
      { chunks: [{ text: 'A ready tower.' }] },
      { status: 'indexing', chunks: [{ text: 'An ingesting tower.' }] },
    ]);
    await seedDocument(notebookId, 'resurfaced.md', [
      { chunks: [{ text: 'A surviving tower.' }] },
      { deleted: true, chunks: [{ text: 'A deleted tower.' }] },
    ]);

    const hits = await results(session, notebookId, 'tower');

    expect(hits.map((h) => shown(h.excerpt))).toEqual(['A surviving [tower].']);
  });

  it('leaves out deleted Documents and other Notebooks', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    const other = await notebookOf(session);
    await seedDocument(notebookId, 'gone.md', [{ chunks: [{ text: 'Herlock.' }] }], {
      deleted: true,
    });
    await seedDocument(other, 'elsewhere.md', [{ chunks: [{ text: 'Herlock.' }] }]);

    expect(await results(session, notebookId, 'herlock')).toEqual([]);
  });

  it('treats a deleted Notebook as gone: 404', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await seedDocument(notebookId, 'kept.md', [{ chunks: [{ text: 'Herlock.' }] }]);
    await pool.query('UPDATE notebooks SET deleted_at = now() WHERE id = $1', [notebookId]);

    expect((await search(session, notebookId, 'herlock')).statusCode).toBe(404);
  });

  it('returns no results for a blank query', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await seedDocument(notebookId, 'any.md', [{ chunks: [{ text: 'Anything.' }] }]);

    expect(await results(session, notebookId, '   ')).toEqual([]);
  });

  it('hands Chunk text back as text, markup and all, never as markup', async () => {
    const session = await signIn();
    const notebookId = await notebookOf(session);
    await seedDocument(notebookId, 'odd.md', [
      { chunks: [{ text: 'Beware <script>alert(1)</script> in Lupin notes.' }] },
    ]);

    const [hit] = await results(session, notebookId, 'lupin');

    expect(shown(hit.excerpt)).toContain('<script>alert(1)</script>');
  });
});
