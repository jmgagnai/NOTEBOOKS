/**
 * One generation request. Deliberately narrower than OpenAI's chat API: a
 * system instruction and a single user turn is everything the ingestion
 * pipeline needs, and keeping the shape small is what lets every caller be
 * read without also reading a message-array builder.
 */
export interface ChatCompletionRequest {
  /** An OpenRouter model id. Comes from `TaskModels` — never from a user. */
  model: string;
  /** The role instruction: what the model is, and what shape to answer in. */
  system: string;
  /** The content to work on. */
  user: string;
  /** Cap on generated tokens. Omitted, the provider's default applies. */
  maxOutputTokens?: number;
  /** Sampling temperature. Defaults to 0.2 — these are extraction tasks. */
  temperature?: number;
}

/**
 * The seam between everything that needs generation and OpenRouter: hand it
 * a request, get the assistant's text back.
 *
 * A plain function type for the same reason `MarkdownConverter` is one (see
 * src/ingestion/docling.ts): it's the narrowest thing a caller can depend on,
 * and a test can supply any implementation. Note, though, that the seam-2
 * tests stub *`fetch`* rather than this function, so the request building and
 * response parsing below stay under test.
 */
export type ChatCompleter = (request: ChatCompletionRequest) => Promise<string>;

/**
 * The same seam, for callers that want the answer while it is still being
 * written: hand it a request, get the assistant's text back as the provider
 * emits it.
 *
 * An async iterable of **raw provider deltas** — typically a few characters
 * each — and deliberately nothing more. Deciding what a *reader* should be
 * shown is not this file's job: NBK-11 wants paragraph/heading-sized pieces,
 * a future caller might want something else, and neither belongs in the
 * transport. See src/chat/streaming.ts for the buffering that turns these
 * into something worth rendering.
 *
 * Yielding rather than taking a callback so a consumer's backpressure is the
 * loop it is already writing, and so `try`/`finally` around the loop is
 * enough to release the connection.
 */
export type ChatStreamer = (request: ChatCompletionRequest) => AsyncIterable<string>;

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  /** OpenRouter API key. Required — this never reads `process.env` itself. */
  apiKey: string;
  /** Overrides the API root; only tests and a proxy deployment need this. */
  baseUrl?: string;
  /** The HTTP boundary. Injected so seam-2 tests can stub the network. */
  fetch?: typeof globalThis.fetch;
  /** Attempts after the first, for retryable failures. Defaults to 2. */
  retries?: number;
  /** Base delay between attempts, in ms. Defaults to 500 (doubling). */
  retryDelayMs?: number;
  /** Hard cap on one request, in ms. Defaults to 120000. */
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
}

/**
 * HTTP statuses worth another attempt. 429 is the one that actually happens
 * (NBK-1 names "a rate-limited OpenRouter call" as the motivating transient
 * failure); 5xx covers a provider blip.
 *
 * Everything else — 400 on a malformed request, 401 on a bad key, 404 on a
 * retired model id — is a configuration problem that will fail identically
 * forever, so it fails fast rather than burning the job's retry budget.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** The option defaults both clients share, resolved once. */
function resolveOptions(options: OpenRouterOptions) {
  if (!options.apiKey) {
    throw new Error("An OpenRouter API key is required. Set OPENROUTER_API_KEY.");
  }
  return {
    apiKey: options.apiKey,
    url: `${(options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "")}/chat/completions`,
    doFetch: options.fetch ?? globalThis.fetch,
    retries: options.retries ?? 2,
    retryDelayMs: options.retryDelayMs ?? 500,
    timeoutMs: options.timeoutMs ?? 120_000,
  };
}

/**
 * The HTTP request both clients send. The only difference between them is
 * `stream`, which is exactly why this is written once: a header, a
 * temperature or a message-array shape that drifted between the streaming
 * and non-streaming paths would make a streamed answer subtly unlike the
 * synchronous one it is supposed to be indistinguishable from (NBK-11).
 */
function chatCompletionRequestInit(
  apiKey: string,
  request: ChatCompletionRequest,
  { stream, timeoutMs }: { stream: boolean; timeoutMs: number },
): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      // OpenRouter attributes traffic by these; harmless but polite, and it
      // makes this app's spend identifiable in the OpenRouter dashboard.
      "http-referer": "https://github.com/rag-notebook",
      "x-title": "RAG Notebook",
      ...(stream ? { accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify({
      model: request.model,
      temperature: request.temperature ?? 0.2,
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      ...(stream ? { stream: true } : {}),
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    }),
    // AbortSignal.timeout rather than a manual timer: a hung connection must
    // not pin a pg_boss worker, or a waiting user, for longer than this.
    signal: AbortSignal.timeout(timeoutMs),
  };
}

/**
 * Builds the real OpenRouter-backed completer.
 *
 * Retries live here, *inside* one job attempt, as well as in pg_boss around
 * the whole stage. Both are wanted: a rate-limit on the 40th section of a
 * 200-page document should cost a 500ms wait, not a re-run of the 39 sections
 * before it. pg_boss stays the backstop for anything that outlives these
 * attempts.
 */
export function createOpenRouterCompleter(options: OpenRouterOptions): ChatCompleter {
  const { apiKey, url, doFetch, retries, retryDelayMs, timeoutMs } = resolveOptions(options);

  async function attempt(request: ChatCompletionRequest): Promise<{ text?: string; retryable: boolean; error?: string }> {
    const response = await doFetch(
      url,
      chatCompletionRequestInit(apiKey, request, { stream: false, timeoutMs }),
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        retryable: isRetryableStatus(response.status),
        error: `OpenRouter returned ${response.status} for model ${request.model}: ${body.slice(0, 500)}`,
      };
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    if (payload.error?.message) {
      // OpenRouter can report an upstream provider failure in a 200 body.
      return { retryable: true, error: `OpenRouter error for model ${request.model}: ${payload.error.message}` };
    }
    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.trim() === "") {
      return { retryable: true, error: `OpenRouter returned no content for model ${request.model}.` };
    }
    return { retryable: false, text };
  }

  return async function complete(request: ChatCompletionRequest): Promise<string> {
    let lastError = `OpenRouter call for model ${request.model} never ran.`;
    for (let i = 0; i <= retries; i += 1) {
      let outcome: Awaited<ReturnType<typeof attempt>>;
      try {
        outcome = await attempt(request);
      } catch (err) {
        // A thrown fetch is a transport problem (DNS, socket, timeout) —
        // always worth another attempt.
        outcome = { retryable: true, error: err instanceof Error ? err.message : String(err) };
      }

      if (outcome.text !== undefined) return outcome.text;
      lastError = outcome.error ?? lastError;
      if (!outcome.retryable || i === retries) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** i));
    }
    throw new Error(lastError);
  };
}

/** One frame of OpenRouter's OpenAI-compatible streaming response. */
interface ChatCompletionChunk {
  choices?: { delta?: { content?: string | null } }[];
  error?: { message?: string };
}

/**
 * The sentinel an OpenAI-compatible stream ends with. Not JSON, so it has to
 * be recognised before parsing rather than after.
 */
const STREAM_DONE = "[DONE]";

/** Matches the blank line that separates two SSE frames, in either newline style. */
const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * Pulls the assistant's text deltas out of an OpenAI-compatible
 * `text/event-stream` body.
 *
 * Framing details that are not optional in practice:
 *
 * - Frames are separated by a blank line and one frame can straddle two TCP
 *   reads, so a buffer is kept and only complete frames are consumed.
 * - A line starting with `:` is an SSE *comment*, and OpenRouter really does
 *   send them (`: OPENROUTER PROCESSING`) as keepalives while a request waits
 *   in a provider's queue. Only `data:` lines are read, so they fall away.
 * - A `delta` with no `content` is normal: the first frame carries the role
 *   and the last carries `finish_reason`.
 */
async function* decodeDeltas(body: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const separator = FRAME_SEPARATOR.exec(buffer);
        if (!separator) break;
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);

        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice("data:".length).trim();
          if (payload === "") continue;
          if (payload === STREAM_DONE) return;

          let chunk: ChatCompletionChunk;
          try {
            chunk = JSON.parse(payload) as ChatCompletionChunk;
          } catch {
            // An unparseable frame is not the answer, and not a reason to
            // throw the answer away: skipped, the way the SSE spec says an
            // unrecognised field is ignored.
            continue;
          }
          // OpenRouter can report an upstream provider failure mid-stream.
          // It has to surface as a throw: the prose yielded so far is a
          // fragment, and a caller that mistook it for a finished answer
          // would write half an answer down.
          if (chunk.error?.message) {
            throw new Error(`OpenRouter error for model ${model}: ${chunk.error.message}`);
          }
          const content = chunk.choices?.[0]?.delta?.content;
          if (typeof content === "string" && content !== "") yield content;
        }
      }
    }
  } finally {
    // Releases the connection whether the consumer ran the loop to the end,
    // broke out of it, or threw.
    await reader.cancel().catch(() => {});
  }
}

/**
 * Builds the real OpenRouter-backed streamer (NBK-11): the same request
 * {@link createOpenRouterCompleter} sends, with `stream: true`, yielding the
 * assistant's text as the provider writes it.
 *
 * **Retries stop at the first delta, deliberately.** Before any text has been
 * yielded nothing is observable yet, so a 429 or a dead socket is retried
 * exactly as the non-streaming client retries it. After the first delta a
 * retry could only replay prose a reader has already seen or splice two
 * different answers together, so the error is thrown instead and the caller
 * decides — which for NBK-11 means recording nothing and inviting the user to
 * ask again, the same as a failed synchronous answer.
 *
 * An empty stream (a 200 that says nothing) throws too, matching the
 * completer's "returned no content" rule: an empty answer in a shared Thread
 * is worse than an error.
 */
export function createOpenRouterStreamer(options: OpenRouterOptions): ChatStreamer {
  const { apiKey, url, doFetch, retries, retryDelayMs, timeoutMs } = resolveOptions(options);

  return async function* stream(request: ChatCompletionRequest): AsyncGenerator<string> {
    let lastError = `OpenRouter stream for model ${request.model} never ran.`;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const backoff = (): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));

      let body: ReadableStream<Uint8Array>;
      try {
        const response = await doFetch(
          url,
          chatCompletionRequestInit(apiKey, request, { stream: true, timeoutMs }),
        );
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          lastError = `OpenRouter returned ${response.status} for model ${request.model}: ${text.slice(0, 500)}`;
          if (!isRetryableStatus(response.status) || attempt === retries) break;
          await backoff();
          continue;
        }
        if (!response.body) {
          lastError = `OpenRouter returned no stream body for model ${request.model}.`;
          if (attempt === retries) break;
          await backoff();
          continue;
        }
        body = response.body;
      } catch (err) {
        // A thrown fetch is a transport problem (DNS, socket, timeout) and
        // nothing has been yielded yet, so it is still retryable.
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === retries) break;
        await backoff();
        continue;
      }

      // Past here the answer is in flight, and everything throws rather than
      // retrying — see the note above.
      let yielded = 0;
      for await (const delta of decodeDeltas(body, request.model)) {
        yielded += 1;
        yield delta;
      }
      if (yielded === 0) {
        throw new Error(`OpenRouter returned no content for model ${request.model}.`);
      }
      return;
    }

    throw new Error(lastError);
  };
}
