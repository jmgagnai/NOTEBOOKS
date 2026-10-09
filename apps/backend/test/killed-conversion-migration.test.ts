import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';

/**
 * NBK-112: conversions killed from outside were recorded as `unreadable`,
 * which blames the file and offers no Retry. The migration re-marks those
 * already recorded as `unexpected`, and nothing else.
 */
describe('migration 0020: killed conversions are unexpected, not unreadable', () => {
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

  let versions = 0;
  /** A Version in `status`, with the given reason and stored error. */
  async function version(status: string, reason: string | null, error: string | null) {
    const { rows: notebooks } = await pool.query<{ id: string }>(
      `INSERT INTO notebooks (title) VALUES ('Killed') RETURNING id`,
    );
    const { rows: documents } = await pool.query<{ id: string }>(
      'INSERT INTO documents (notebook_id, filename) VALUES ($1, $2) RETURNING id',
      [notebooks[0].id, `doc-${++versions}.pdf`],
    );
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO document_versions
         (document_id, version_number, mime_type, size_bytes, storage_key,
          ingestion_status, failure_reason, failed_at, ingestion_error)
       VALUES ($1, 1, 'application/pdf', 1, 'k', $2, $3, $4, $5) RETURNING id`,
      [documents[0].id, status, reason, reason ? 'converting' : null, error],
    );
    return rows[0].id;
  }

  async function reasonOf(id: string) {
    const { rows } = await pool.query<{ failure_reason: string | null }>(
      'SELECT failure_reason FROM document_versions WHERE id = $1',
      [id],
    );
    return rows[0].failure_reason;
  }

  const migration = () =>
    readFile(
      new URL('../src/db/migrations/0020_killed_conversions_unexpected.sql', import.meta.url),
      'utf8',
    );

  it('re-marks killed conversions as unexpected, and leaves every other failure as it was', async () => {
    const killed = await version('failed', 'unreadable', 'Docling exited with code 137: ');
    const terminated = await version('failed', 'unreadable', 'Docling exited with code 143: ');
    const signalled = await version('failed', 'unreadable', 'Docling exited with signal SIGKILL: ');
    const crashed = await version(
      'failed',
      'unreadable',
      'Docling exited with code 1: RuntimeError: PDF is damaged',
    );
    const scan = await version('failed', 'no-text-layer', 'Docling exited with code 137: ');
    const ready = await version('ready', null, null);

    await pool.query(await migration());
    await pool.query(await migration());

    expect(await reasonOf(killed)).toBe('unexpected');
    expect(await reasonOf(terminated)).toBe('unexpected');
    expect(await reasonOf(signalled)).toBe('unexpected');
    expect(await reasonOf(crashed)).toBe('unreadable');
    expect(await reasonOf(scan)).toBe('no-text-layer');
    expect(await reasonOf(ready)).toBeNull();
  });
});
