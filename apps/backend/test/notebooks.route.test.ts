import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

// Seam-1 test (per NBK-1's testing decisions): drive the real Fastify app
// through app.inject() against a real Postgres+pgvector container.
describe("GET /notebooks", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
    app = await buildApp({ pool });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
  });

  it("returns an empty list when no Notebooks exist", async () => {
    const response = await app.inject({ method: "GET", url: "/notebooks" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("returns Notebooks stored in Postgres, excluding soft-deleted ones", async () => {
    await pool.query("INSERT INTO notebooks (title) VALUES ($1)", ["Q3 Contracts"]);
    await pool.query("INSERT INTO notebooks (title, deleted_at) VALUES ($1, now())", ["Archived Notebook"]);

    const response = await app.inject({ method: "GET", url: "/notebooks" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ id: string; title: string; createdAt: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ title: "Q3 Contracts" });
    expect(body[0].id).toEqual(expect.any(String));
    expect(body.map((n) => n.title)).not.toContain("Archived Notebook");
  });
});
