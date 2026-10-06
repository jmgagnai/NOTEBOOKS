import type { Pool } from "pg";
import type { Embedder } from "../llm/embeddings.js";
import type { ChatCompleter, ChatStreamer } from "../llm/openrouter.js";
import {
  CITATION_INSTRUCTIONS,
  locateCitations,
  resolveCitationMarkers,
  type ResolvedCitation,
} from "./citations.js";
import { DEFAULT_RETRIEVAL_LIMIT, retrieveChunks, type RetrievedChunk } from "./retrieval.js";
import type { ChatMessage } from "./schema.js";
import { createAnswerChunker } from "./streaming.js";

/**
 * What the chat module needs to answer a question.
 *
 * `complete` and `embed` are the same two seams ingestion uses (see
 * src/llm/openrouter.ts and src/llm/embeddings.ts), so the seam-1 tests stub
 * OpenRouter at `fetch` underneath them and the real request building stays
 * under test. `model` is the fixed, server-side chat model — per NBK-1 a
 * user-facing model picker is out of scope, so it is bound here and never
 * read off a request.
 */
export interface ChatDeps {
  complete: ChatCompleter;
  /**
   * The streaming half of the same seam (NBK-11). Given, an answer is
   * generated progressively and delivered in paragraph/heading chunks;
   * omitted, the synchronous `complete` path is used and the answer simply
   * arrives whole. Optional so a deployment or a test that only cares about
   * the recorded result does not have to wire a second client, and so the
   * two paths provably produce the same persisted row.
   */
  stream?: ChatStreamer;
  /** Embeds the user's question, to retrieve against. */
  embed: Embedder;
  /** The OpenRouter model id for chat answers. From `resolveTaskModels()`. */
  model: string;
  /** Overrides how many Chunks one question retrieves. */
  retrievalLimit?: number;
}

/**
 * One grounded answer.
 *
 * `chunks` is the retrieved evidence, in the order it was given to the model
 * — which is the order its source markers are numbered in.
 *
 * `citations` is deliberately a value of its own rather than something
 * encoded into `text`: the prose and its provenance travel side by side, so
 * NBK-11 can stream `text` in paragraph-sized pieces and deliver the same
 * Citations alongside it without having to parse a half-written answer.
 */
export interface GroundedAnswer {
  text: string;
  chunks: RetrievedChunk[];
  citations: ResolvedCitation[];
  /**
   * Markers the model emitted that matched no retrieved Chunk. Surfaced for
   * the caller to log — see `resolveCitationMarkers` for why an answer with a
   * dangling marker is kept rather than rejected.
   */
  unresolvedMarkers: number[];
}

/**
 * The answer given when a Notebook has nothing to answer from.
 *
 * Said by the application, not generated: with no grounding, a model's only
 * possible output is a guess, and a guess in a shared Thread is worse than
 * an admission. It also saves a paid call that could not have helped.
 */
export const NO_SOURCES_ANSWER =
  "I have no sources to answer from yet. This Notebook has no Documents that have " +
  "finished ingesting — upload one, or wait for an upload to reach the \"ready\" status, " +
  "and ask again.";

/**
 * The role instruction. Grounding discipline is the whole job: an answer that
 * silently invents a figure is worse than one that says the sources don't
 * cover it, because the user came here to avoid re-reading the documents
 * themselves.
 *
 * It asks for prose organised into paragraphs and headings on purpose. That
 * is already the right shape for a reader, and it is the granularity NBK-11
 * streams at ("paragraph/heading-sized chunks, not token-by-token") — so the
 * upgrade changes how the text is delivered, not what the model is asked for.
 */
export const CHAT_SYSTEM_PROMPT = [
  "You answer questions about a specific set of documents a team has collected.",
  "",
  "Rules:",
  "- Answer only from the provided sources. If they do not contain the answer, say so plainly.",
  "- Never invent figures, names, dates, or quotations. If a source is ambiguous, say what it does say.",
  "- Refer to sources by their filename when it helps the reader check you.",
  // The marker notation is the machine-readable half of the same discipline:
  // "answer only from the sources" is checkable by a reader only if each
  // claim says which passage it came from (NBK-12).
  CITATION_INSTRUCTIONS,
  "- Write prose in Markdown, organised into short paragraphs with headings when the answer has parts.",
  "- Be direct. No preamble about being an AI and no restating of the question.",
].join("\n");

/** How many of a Thread's most recent messages are carried into a question. */
export const HISTORY_MESSAGE_LIMIT = 10;

/**
 * Lays out the grounding the model sees.
 *
 * Shaped around GLOSSARY.md's division of labour between the two artifacts,
 * which are not interchangeable:
 *
 * - The **Chat Snippet** (150-300 words per Document, from ingestion stage 2)
 *   is "written to be injected into the LLM's chat context as grounding about
 *   that source" — so each source is introduced by its own, once, telling the
 *   model what kind of document the passages below it came from.
 * - The **Chunks** are "verbatim, contiguous slice[s] of the Converted
 *   Markdown" — the actual evidence, quoted exactly, under the source they
 *   belong to, with their heading path so the model can say where in the
 *   document a passage sits.
 *
 * Grouping by source rather than listing chunks flat keeps a multi-document
 * answer attributable: the model can tell which document said what instead
 * of blending two sources into one claim.
 *
 * Each passage is additionally labelled with its **source marker** — its
 * 1-based position in retrieval order — which is what the model is asked to
 * cite with and what `resolveCitationMarkers` reads back. Numbering per
 * passage rather than per document is what makes a Citation able to name "one
 * specific chunk" (GLOSSARY.md) instead of just naming a file.
 */
function formatSources(chunks: RetrievedChunk[]): string {
  // A passage's marker is its position in retrieval order, assigned before
  // the grouping rearranges them — so the numbering matches the chunk list
  // `resolveCitationMarkers` later indexes into, whatever order the prompt
  // happens to present them in.
  const markers = new Map(chunks.map((chunk, index) => [chunk.chunkId, index + 1]));

  // Insertion order follows retrieval order, so the document holding the
  // closest passage is presented first.
  const bySource = new Map<string, { filename: string; chatSnippet: string | null; chunks: RetrievedChunk[] }>();
  for (const chunk of chunks) {
    const existing = bySource.get(chunk.documentVersionId);
    if (existing) {
      existing.chunks.push(chunk);
    } else {
      bySource.set(chunk.documentVersionId, {
        filename: chunk.filename,
        chatSnippet: chunk.chatSnippet,
        chunks: [chunk],
      });
    }
  }

  return [...bySource.values()]
    .map((source) => {
      const parts = [`### Source: ${source.filename}`];
      if (source.chatSnippet) parts.push(`About this source: ${source.chatSnippet}`);
      for (const chunk of source.chunks) {
        const location = chunk.headingPath.length > 0 ? ` (under ${chunk.headingPath.join(" > ")})` : "";
        parts.push(`Passage [${markers.get(chunk.chunkId)}]${location}:\n${chunk.text}`);
      }
      return parts.join("\n\n");
    })
    .join("\n\n");
}

/** Renders the Thread so far, so a follow-up question's "it" refers to something. */
function formatHistory(history: ChatMessage[]): string {
  return history
    .slice(-HISTORY_MESSAGE_LIMIT)
    .map((message) => `${message.role === "user" ? "Question" : "Answer"}: ${message.content}`)
    .join("\n\n");
}

/** The answer the application gives when retrieval came back empty. */
const noSourcesAnswer: GroundedAnswer = {
  // Nothing was retrieved, so there is nothing to cite — and the sentence is
  // the application's own, not a claim about any Document.
  text: NO_SOURCES_ANSWER,
  chunks: [],
  citations: [],
  unresolvedMarkers: [],
};

/**
 * Everything that happens before the model is called: embed the question,
 * retrieve the closest Chunks from the Notebook's latest-version `ready`
 * Documents, and lay out the grounding.
 *
 * Shared by the synchronous and the streamed path on purpose. NBK-11 changes
 * only how the generated text is *delivered*, so retrieval, the prompt and
 * the temperature must be literally the same code — otherwise "the persisted
 * result is indistinguishable from the synchronous path's" would be a claim
 * about two prompts that merely look alike.
 *
 * Returns `null` when the Notebook has nothing to answer from.
 */
async function groundQuestion(
  pool: Pool,
  deps: ChatDeps,
  input: { notebookId: string; question: string; history: ChatMessage[] },
): Promise<{ chunks: RetrievedChunk[]; request: { model: string; system: string; user: string; temperature: number } } | null> {
  const [queryEmbedding] = await deps.embed([input.question]);
  const chunks = await retrieveChunks(
    pool,
    input.notebookId,
    queryEmbedding,
    deps.retrievalLimit ?? DEFAULT_RETRIEVAL_LIMIT,
  );
  if (chunks.length === 0) return null;

  const sections = ["## Sources", formatSources(chunks)];
  const history = formatHistory(input.history);
  if (history) sections.push("## The conversation so far", history);
  sections.push("## The question to answer now", input.question);

  return {
    chunks,
    request: {
      model: deps.model,
      system: CHAT_SYSTEM_PROMPT,
      user: sections.join("\n\n"),
      // Low, but not zero: this is an extraction-and-explanation task like
      // the summarizers, where faithfulness to the sources matters more than
      // variety. Matches the default the other LLM callers rely on.
      temperature: 0.2,
    },
  };
}

/**
 * Turns generated prose into a {@link GroundedAnswer}.
 *
 * The markers the model wrote are resolved only against the Chunks that were
 * just retrieved, so a Citation cannot name a passage this answer was not
 * grounded in (NBK-12), and are then located once in their Versions'
 * Converted Markdown so following one can scroll to the passage.
 *
 * Runs on the *complete* text, which is why a streamed answer's Citations
 * arrive at the end rather than alongside the chunk that mentions them: a
 * marker in a half-written answer has no reliable meaning yet.
 */
async function groundedAnswer(pool: Pool, text: string, chunks: RetrievedChunk[]): Promise<GroundedAnswer> {
  const { citations, unresolvedMarkers } = resolveCitationMarkers(text, chunks);
  return { text, chunks, citations: await locateCitations(pool, citations), unresolvedMarkers };
}

/**
 * Answers one question against a Notebook's Documents, in one call.
 *
 * Synchronous and complete, per NBK-10: the answer is returned whole and
 * nothing is observable until it is. Still the path a deployment with no
 * streaming client configured takes, and the reference the streamed path is
 * checked against.
 *
 * Throws if generation fails, so the caller can decline to record a question
 * it has no answer for.
 */
export async function answerQuestion(
  pool: Pool,
  deps: ChatDeps,
  input: { notebookId: string; question: string; history: ChatMessage[] },
): Promise<GroundedAnswer> {
  const grounding = await groundQuestion(pool, deps, input);
  if (!grounding) return noSourcesAnswer;

  const text = await deps.complete(grounding.request);
  return groundedAnswer(pool, text, grounding.chunks);
}

/**
 * The same answer, delivered as it is written (NBK-11).
 *
 * `onChunk` is called once per paragraph- or heading-sized piece, in order,
 * and awaited — so a caller that publishes each one cannot have chunk 4
 * overtake chunk 3. See src/chat/streaming.ts for what decides where a chunk
 * ends; the rule a *caller* needs is that chunks are append-only and never
 * revised.
 *
 * The return value is the same {@link GroundedAnswer} `answerQuestion`
 * produces, assembled from the full text — so the row the caller persists is
 * the same row either path would have produced. That is the point: the
 * chunks are a preview of a result that is only ever written down once.
 *
 * Throws if the stream fails at any point, having emitted whatever chunks had
 * already completed. A caller must then record nothing: the prose a reader
 * saw is a fragment no one can vouch for, and NBK-10's rule — nothing is
 * recorded, asking again is the retry — is exactly as right here.
 *
 * Falls back to `answerQuestion` when no streaming client is configured,
 * delivering the finished answer as a single chunk rather than failing: a
 * client's rendering path is then the same whichever way the server is wired.
 */
export async function streamAnswer(
  pool: Pool,
  deps: ChatDeps,
  input: { notebookId: string; question: string; history: ChatMessage[] },
  onChunk: (text: string) => Promise<void>,
): Promise<GroundedAnswer> {
  if (!deps.stream) {
    const answer = await answerQuestion(pool, deps, input);
    await onChunk(answer.text);
    return answer;
  }

  const grounding = await groundQuestion(pool, deps, input);
  if (!grounding) {
    // Said by the application and already complete, so it is one chunk. It
    // still goes through `onChunk` so every answer a client sees arrives the
    // same way.
    await onChunk(noSourcesAnswer.text);
    return noSourcesAnswer;
  }

  const chunker = createAnswerChunker();
  let text = "";
  for await (const delta of deps.stream(grounding.request)) {
    text += delta;
    for (const chunk of chunker.push(delta)) await onChunk(chunk);
  }
  for (const chunk of chunker.flush()) await onChunk(chunk);

  return groundedAnswer(pool, text, grounding.chunks);
}
