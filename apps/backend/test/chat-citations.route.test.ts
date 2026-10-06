import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { createOpenRouterEmbedder } from "../src/llm/embeddings.js";
import { EMBEDDING_DIMENSIONS } from "../src/llm/models.js";
import { createOpenRouterCompleter } from "../src/llm/openrouter.js";
import { createS3Client } from "../src/storage/s3-client.js";

// Seam-1 tests (per NBK-1's testing decisions, and explicitly called for by
// NBK-12's acceptance criteria): drive the real Fastify app through
// app.inject() against a real Postgres+pgvector container, stubbing only
// OpenRouter — and stubbing it at its `fetch` boundary, so the request
// building and response parsing in src/llm/* stay under test. Both calls the
// ask path makes land there: the query embedding and the chat completion.
//
// What's under test is GLOSSARY.md's definition of a Citation: "a pointer
// into one specific Document Version at one specific chunk... Following a
// Citation opens that exact Version at that location, even after newer
// Versions exist." So the assertions are about *pinning*: which exact pair of
// ids a Citation holds, that the pair is persisted next to the answer, and
// that a later re-upload cannot drag it forward onto the new Version.
describe("Chat citations", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
    // Document routes are registered so that *following* a Citation can be
    // exercised for real: reading a Document Version's Converted Markdown is
    // what a click on one ultimately does. No MinIO container, because that
    // route reads Markdown off Postgres and never touches object storage —
    // the S3 client is constructed and never used (the same trick
    // src/openapi/generate.ts relies on).
    app = await buildApp({
      pool,
      s3: createS3Client({
        endpoint: "http://unused:9000",
        accessKeyId: "unused",
        secretAccessKey: "unused",
      }),
      documentsBucket: "unused",
    });
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await container.stop();
  });

  async function loginAsNewUser(email: string): Promise<string> {
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "correct-horse-battery-staple" },
    });
    const loginResponse = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "correct-horse-battery-staple" },
    });
    return loginResponse.cookies.find((c) => c.name === "session")!.value;
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

  // Embeddings are opaque numbers, so the tests pin them to something they
  // can reason about: one orthonormal basis vector per topic (the same device
  // chat.route.test.ts uses). A chunk about revenue and a question about
  // revenue both embed to e0, giving cosine distance 0; anything else is a
  // different axis, distance 1.
  const TOPICS = ["revenue", "supply chain"];

  function vectorFor(text: string): number[] {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const topic = TOPICS.findIndex((t) => text.toLowerCase().includes(t));
    vector[topic >= 0 ? topic : TOPICS.length] = 1;
    return vector;
  }

  function openRouterStub(answer: string) {
    const completionRequests: { model: string; system: string; user: string }[] = [];

    const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });

      if (url.endsWith("/embeddings")) {
        const texts = (Array.isArray(body.input) ? body.input : [body.input]) as string[];
        return json({ data: texts.map((text, index) => ({ index, embedding: vectorFor(text) })) });
      }
      if (url.endsWith("/chat/completions")) {
        const messages = body.messages as { role: string; content: string }[];
        completionRequests.push({
          model: body.model as string,
          system: messages.find((m) => m.role === "system")!.content,
          user: messages.find((m) => m.role === "user")!.content,
        });
        return json({ choices: [{ message: { content: answer } }] });
      }
      throw new Error(`The chat path called an unexpected OpenRouter endpoint: ${url}`);
    }) as typeof globalThis.fetch;

    return { completionRequests, stubFetch };
  }

  async function appWithChat(stubFetch: typeof globalThis.fetch): Promise<FastifyInstance> {
    return buildApp({
      pool,
      chat: {
        complete: createOpenRouterCompleter({ apiKey: "test-key", fetch: stubFetch, retries: 0 }),
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

  interface SeededChunk {
    text: string;
    headingPath?: string[];
  }

  interface SeededVersion {
    versionId: string;
    versionNumber: number;
    markdown: string;
    chunkIds: string[];
  }

  interface SeededDocument {
    documentId: string;
    versions: SeededVersion[];
  }

  /**
   * Adds a Document Version straight into Postgres in the state ingestion
   * would have left it: its Chat Snippet, its Converted Markdown and its
   * embedded Chunks — where each Chunk's text is a verbatim, contiguous slice
   * of that Markdown, which is what GLOSSARY.md guarantees and what a
   * Citation's location depends on.
   *
   * Arranging rows directly rather than driving the pipeline is deliberate —
   * that the pipeline produces them is proven at seam 2
   * (test/embed-chunks.job.test.ts). Every *assertion* here still goes
   * through HTTP.
   */
  async function addVersion(
    documentId: string,
    chatSnippet: string,
    chunks: SeededChunk[],
  ): Promise<SeededVersion> {
    const { rows: countRows } = await pool.query<{ next: number }>(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM document_versions WHERE document_id = $1",
      [documentId],
    );
    const versionNumber = Number(countRows[0].next);

    // The Converted Markdown is the chunks laid end to end, so each chunk's
    // text really is a contiguous slice of it at a known offset.
    const markdown = chunks.map((c) => c.text).join("\n\n");
    const { rows: versionRows } = await pool.query<{ id: string }>(
      `INSERT INTO document_versions
         (document_id, version_number, mime_type, size_bytes, storage_key,
          ingestion_status, markdown, chat_snippet)
       VALUES ($1, $2, 'text/markdown', 10, $3, 'ready', $4, $5)
       RETURNING id`,
      [documentId, versionNumber, `${documentId}/${versionNumber}`, markdown, chatSnippet],
    );
    const versionId = versionRows[0].id;

    const chunkIds: string[] = [];
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const { rows: chunkRows } = await pool.query<{ id: string }>(
        `INSERT INTO chunks (document_version_id, chunk_index, heading_path, text, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)
         RETURNING id`,
        [
          versionId,
          chunkIndex,
          chunk.headingPath ?? [],
          chunk.text,
          `[${vectorFor(chunk.text).join(",")}]`,
        ],
      );
      chunkIds.push(chunkRows[0].id);
    }

    return { versionId, versionNumber, markdown, chunkIds };
  }

  async function createDocument(notebookId: string, filename: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO documents (notebook_id, filename) VALUES ($1, $2) RETURNING id",
      [notebookId, filename],
    );
    return rows[0].id;
  }

  async function seedDocument(
    notebookId: string,
    filename: string,
    chatSnippet: string,
    versions: SeededChunk[][],
  ): Promise<SeededDocument> {
    const documentId = await createDocument(notebookId, filename);
    const seeded: SeededVersion[] = [];
    for (const chunks of versions) {
      seeded.push(await addVersion(documentId, chatSnippet, chunks));
    }
    return { documentId, versions: seeded };
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

  interface ApiCitation {
    id: string;
    marker: number;
    documentId: string;
    documentVersionId: string;
    versionNumber: number;
    chunkId: string;
    filename: string;
    headingPath: string[];
    charStart: number | null;
    charEnd: number | null;
  }

  interface ApiMessage {
    id: string;
    role: string;
    content: string;
    citations: ApiCitation[];
  }

  async function ask(
    chatApp: FastifyInstance,
    session: string,
    notebookId: string,
    threadId: string,
    question: string,
  ) {
    const response = await chatApp.inject({
      method: "POST",
      url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
      cookies: { session },
      payload: { content: question },
    });
    return {
      statusCode: response.statusCode,
      body: response.json() as { question: ApiMessage; answer: ApiMessage },
    };
  }

  async function readThread(session: string, notebookId: string, threadId: string): Promise<ApiMessage[]> {
    const response = await app.inject({
      method: "GET",
      url: `/notebooks/${notebookId}/threads/${threadId}/messages`,
      cookies: { session },
    });
    return response.json() as ApiMessage[];
  }

  it("pins each Citation to the exact Document Version and chunk the answer was grounded in", async () => {
    // Two passages in one Document, on two different topics, so which chunk
    // a marker means is decided by retrieval order rather than by the order
    // they were written: the supply-chain question puts the second-written
    // passage first, and [1] has to follow that, not the row order.
    const stub = openRouterStub(
      "Lead times lengthened to 14 weeks [1], against revenue of 12.4M [2].",
    );
    const chatApp = await appWithChat(stub.stubFetch);
    try {
      const session = await loginAsNewUser("citations-pinned@example.com");
      const notebookId = await createNotebook(session, "Citations");
      const document = await seedDocument(notebookId, "logistics.md", "Logistics review.", [
        [
          { text: "Revenue in Q3 was 12.4M.", headingPath: ["FY26", "Revenue"] },
          { text: "Supply chain lead times lengthened to 14 weeks.", headingPath: ["FY26", "Lead times"] },
        ],
      ]);
      const version = document.versions[0];
      const threadId = await startThread(session, notebookId, "Lead times");

      const { statusCode, body } = await ask(
        chatApp,
        session,
        notebookId,
        threadId,
        "What happened to supply chain lead times?",
      );

      expect(statusCode).toBe(201);

      // One Citation per marker the model emitted, ordered by marker.
      expect(body.answer.citations.map((c) => c.marker)).toEqual([1, 2]);
      const [cited, alsoCited] = body.answer.citations;

      // The crux: an exact (document_version_id, chunk_id) pair, naming the
      // Version and the chunk that were actually retrieved — not the Document
      // and not "the latest version of it". [1] is the passage the question
      // was closest to, which is the one written second.
      expect(cited.documentVersionId).toBe(version.versionId);
      expect(cited.chunkId).toBe(version.chunkIds[1]);
      expect(cited.documentId).toBe(document.documentId);
      expect(cited.versionNumber).toBe(1);
      // And [2] is the other retrieved passage, so the markers are not
      // collapsing onto one chunk.
      expect(alsoCited.chunkId).toBe(version.chunkIds[0]);

      // Enough to name the source to a reader without another round trip.
      // Per NBK-12 a Citation's display name derives from the chunk's heading
      // path, so there is no separate label field — the path itself travels.
      expect(cited.filename).toBe("logistics.md");
      expect(cited.headingPath).toEqual(["FY26", "Lead times"]);
      expect(alsoCited.headingPath).toEqual(["FY26", "Revenue"]);

      // And where in the Converted Markdown each chunk's text begins and
      // ends, so following the Citation can scroll to it. The cited passage
      // starts after the other one plus the blank line between them.
      const expectedStart = "Revenue in Q3 was 12.4M.".length + 2;
      expect(cited.charStart).toBe(expectedStart);
      expect(cited.charEnd).toBe(expectedStart + "Supply chain lead times lengthened to 14 weeks.".length);
      expect(version.markdown.slice(cited.charStart!, cited.charEnd!)).toBe(
        "Supply chain lead times lengthened to 14 weeks.",
      );
      expect(alsoCited.charStart).toBe(0);
      expect(version.markdown.slice(alsoCited.charStart!, alsoCited.charEnd!)).toBe(
        "Revenue in Q3 was 12.4M.",
      );

      // Persisted alongside the message, not just returned: re-reading the
      // Thread gives back the same Citation on the same answer.
      const messages = await readThread(session, notebookId, threadId);
      const assistant = messages.find((m) => m.role === "assistant")!;
      expect(assistant.id).toBe(body.answer.id);
      expect(assistant.citations).toEqual(body.answer.citations);
      // A question cites nothing — only an answer makes claims.
      expect(messages.find((m) => m.role === "user")!.citations).toEqual([]);
    } finally {
      await chatApp.close();
    }
  });

  // The clause GLOSSARY.md spends its last sentence on, and the one this
  // whole persistence model exists for: "Following a Citation opens that
  // exact Version at that location, even after newer Versions exist." A
  // Citation that resolved its Version at read time would pass every other
  // test in this file and fail this one.
  it("keeps resolving to the superseded Document Version after a newer one exists", async () => {
    const chatApp = await appWithChat(
      openRouterStub("Lead times were 14 weeks [1].").stubFetch,
    );
    try {
      const session = await loginAsNewUser("citations-pinning@example.com");
      const notebookId = await createNotebook(session, "Re-uploads");
      const documentId = await createDocument(notebookId, "logistics.md");
      const v1 = await addVersion(documentId, "Logistics review, FY26.", [
        { text: "Supply chain lead times lengthened to 14 weeks.", headingPath: ["FY26", "Lead times"] },
      ]);
      const threadId = await startThread(session, notebookId, "Lead times");

      const asked = await ask(chatApp, session, notebookId, threadId, "How long are supply chain lead times?");
      expect(asked.statusCode).toBe(201);
      expect(asked.body.answer.citations).toHaveLength(1);
      expect(asked.body.answer.citations[0].documentVersionId).toBe(v1.versionId);

      // The file is re-uploaded: a second Version of the *same* Document,
      // saying something different, and now the only one chat searches.
      const v2 = await addVersion(documentId, "Logistics review, FY27.", [
        { text: "Supply chain lead times recovered to 6 weeks.", headingPath: ["FY27", "Lead times"] },
      ]);
      expect(v2.versionId).not.toBe(v1.versionId);

      // The old answer, re-read now that the newer Version exists.
      const messages = await readThread(session, notebookId, threadId);
      const [citation] = messages.find((m) => m.role === "assistant")!.citations;

      // Still the superseded Version and its chunk — not re-pointed at the
      // latest, and not merely "the same Document".
      expect(citation.documentVersionId).toBe(v1.versionId);
      expect(citation.chunkId).toBe(v1.chunkIds[0]);
      expect(citation.versionNumber).toBe(1);
      // And still described by what *that* Version said, so a reader is told
      // where in the version they are going, not where the same heading moved
      // to in the new one.
      expect(citation.headingPath).toEqual(["FY26", "Lead times"]);

      // Following it reaches the superseded content, at the cited range.
      const followed = await app.inject({
        method: "GET",
        url: `/notebooks/${notebookId}/documents/${documentId}/versions/${citation.documentVersionId}/content`,
        cookies: { session },
      });
      expect(followed.statusCode).toBe(200);
      const { markdown } = followed.json() as { markdown: string };
      expect(markdown).toBe(v1.markdown);
      expect(markdown.slice(citation.charStart!, citation.charEnd!)).toBe(
        "Supply chain lead times lengthened to 14 weeks.",
      );

      // Guard against the test passing for the wrong reason: the latest
      // Version really has moved on, so a *new* question is answered from it.
      const second = await ask(chatApp, session, notebookId, threadId, "And supply chain lead times now?");
      expect(second.body.answer.citations[0].documentVersionId).toBe(v2.versionId);
      expect(second.body.answer.citations[0].versionNumber).toBe(2);

      // Both Citations coexist in one Thread, each pinned to its own Version.
      const both = await readThread(session, notebookId, threadId);
      expect(
        both.filter((m) => m.role === "assistant").map((m) => m.citations[0].documentVersionId),
      ).toEqual([v1.versionId, v2.versionId]);
    } finally {
      await chatApp.close();
    }
  });

  // The invariant that makes a Citation worth clicking: it can only ever name
  // a Chunk this answer was actually grounded in. A model will sometimes
  // number a source it was never given, and that must resolve to nothing
  // rather than to whatever chunk happens to sit at that index in the
  // Notebook.
  it("drops source markers that match no retrieved Chunk, and records the answer regardless", async () => {
    const answerText =
      "Lead times lengthened to 14 weeks [1]. Margins improved [4]. See also [0] and [1].";
    const chatApp = await appWithChat(openRouterStub(answerText).stubFetch);
    try {
      const session = await loginAsNewUser("citations-dangling@example.com");
      const notebookId = await createNotebook(session, "Dangling markers");

      // The only retrievable passage in the Notebook.
      const retrievable = await seedDocument(notebookId, "logistics.md", "Logistics review.", [
        [{ text: "Supply chain lead times lengthened to 14 weeks.", headingPath: ["Lead times"] }],
      ]);

      // A Document mid-ingest: it has chunks, but its latest Version has not
      // reached 'ready', so chat is not allowed to retrieve from it — and so
      // no marker may ever land on it.
      const notReady = await seedDocument(notebookId, "draft.md", "A draft.", [
        [{ text: "Supply chain notes, unverified.", headingPath: ["Draft"] }],
      ]);
      await pool.query("UPDATE document_versions SET ingestion_status = 'summarized' WHERE id = $1", [
        notReady.versions[0].versionId,
      ]);

      // And a Document in a different Notebook entirely.
      const elsewhere = await createNotebook(session, "Somewhere else");
      const otherNotebook = await seedDocument(elsewhere, "other.md", "Other.", [
        [{ text: "Supply chain lead times elsewhere were 2 weeks.", headingPath: ["Other"] }],
      ]);

      const threadId = await startThread(session, notebookId, "Lead times");
      const { statusCode, body } = await ask(
        chatApp,
        session,
        notebookId,
        threadId,
        "How long are supply chain lead times?",
      );

      // The answer is kept, not rejected: a formatting slip by the model is
      // not a reason to throw away prose the user asked for.
      expect(statusCode).toBe(201);
      // And kept verbatim — the dangling markers are left in the text as the
      // plain characters they are rather than the prose being rewritten.
      expect(body.answer.content).toBe(answerText);

      // Only the marker that names a retrieved passage became a Citation,
      // and the passage cited twice is one source, not two.
      expect(body.answer.citations).toHaveLength(1);
      expect(body.answer.citations[0].marker).toBe(1);
      expect(body.answer.citations[0].chunkId).toBe(retrievable.versions[0].chunkIds[0]);

      // Nothing reached a chunk that was not retrieved for this answer.
      const citedChunks = body.answer.citations.map((c) => c.chunkId);
      expect(citedChunks).not.toContain(notReady.versions[0].chunkIds[0]);
      expect(citedChunks).not.toContain(otherNotebook.versions[0].chunkIds[0]);

      // Same after a reload — the dropped markers were never written.
      const messages = await readThread(session, notebookId, threadId);
      expect(messages.find((m) => m.role === "assistant")!.citations).toEqual(body.answer.citations);
    } finally {
      await chatApp.close();
    }
  });

  it("records an answer that cites nothing, with no Citations", async () => {
    const chatApp = await appWithChat(
      openRouterStub("The sources do not say how long lead times are.").stubFetch,
    );
    try {
      const session = await loginAsNewUser("citations-none@example.com");
      const notebookId = await createNotebook(session, "Uncited");
      await seedDocument(notebookId, "logistics.md", "Logistics review.", [
        [{ text: "Supply chain carriers were re-tendered." }],
      ]);
      const threadId = await startThread(session, notebookId, "Lead times");

      const { statusCode, body } = await ask(
        chatApp,
        session,
        notebookId,
        threadId,
        "How long are supply chain lead times?",
      );

      // No Citations is the honest answer when the model made no attributable
      // claim; inventing one per retrieved passage would assert a provenance
      // the answer does not have.
      expect(statusCode).toBe(201);
      expect(body.answer.citations).toEqual([]);

      const messages = await readThread(session, notebookId, threadId);
      expect(messages.find((m) => m.role === "assistant")!.citations).toEqual([]);
    } finally {
      await chatApp.close();
    }
  });

  // A Document that repeats a passage verbatim — a boilerplate line under two
  // headings, a table header repeated per page — is where "find this text in
  // the Markdown" goes wrong: both chunks would be located at the first
  // occurrence, and following the second Citation would scroll to the wrong
  // part of the document. The locations have to come from a scan in document
  // order.
  it("locates repeated text at the occurrence the cited Chunk actually is", async () => {
    const chatApp = await appWithChat(
      openRouterStub("Lead times were re-stated [1][2][3].").stubFetch,
    );
    try {
      const session = await loginAsNewUser("citations-repeated@example.com");
      const notebookId = await createNotebook(session, "Repeated passages");
      const boilerplate = "Supply chain lead times are reviewed quarterly.";
      const document = await seedDocument(notebookId, "logistics.md", "Logistics review.", [
        [
          { text: boilerplate, headingPath: ["Scope"] },
          { text: "Revenue in Q3 was 12.4M.", headingPath: ["Revenue"] },
          // The same words again, lower down, under a different heading.
          { text: boilerplate, headingPath: ["Appendix"] },
        ],
      ]);
      const version = document.versions[0];
      const threadId = await startThread(session, notebookId, "Lead times");

      const { body } = await ask(chatApp, session, notebookId, threadId, "How are lead times reviewed?");

      // Asserted per chunk id rather than per marker: the two identical
      // passages are equally close to the question, so which marker each got
      // is a tie-break, while which *range* each must have is not.
      const rangeOf = new Map(body.answer.citations.map((c) => [c.chunkId, c]));
      expect(rangeOf.size).toBe(3);

      expect(rangeOf.get(version.chunkIds[0])!.charStart).toBe(0);
      const secondOccurrence = version.markdown.lastIndexOf(boilerplate);
      expect(secondOccurrence).toBeGreaterThan(0);
      expect(rangeOf.get(version.chunkIds[2])!.charStart).toBe(secondOccurrence);

      // Both still slice back to the words they cite, from their own place in
      // the document.
      for (const chunkIndex of [0, 2]) {
        const citation = rangeOf.get(version.chunkIds[chunkIndex])!;
        expect(version.markdown.slice(citation.charStart!, citation.charEnd!)).toBe(boilerplate);
      }
    } finally {
      await chatApp.close();
    }
  });

  it("asks the model for markers, and numbers the passages it may cite", async () => {
    const stub = openRouterStub("Lead times lengthened to 14 weeks [1].");
    const chatApp = await appWithChat(stub.stubFetch);
    try {
      const session = await loginAsNewUser("citations-prompt@example.com");
      const notebookId = await createNotebook(session, "Prompted");
      await seedDocument(notebookId, "logistics.md", "Logistics review.", [
        [
          { text: "Supply chain lead times lengthened to 14 weeks.", headingPath: ["Lead times"] },
          { text: "Revenue in Q3 was 12.4M.", headingPath: ["Revenue"] },
        ],
      ]);
      const threadId = await startThread(session, notebookId, "Lead times");

      await ask(chatApp, session, notebookId, threadId, "How long are supply chain lead times?");

      expect(stub.completionRequests).toHaveLength(1);
      const [completion] = stub.completionRequests;

      // The instruction and the notation are one contract: the model is told
      // to cite with bracketed markers...
      expect(completion.system).toContain("[2]");
      expect(completion.system.toLowerCase()).toContain("cite");
      // ...and every Chunk it is shown carries the marker it would use,
      // numbered in retrieval order, so "[1]" means something specific.
      //
      // The label is GLOSSARY.md's "Chunk", not "passage" — which the
      // glossary lists as a term to avoid. Asserted on the literal prompt
      // text because the model echoes the word it was given back into the
      // answer a user reads, which is what makes it part of the product
      // rather than a comment.
      expect(completion.user).toContain("Chunk [1] (under Lead times):");
      expect(completion.user).toContain("Chunk [2] (under Revenue):");
      expect(completion.user).not.toMatch(/Passage \[/);
      expect(completion.system).not.toMatch(/passage/i);
    } finally {
      await chatApp.close();
    }
  });
});
