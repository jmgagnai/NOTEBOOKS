import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { createAppEventSubscriber, publishAppEvent, type AppEventSubscriber } from "../src/events/bus.js";

/**
 * NBK-6's acceptance criteria ask for "a test confirms the SSE event reaches a
 * connected client". That cannot be done through `app.inject()`: inject
 * buffers a response and resolves when it ends, whereas an SSE response
 * deliberately never ends. So this listens on a real ephemeral port and reads
 * the stream with `fetch`, exactly as a browser's `EventSource` would.
 *
 * The event is published through the normal bus (`pg_notify`), not handed to
 * the route directly, so what's under test is the whole path a background
 * worker's event travels: NOTIFY → the serving process's LISTEN subscriber →
 * SSE frame on the wire.
 */
describe("GET /events (SSE)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let subscriber: AppEventSubscriber;
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
    subscriber = await createAppEventSubscriber(container.getConnectionUri());

    app = await buildApp({ pool, appEvents: subscriber });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await subscriber.close();
    await pool.end();
    await container.stop();
  });

  async function loginAsNewUser(email: string): Promise<string> {
    await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "correct-horse-battery-staple" } });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "correct-horse-battery-staple" },
    });
    return login.cookies.find((c) => c.name === "session")!.value;
  }

  /**
   * Opens an SSE connection and resolves with the first frame whose `data`
   * satisfies `matches`, then closes the connection.
   */
  async function firstEventFrom(
    url: string,
    session: string,
    matches: (data: Record<string, unknown>) => boolean,
    onOpen: () => Promise<void>,
  ): Promise<{ type: string; data: Record<string, unknown> }> {
    const controller = new AbortController();
    const response = await fetch(url, {
      headers: { cookie: `session=${session}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Only publish once the stream is actually open: NOTIFY has no replay, so
    // an event published before the subscription exists is simply missed.
    await onOpen();

    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error("SSE stream closed before a matching event arrived.");
        buffer += decoder.decode(value, { stream: true });

        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf("\n\n");

          const dataLine = /^data: (.*)$/m.exec(frame)?.[1];
          if (!dataLine) continue; // a keepalive comment, not an event
          const parsed = JSON.parse(dataLine) as { type: string; data: Record<string, unknown> };
          if (matches(parsed.data)) return { type: parsed.type, data: parsed.data };
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  it("rejects an unauthenticated connection with 401", async () => {
    const response = await fetch(`${baseUrl}/events`);
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it("delivers an event published elsewhere to a connected client", async () => {
    const session = await loginAsNewUser("sse-listener@example.com");

    const frame = await firstEventFrom(
      `${baseUrl}/events`,
      session,
      (data) => data.marker === "reaches-the-client",
      async () => {
        await publishAppEvent(pool, {
          type: "test-sse-delivery",
          topic: "notebook:22222222-2222-2222-2222-222222222222",
          data: { marker: "reaches-the-client" },
        });
      },
    );

    expect(frame.type).toBe("test-sse-delivery");
    expect(frame.data).toEqual({ marker: "reaches-the-client" });
  });

  it("delivers only the topics a client asked for", async () => {
    const session = await loginAsNewUser("sse-filtered@example.com");
    const wanted = "notebook:33333333-3333-3333-3333-333333333333";
    const unwanted = "notebook:44444444-4444-4444-4444-444444444444";

    const frame = await firstEventFrom(
      `${baseUrl}/events?topic=${encodeURIComponent(wanted)}`,
      session,
      () => true,
      async () => {
        // Published first, and never asked for: if topic filtering didn't
        // work this is the frame that would arrive.
        await publishAppEvent(pool, {
          type: "test-sse-unwanted",
          topic: unwanted,
          data: { marker: "should-not-arrive" },
        });
        await publishAppEvent(pool, {
          type: "test-sse-wanted",
          topic: wanted,
          data: { marker: "should-arrive" },
        });
      },
    );

    expect(frame.type).toBe("test-sse-wanted");
    expect(frame.data).toEqual({ marker: "should-arrive" });
  });
});
