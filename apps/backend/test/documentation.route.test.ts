import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';

/**
 * The interactive API documentation (NBK-23). No container here: these
 * routes never touch Postgres, so the pool is one that is never connected —
 * the same trick `openapi/generate.ts` uses to build the document offline.
 */
describe('API documentation routes', () => {
  let app: FastifyInstance;
  const pool = createPool('postgres://unused:unused@localhost:5432/unused');

  beforeAll(async () => {
    app = await buildApp({ pool });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('serves the Swagger UI page at /documentation', async () => {
    const response = await app.inject({ method: 'GET', url: '/documentation' });
    // The plugin answers the bare prefix with a redirect to its static
    // index; what matters to a reader is that the page is reachable.
    const page =
      response.statusCode === 302
        ? await app.inject({ method: 'GET', url: response.headers.location as string })
        : response;
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('swagger-ui');
  });

  it('serves the same OpenAPI document that openapi:generate writes', async () => {
    const response = await app.inject({ method: 'GET', url: '/documentation/json' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(app.swagger());
  });

  it('keeps its own routes out of the published contract', async () => {
    const paths = Object.keys(app.swagger().paths ?? {});
    expect(paths.some((path) => path.startsWith('/documentation'))).toBe(false);
    expect(paths).toContain('/notebooks');
  });
});
