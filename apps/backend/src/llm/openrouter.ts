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
  const baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 120_000;

  if (!options.apiKey) {
    throw new Error("An OpenRouter API key is required. Set OPENROUTER_API_KEY.");
  }

  async function attempt(request: ChatCompletionRequest): Promise<{ text?: string; retryable: boolean; error?: string }> {
    // AbortSignal.timeout rather than a manual timer: a hung connection must
    // not pin a pg_boss worker for the whole job timeout.
    const response = await doFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        // OpenRouter attributes traffic by these; harmless but polite, and it
        // makes this app's spend identifiable in the OpenRouter dashboard.
        "http-referer": "https://github.com/rag-notebook",
        "x-title": "RAG Notebook",
      },
      body: JSON.stringify({
        model: request.model,
        temperature: request.temperature ?? 0.2,
        ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

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
