import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';

// Seam-1 test (per NBK-1's testing decisions): drive the real Fastify app
// through app.inject() against a real Postgres+pgvector container.
describe('Notebook routes', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
    app = await buildApp({ pool });
  });

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

  describe('GET /notebooks', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/notebooks' });

      expect(response.statusCode).toBe(401);
    });

    it('returns an empty list when no Notebooks exist', async () => {
      const session = await loginAsNewUser('lister1@example.com');

      const response = await app.inject({ method: 'GET', url: '/notebooks', cookies: { session } });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    it('returns Notebooks stored in Postgres, excluding soft-deleted ones', async () => {
      const session = await loginAsNewUser('lister2@example.com');
      await pool.query('INSERT INTO notebooks (title) VALUES ($1)', ['Q3 Contracts']);
      await pool.query('INSERT INTO notebooks (title, deleted_at) VALUES ($1, now())', [
        'Archived Notebook',
      ]);

      const response = await app.inject({ method: 'GET', url: '/notebooks', cookies: { session } });

      expect(response.statusCode).toBe(200);
      const body = response.json() as Array<{ id: string; title: string; createdAt: string }>;
      expect(body.map((n) => n.title)).toContain('Q3 Contracts');
      expect(body.map((n) => n.title)).not.toContain('Archived Notebook');
    });
  });

  describe('POST /notebooks', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/notebooks',
        payload: { title: 'New Notebook' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('creates a Notebook and returns it', async () => {
      const session = await loginAsNewUser('creator1@example.com');

      const response = await app.inject({
        method: 'POST',
        url: '/notebooks',
        cookies: { session },
        payload: { title: 'Research Notes' },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json() as { id: string; title: string; createdAt: string };
      expect(body.title).toBe('Research Notes');
      expect(body.id).toEqual(expect.any(String));

      const listResponse = await app.inject({
        method: 'GET',
        url: '/notebooks',
        cookies: { session },
      });
      expect((listResponse.json() as Array<{ title: string }>).map((n) => n.title)).toContain(
        'Research Notes',
      );
    });
  });

  describe('PATCH /notebooks/:id', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/notebooks/00000000-0000-0000-0000-000000000000',
        payload: { title: 'Renamed' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('renames a Notebook and returns it', async () => {
      const session = await loginAsNewUser('renamer1@example.com');
      const createResponse = await app.inject({
        method: 'POST',
        url: '/notebooks',
        cookies: { session },
        payload: { title: 'Original Title' },
      });
      const { id } = createResponse.json() as { id: string };

      const response = await app.inject({
        method: 'PATCH',
        url: `/notebooks/${id}`,
        cookies: { session },
        payload: { title: 'Renamed Title' },
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { title: string }).title).toBe('Renamed Title');

      const listResponse = await app.inject({
        method: 'GET',
        url: '/notebooks',
        cookies: { session },
      });
      const titles = (listResponse.json() as Array<{ title: string }>).map((n) => n.title);
      expect(titles).toContain('Renamed Title');
      expect(titles).not.toContain('Original Title');
    });

    it("returns 404 when renaming a Notebook that doesn't exist", async () => {
      const session = await loginAsNewUser('renamer2@example.com');

      const response = await app.inject({
        method: 'PATCH',
        url: '/notebooks/00000000-0000-0000-0000-000000000000',
        cookies: { session },
        payload: { title: "Doesn't matter" },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /notebooks/:id', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/notebooks/00000000-0000-0000-0000-000000000000',
      });

      expect(response.statusCode).toBe(401);
    });

    it('soft-deletes a Notebook, removing it from the list', async () => {
      const session = await loginAsNewUser('deleter1@example.com');
      const createResponse = await app.inject({
        method: 'POST',
        url: '/notebooks',
        cookies: { session },
        payload: { title: 'To Be Deleted' },
      });
      const { id } = createResponse.json() as { id: string };

      const response = await app.inject({
        method: 'DELETE',
        url: `/notebooks/${id}`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(204);

      const listResponse = await app.inject({
        method: 'GET',
        url: '/notebooks',
        cookies: { session },
      });
      expect((listResponse.json() as Array<{ title: string }>).map((n) => n.title)).not.toContain(
        'To Be Deleted',
      );
    });

    it("returns 404 when deleting a Notebook that's already deleted", async () => {
      const session = await loginAsNewUser('deleter2@example.com');
      const createResponse = await app.inject({
        method: 'POST',
        url: '/notebooks',
        cookies: { session },
        payload: { title: 'Deleted Twice' },
      });
      const { id } = createResponse.json() as { id: string };
      await app.inject({ method: 'DELETE', url: `/notebooks/${id}`, cookies: { session } });

      const response = await app.inject({
        method: 'DELETE',
        url: `/notebooks/${id}`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /notebooks/:id/restore', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/notebooks/00000000-0000-0000-0000-000000000000/restore',
      });

      expect(response.statusCode).toBe(401);
    });

    it('restores a soft-deleted Notebook so it reappears in the list', async () => {
      const session = await loginAsNewUser('restorer1@example.com');
      const createResponse = await app.inject({
        method: 'POST',
        url: '/notebooks',
        cookies: { session },
        payload: { title: 'To Be Restored' },
      });
      const { id } = createResponse.json() as { id: string };
      await app.inject({ method: 'DELETE', url: `/notebooks/${id}`, cookies: { session } });

      const response = await app.inject({
        method: 'POST',
        url: `/notebooks/${id}/restore`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { title: string }).title).toBe('To Be Restored');

      const listResponse = await app.inject({
        method: 'GET',
        url: '/notebooks',
        cookies: { session },
      });
      expect((listResponse.json() as Array<{ title: string }>).map((n) => n.title)).toContain(
        'To Be Restored',
      );
    });

    it("returns 404 when restoring a Notebook that isn't deleted", async () => {
      const session = await loginAsNewUser('restorer2@example.com');
      const createResponse = await app.inject({
        method: 'POST',
        url: '/notebooks',
        cookies: { session },
        payload: { title: 'Never Deleted' },
      });
      const { id } = createResponse.json() as { id: string };

      const response = await app.inject({
        method: 'POST',
        url: `/notebooks/${id}/restore`,
        cookies: { session },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // Per ADR-0001 (shared Notebook access despite full attribution): Notebooks
  // are not owned by the user who created them, so there is deliberately no
  // ownership check on any Notebook route. This proves that's not an
  // oversight — a second, unrelated user can act on a Notebook they didn't
  // create.
  describe('ADR-0001: shared Notebook access (no ownership check)', () => {
    it("lets a different authenticated user rename, delete, and restore a Notebook they didn't create", async () => {
      const creatorSession = await loginAsNewUser('adr0001-creator@example.com');
      const otherUserSession = await loginAsNewUser('adr0001-other-user@example.com');

      const createResponse = await app.inject({
        method: 'POST',
        url: '/notebooks',
        cookies: { session: creatorSession },
        payload: { title: 'Created By Someone Else' },
      });
      const { id } = createResponse.json() as { id: string };

      // The second user renames a Notebook they didn't create.
      const renameResponse = await app.inject({
        method: 'PATCH',
        url: `/notebooks/${id}`,
        cookies: { session: otherUserSession },
        payload: { title: 'Renamed By Other User' },
      });
      expect(renameResponse.statusCode).toBe(200);
      expect((renameResponse.json() as { title: string }).title).toBe('Renamed By Other User');

      // The second user deletes it.
      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/notebooks/${id}`,
        cookies: { session: otherUserSession },
      });
      expect(deleteResponse.statusCode).toBe(204);

      const listAfterDelete = await app.inject({
        method: 'GET',
        url: '/notebooks',
        cookies: { session: otherUserSession },
      });
      expect(
        (listAfterDelete.json() as Array<{ title: string }>).map((n) => n.title),
      ).not.toContain('Renamed By Other User');

      // The second user restores it.
      const restoreResponse = await app.inject({
        method: 'POST',
        url: `/notebooks/${id}/restore`,
        cookies: { session: otherUserSession },
      });
      expect(restoreResponse.statusCode).toBe(200);

      const listAfterRestore = await app.inject({
        method: 'GET',
        url: '/notebooks',
        cookies: { session: otherUserSession },
      });
      expect((listAfterRestore.json() as Array<{ title: string }>).map((n) => n.title)).toContain(
        'Renamed By Other User',
      );
    });
  });
});
