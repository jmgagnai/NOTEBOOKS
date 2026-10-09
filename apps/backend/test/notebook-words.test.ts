import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { EMBEDDING_DIMENSIONS } from '../src/llm/models.js';

/**
 * The word list spelling correction reads (NBK-105), kept by the database
 * itself. NBK-109: on the dev database 83% of it was base64 from pictures
 * embedded in Converted Markdown (NBK-108) — lexemes no query should be
 * corrected towards, filling a table and index too big to stay cached.
 */
describe('Notebook word list (NBK-109)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = createPool(container.getConnectionUri());
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await runMigrations(pool);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  const ZERO_EMBEDDING = `[${new Array<number>(EMBEDDING_DIMENSIONS).fill(0).join(',')}]`;
  const BASE64_TOKENS = 'ivborw0kggoaaaansuheugaa h0zs4oghnz8/o3b9 ojo6pe';
  const BASE64_WORDS = BASE64_TOKENS.split(' ');

  async function createNotebook(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO notebooks (title) VALUES ('Words') RETURNING id`,
    );
    return rows[0].id;
  }

  async function wordsOf(notebookId: string): Promise<string[]> {
    const { rows } = await pool.query<{ word: string }>(
      'SELECT DISTINCT word FROM notebook_words WHERE notebook_id = $1 ORDER BY word',
      [notebookId],
    );
    return rows.map((row) => row.word);
  }

  it('adds the words of a Chunk, and none of the base64 beside them', async () => {
    const notebookId = await createNotebook();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO documents (notebook_id, filename) VALUES ($1, 'a.md') RETURNING id`,
      [notebookId],
    );
    const { rows: versions } = await pool.query<{ id: string }>(
      `INSERT INTO document_versions (document_id, version_number, mime_type, size_bytes, storage_key)
       VALUES ($1, 1, 'text/markdown', 1, 'k') RETURNING id`,
      [rows[0].id],
    );
    await pool.query(
      `INSERT INTO chunks (document_version_id, chunk_index, text, embedding)
       VALUES ($1, 0, $2, $3::vector)`,
      [versions[0].id, `Rénine flees to Rossigny ${BASE64_TOKENS}`, ZERO_EMBEDDING],
    );

    expect(await wordsOf(notebookId)).toEqual(['flees', 'renine', 'rossigny', 'to']);
  });

  it('adds the words of a chat message, and none of the base64 beside them', async () => {
    const notebookId = await createNotebook();
    const { rows: users } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ('words@example.com', 'x') RETURNING id`,
    );
    const { rows: threads } = await pool.query<{ id: string }>(
      `INSERT INTO chat_threads (notebook_id, created_by, title) VALUES ($1, $2, 'Words') RETURNING id`,
      [notebookId, users[0].id],
    );
    await pool.query(
      `INSERT INTO chat_messages (chat_thread_id, asked_by, role, content)
       VALUES ($1, $2, 'user', $3)`,
      [threads[0].id, users[0].id, `Where is Hortense ${BASE64_TOKENS}`],
    );

    expect(await wordsOf(notebookId)).toEqual(['hortense', 'is', 'where']);
  });

  it('tells a word from base64: real vocabulary kept, picture data not', async () => {
    const isWord = async (lexeme: string) =>
      (await pool.query<{ ok: boolean }>('SELECT is_notebook_word($1) AS ok', [lexeme])).rows[0].ok;

    for (const word of [
      'internationalisation',
      'mp3',
      'covid19',
      'h2o',
      'élève',
      '第一章夜は暗く',
    ]) {
      expect(await isWord(word), word).toBe(true);
    }
    for (const junk of [...BASE64_WORDS, 'x'.repeat(41), 'image/png']) {
      expect(await isWord(junk), junk).toBe(false);
    }
  });

  it('purges the base64 an existing word list already holds', async () => {
    const notebookId = await createNotebook();
    await pool.query(
      `INSERT INTO notebook_words (notebook_id, word) SELECT $1, unnest($2::text[])`,
      [notebookId, ['rossigny', 'hortense', ...BASE64_WORDS]],
    );

    // The migration as it runs at startup, against a list written before it.
    await pool.query(
      await readFile(
        new URL('../src/db/migrations/0019_notebook_words_without_pictures.sql', import.meta.url),
        'utf8',
      ),
    );

    expect(await wordsOf(notebookId)).toEqual(['hortense', 'rossigny']);
  });
});
