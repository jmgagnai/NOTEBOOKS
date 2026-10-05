import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

// Seam-1 test (per NBK-1's testing decisions): drive the real Fastify app
// through app.inject() against a real Postgres container, covering
// register/login/logout and the auth guard (NBK-3).
describe("Auth: register, login, logout", () => {
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

  describe("POST /auth/register", () => {
    it("creates a user and returns it without the password", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "ada@example.com", password: "correct-horse-battery-staple" },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json() as { id: string; email: string; createdAt: string };
      expect(body.email).toBe("ada@example.com");
      expect(body.id).toEqual(expect.any(String));
      expect(body).not.toHaveProperty("password");
      expect(body).not.toHaveProperty("passwordHash");
    });

    it("rejects a duplicate email with 409", async () => {
      await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "grace@example.com", password: "correct-horse-battery-staple" },
      });

      const response = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "grace@example.com", password: "a-different-password" },
      });

      expect(response.statusCode).toBe(409);
    });

    it("rejects a short password with 400", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "short@example.com", password: "short" },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("POST /auth/login", () => {
    beforeAll(async () => {
      await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "ping@example.com", password: "correct-horse-battery-staple" },
      });
    });

    it("logs in with correct credentials and sets an httpOnly session cookie", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "ping@example.com", password: "correct-horse-battery-staple" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { email: string };
      expect(body.email).toBe("ping@example.com");

      const setCookie = response.cookies.find((c) => c.name === "session");
      expect(setCookie).toBeDefined();
      expect(setCookie?.httpOnly).toBe(true);
      expect(setCookie?.value.length).toBeGreaterThan(0);
    });

    it("rejects an unknown email with 401", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "nobody@example.com", password: "whatever12345" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("rejects a wrong password with 401", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "ping@example.com", password: "totally-wrong-password" },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("GET /auth/me (auth guard)", () => {
    it("rejects an unauthenticated request with 401", async () => {
      const response = await app.inject({ method: "GET", url: "/auth/me" });

      expect(response.statusCode).toBe(401);
    });

    it("returns the current user for a request carrying a valid session cookie", async () => {
      await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "marie@example.com", password: "correct-horse-battery-staple" },
      });
      const loginResponse = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "marie@example.com", password: "correct-horse-battery-staple" },
      });
      const sessionCookie = loginResponse.cookies.find((c) => c.name === "session")!;

      const response = await app.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { session: sessionCookie.value },
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { email: string }).email).toBe("marie@example.com");
    });

    it("rejects a request carrying a garbage session cookie with 401", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { session: "not-a-valid-jwt" },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("POST /auth/logout", () => {
    it("clears the session cookie so a subsequent /auth/me is unauthenticated", async () => {
      await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "logout@example.com", password: "correct-horse-battery-staple" },
      });
      const loginResponse = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "logout@example.com", password: "correct-horse-battery-staple" },
      });
      const sessionCookie = loginResponse.cookies.find((c) => c.name === "session")!;

      const logoutResponse = await app.inject({
        method: "POST",
        url: "/auth/logout",
        cookies: { session: sessionCookie.value },
      });
      expect(logoutResponse.statusCode).toBe(204);

      const clearedCookie = logoutResponse.cookies.find((c) => c.name === "session");
      expect(clearedCookie).toBeDefined();

      const meResponse = await app.inject({ method: "GET", url: "/auth/me" });
      expect(meResponse.statusCode).toBe(401);
    });
  });
});
