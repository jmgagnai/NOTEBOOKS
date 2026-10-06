import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";
import {
  CHAT_ANSWER_CHUNK,
  CHAT_ANSWER_COMPLETED,
  CHAT_ANSWER_FAILED,
} from "../src/chat/streaming.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import {
  createAppEventSubscriber,
  type AppEvent,
  type AppEventSubscriber,
} from "../src/events/bus.js";
import { createOpenRouterEmbedder } from "../src/llm/embeddings.js";
import { EMBEDDING_DIMENSIONS } from "../src/llm/models.js";
import { createOpenRouterCompleter, createOpenRouterStreamer } from "../src/llm/openrouter.js";

/**
 * Seam-1 test for NBK-11 (progressive streamed answers), per NBK-1's testing
 * decisions: drive the real Fastify app through `app.inject()` against a real
 * Postgres+pgvector container, stubbing only OpenRouter — and stubbing it at
 * its `fetch` boundary, so the SSE-body parsing and the `stream: true`
 * request building in src/llm/openrouter.ts stay under test.
 *
 * The *emitted* side is observed through a real app-event subscriber on its
 * own Postgres connection, not by spying on a publisher. That is the same
 * seam test/app-events.test.ts uses, and it is what makes "the answer streams
 * over the existing App Event channel" a checkable claim rather than an
 * implementation detail: the chunks have to survive a round trip through
 * `pg_notify` to be seen here, exactly as they would reaching a browser's
 * EventSource through `GET /events`.
 *
 * No MinIO container: chat reads Chunks and Chat Snippets off Postgres.
 */
describe("Chat answer streaming", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: FastifyInstance;
  let subscriber: AppEventSubscriber;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
    subscriber = await createAppEventSubscriber(container.getConnectionUri());
    app = await buildApp({ pool });
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await subscriber.close();
    await pool.end();
    await container.stop();
  });

  // ---------------------------------------------------------------------
  // Fixtures. Shaped like test/chat.route.test.ts's, because the whole
  // point of NBK-11 is that the *delivery* changes and nothing else does.
  // ---------------------------------------------------------------------

  const PASSWORD = "correct-horse-battery-staple";

  async function loginAsNewUser(email: string): Promise<string> {
    await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: PASSWORD } });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: PASSWORD },
    });
    return login.cookies.find((c) => c.name === "session")!.value;
  }

  async function createNotebook(session: string, title: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/notebooks",
      cookies: { session },
      payload: { title },
    });
    return (response.json() as { id: string }).id;
  }

  // One orthonormal basis vector per topic, as in test/chat.route.test.ts:
  // a chunk and a question about the same topic are distance 0 apart and
  // everything else is distance 1, so retrieval order is reasoned about
  // rather than inherited from a real model's geometry.
  const TOPICS = ["revenue", "supply chain"];

  function vectorFor(text: string): number[] {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const topic = TOPICS.findIndex((t) => text.toLowerCase().includes(t));
    vector[topic >= 0 ? topic : TOPICS.length] = 1;
    return vector;
  }

  interface SeededDocument {
    filename: string;
    chatSnippet: string;
    chunks: { text: string; headingPath?: string[] }[];
  }

  /** Writes a Document straight into Postgres in the state ingestion leaves it. */
  async function seedDocument(notebookId: string, spec: SeededDocument): Promise<void> {
    const { rows: docRows } = await pool.query<{ id: string }>(
      "INSERT INTO documents (notebook_id, filename) VALUES ($1, $2) RETURNING id",
      [notebookId, spec.filename],
    );
    const documentId = docRows[0].id;
    const { rows: versionRows } = await pool.query<{ id: string }>(
      `INSERT INTO document_versions
         (document_id, version_number, mime_type, size_bytes, storage_key,
          ingestion_status, markdown, chat_snippet)
       VALUES ($1, 1, 'text/markdown', 10, $2, 'ready', $3, $4)
       RETURNING id`,
      [documentId, `${documentId}/1`, spec.chunks.map((c) => c.text).join("\n\n"), spec.chatSnippet],
    );
    for (const [index, chunk] of spec.chunks.entries()) {
      await pool.query(
        `INSERT INTO chunks (document_version_id, chunk_index, heading_path, text, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [versionRows[0].id, index, chunk.headingPath ?? [], chunk.text, `[${vectorFor(chunk.text).join(",")}]`],
      );
    }
  }

  async function startThread(session: string, notebookId: string, title: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: `/notebooks/${notebookId}/threads`,
      cookies: { session },
      payload: { title },
    });
    return (response.json() as { id: string }).id;
  }

  // ---------------------------------------------------------------------
  // The OpenRouter stub, now with a streaming body.
  // ---------------------------------------------------------------------

  /**
   * Hands back an OpenAI-compatible `text/event-stream` body carrying `text`
   * as many tiny deltas — three characters at a time, so a token is never a
   * word, let alone a paragraph.
   *
   * That slicing is the point of the whole test: if anything downstream
   * forwarded what the model sent, the assertions below would see dozens of
   * three-character chunks instead of four paragraph/heading-sized ones.
   */
  function openAiStreamBody(text: string, deltaSize = 3): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const frames: string[] = [];
    for (let at = 0; at < text.length; at += deltaSize) {
      const content = text.slice(at, at + deltaSize);
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    }
    frames.push("data: [DONE]\n\n");
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
  }

  interface StubOptions {
    answer: string;
    /** Characters to emit before the body errors, to test a mid-stream failure. */
    truncateAfter?: number;
    deltaSize?: number;
  }

  function openRouterStub({ answer, truncateAfter, deltaSize }: StubOptions) {
    const completionRequests: { model: string; stream: unknown }[] = [];

    const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

      if (url.endsWith("/embeddings")) {
        const texts = (Array.isArray(body.input) ? body.input : [body.input]) as string[];
        return new Response(
          JSON.stringify({ data: texts.map((text, index) => ({ index, embedding: vectorFor(text) })) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/chat/completions")) {
        completionRequests.push({ model: body.model as string, stream: body.stream });
        if (truncateAfter !== undefined) {
          // A body that dies partway: the provider accepted the request and
          // then the connection broke. The answer is irrecoverable, and
          // nothing may be written down as if it were complete.
          const encoder = new TextEncoder();
          const prefix = answer.slice(0, truncateAfter);
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: prefix } }] })}\n\n`),
                );
                controller.error(new Error("the provider hung up"));
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(openAiStreamBody(answer, deltaSize), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`The chat path called an unexpected OpenRouter endpoint: ${url}`);
    }) as typeof globalThis.fetch;

    return { completionRequests, stubFetch };
  }

  /**
   * A second app over the same container, with chat wired to the real
   * OpenRouter clients — streaming and non-streaming both — their `fetch`
   * replaced by the stub.
   */
  async function appWithStreamingChat(stubFetch: typeof globalThis.fetch): Promise<FastifyInstance> {
    return buildApp({
      pool,
      chat: {
        complete: createOpenRouterCompleter({ apiKey: "test-key", fetch: stubFetch, retries: 0 }),
        stream: createOpenRouterStreamer({ apiKey: "test-key", fetch: stubFetch, retries: 0 }),
        embed: createOpenRouterEmbedder({
          apiKey: "test-key",
          model: "test/embedding-model",
          fetch: stubFetch,
          retries: 0,
        }),
        model: "test/chat-model",
      },
    });
  }

  // ---------------------------------------------------------------------
  // Event collection.
  // ---------------------------------------------------------------------

  let stopCollecting: (() => void) | null = null;

  afterEach(() => {
    stopCollecting?.();
    stopCollecting = null;
  });

  /** Records every app event on `topic` from now until the test ends. */
  function collectEvents(topic: string): AppEvent[] {
    const collected: AppEvent[] = [];
    const unsubscribe = subscriber.subscribe((event) => {
      if (event.topic === topic) collected.push(event);
    });
    stopCollecting = unsubscribe;
    return collected;
  }

  /** Waits until `collected` holds an event of `type`, or fails after 10s. */
  async function waitForEvent(collected: AppEvent[], type: string): Promise<AppEvent> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = collected.find((event) => event.type === type);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `No "${type}" app event arrived within 10s. Saw: ${collected.map((e) => e.type).join(", ") || "nothing"}`,
    );
  }

  function chunkTexts(collected: AppEvent[]): string[] {
    return collected
      .filter((event) => event.type === CHAT_ANSWER_CHUNK)
      .sort((a, b) => (a.data.index as number) - (b.data.index as number))
      .map((event) => event.data.text as string);
  }

  // =====================================================================

  // NBK-11's first acceptance criterion, and the product decision NBK-1
  // records twice ("not token-by-token", "without a jarring word-by-word
  // flicker"): the model's tokens are buffered and released only on a
  // paragraph or heading boundary.
  it("emits the answer over the app-event channel in paragraph/heading-sized chunks", async () => {
    const session = await loginAsNewUser("streaming-chunks@example.com");
    const notebookId = await createNotebook(session, "Streaming");
    await seedDocument(notebookId, {
      filename: "q3.md",
      chatSnippet: "The Q3 revenue report.",
      chunks: [{ text: "Revenue reached 12.4M in Q3.", headingPath: ["Q3", "Revenue"] }],
    });
    const threadId = await startThread(session, notebookId, "Revenue");

    const answer = [
      "## Revenue",
      "Revenue reached 12.4M in Q3 [1].",
      "## What that means",
      "It is the strongest quarter on record, and the trend is upward.",
    ].join("\n\n");

    const { completionRequests, stubFetch } = openRouterStub({ answer });
    const streamingApp = await appWithStreamingChat(stubFetch);
    const collected = collectEvents(`notebook:${notebookId}`);

    try {
      const response = await streamingApp.inject({
        method: "POST",
        url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
        cookies: { session },
        payload: { content: "What was revenue in Q3?" },
      });
      expect(response.statusCode).toBe(201);

      await waitForEvent(collected, CHAT_ANSWER_COMPLETED);

      // The whole claim of the ticket, in one assertion: four chunks, one per
      // heading and one per paragraph — not the ~40 three-character deltas
      // the stubbed model actually produced.
      expect(chunkTexts(collected)).toEqual([
        "## Revenue",
        "Revenue reached 12.4M in Q3 [1].",
        "## What that means",
        "It is the strongest quarter on record, and the trend is upward.",
      ]);

      // And the request really did ask OpenRouter to stream, so the chunking
      // is buffering of a live token stream rather than slicing of an answer
      // that had already arrived whole.
      expect(completionRequests).toHaveLength(1);
      expect(completionRequests[0].stream).toBe(true);
    } finally {
      await streamingApp.close();
    }
  });

  // NBK-11's second acceptance criterion. "Still persisted as a single
  // chat_messages row" is the load-bearing word: a reader opening the Thread
  // later must find one answer, indistinguishable from one the synchronous
  // path (NBK-10) wrote — not one row per streamed chunk.
  it("persists the assembled answer as one chat_messages row with its Citations", async () => {
    const session = await loginAsNewUser("streaming-persist@example.com");
    const notebookId = await createNotebook(session, "Streaming persistence");
    await seedDocument(notebookId, {
      filename: "q3.md",
      chatSnippet: "The Q3 revenue report.",
      chunks: [{ text: "Revenue reached 12.4M in Q3.", headingPath: ["Q3", "Revenue"] }],
    });
    const threadId = await startThread(session, notebookId, "Revenue");

    const answer = ["## Revenue", "Revenue reached 12.4M in Q3 [1]."].join("\n\n");
    const { stubFetch } = openRouterStub({ answer });
    const streamingApp = await appWithStreamingChat(stubFetch);
    const collected = collectEvents(`notebook:${notebookId}`);

    try {
      const response = await streamingApp.inject({
        method: "POST",
        url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
        cookies: { session },
        payload: { content: "What was revenue in Q3?" },
      });
      expect(response.statusCode).toBe(201);
      const exchange = response.json() as {
        question: { content: string };
        answer: { id: string; content: string; citations: { marker: number; filename: string }[] };
      };

      // The response of the ask is still the whole exchange, the same shape
      // NBK-10 returned: the SSE chunks are the *preview*, and this is the
      // truth a client stores (GLOSSARY.md, App Event).
      expect(exchange.answer.content).toBe(answer);
      expect(exchange.answer.citations).toHaveLength(1);

      // Exactly two rows — the question and one answer — read back over the
      // normal API, with the streamed prose assembled whole.
      const conversation = await streamingApp.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
        cookies: { session },
      });
      const messages = conversation.json() as {
        id: string;
        role: string;
        content: string;
        citations: { marker: number; filename: string }[];
      }[];
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(messages[1].content).toBe(answer);
      expect(messages[1].citations.map((c) => [c.marker, c.filename])).toEqual([[1, "q3.md"]]);

      // The completion event names the row that was written, so a client
      // that was rendering chunks knows which persisted message replaces its
      // preview, and ships the Citations — which can only be resolved from
      // the *complete* text and so could not travel with any chunk.
      const completed = await waitForEvent(collected, CHAT_ANSWER_COMPLETED);
      expect(completed.data.messageId).toBe(messages[1].id);
      expect(completed.data.threadId).toBe(threadId);
      expect((completed.data.citations as { marker: number }[]).map((c) => c.marker)).toEqual([1]);
    } finally {
      await streamingApp.close();
    }
  });

  // The failure case the ticket asks to be explicit about. A stream that dies
  // partway has produced prose no one can vouch for, and NBK-10's rule —
  // "nothing is recorded, asking again is the retry" — has to survive the
  // upgrade. Clients that were rendering the partial answer are told to drop
  // it, because nothing they can re-read will ever contain it.
  it("records nothing and says so when the stream fails partway", async () => {
    const session = await loginAsNewUser("streaming-failure@example.com");
    const notebookId = await createNotebook(session, "Streaming failure");
    await seedDocument(notebookId, {
      filename: "q3.md",
      chatSnippet: "The Q3 revenue report.",
      chunks: [{ text: "Revenue reached 12.4M in Q3.", headingPath: ["Q3", "Revenue"] }],
    });
    const threadId = await startThread(session, notebookId, "Revenue");

    const { stubFetch } = openRouterStub({
      answer: "## Revenue\n\nRevenue reached",
      truncateAfter: "## Revenue\n\n".length,
    });
    const streamingApp = await appWithStreamingChat(stubFetch);
    const collected = collectEvents(`notebook:${notebookId}`);

    try {
      const response = await streamingApp.inject({
        method: "POST",
        url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
        cookies: { session },
        payload: { content: "What was revenue in Q3?" },
      });
      expect(response.statusCode).toBe(502);

      const conversation = await streamingApp.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
        cookies: { session },
      });
      expect(conversation.json()).toEqual([]);

      const failed = await waitForEvent(collected, CHAT_ANSWER_FAILED);
      expect(failed.data.threadId).toBe(threadId);
      // Whatever had already been streamed is not a message and never will
      // be, so no completion event claims it.
      expect(collected.some((event) => event.type === CHAT_ANSWER_COMPLETED)).toBe(false);
    } finally {
      await streamingApp.close();
    }
  });
});
