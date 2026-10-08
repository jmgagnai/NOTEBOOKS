import {
  isUnavailableStatus,
  OPENROUTER_BASE_URL,
  withProviderRetries,
  type ProviderAttempt,
} from './openrouter.js';

/**
 * The seam between everything that needs embeddings and OpenRouter: hand it
 * texts, get one vector per text back, in the same order.
 *
 * A plain function type, for the same reason `ChatCompleter` and
 * `MarkdownConverter` are: it's the narrowest thing a caller can depend on.
 * Note that the model is bound at construction rather than passed per call —
 * unlike generation, there is exactly one embedding model, and it is welded
 * to the width of `chunks.embedding` (see `EMBEDDING_DIMENSIONS`). A caller
 * that could choose a model per call could silently store vectors of two
 * different shapes in one column.
 *
 * Batching is this function's business, not its caller's: it takes every
 * text at once so it can decide how many go in a request.
 */
export type Embedder = (texts: string[]) => Promise<number[][]>;

export interface OpenRouterEmbedderOptions {
  /** OpenRouter API key. Required — this never reads `process.env` itself. */
  apiKey: string;
  /** The embedding model id. From `resolveEmbeddingModel()`, never a user. */
  model: string;
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
  /** How many texts go in one request. Defaults to {@link DEFAULT_BATCH_SIZE}. */
  batchSize?: number;
}

/**
 * How many chunks go in one embeddings request.
 *
 * OpenRouter's embeddings endpoint is OpenAI-compatible and accepts an array
 * `input`, which is the whole reason to batch: a 200-page document is
 * hundreds of chunks, and one HTTP round trip each would dominate the
 * stage's runtime. 32 keeps a single request's payload modest (32 × ~1000
 * characters) so one transient failure re-sends little, while cutting the
 * request count by more than an order of magnitude. Verified against the
 * live API, which returns `data` entries carrying their own `index`.
 */
export const DEFAULT_BATCH_SIZE = 32;

interface EmbeddingsResponse {
  data?: { index?: number; embedding?: number[] }[];
  error?: { message?: string };
}

/**
 * HTTP statuses worth another attempt — the same set, and the same reasoning,
 * as `openrouter.ts`: 429 is the one that actually happens, 5xx covers a
 * provider blip, and everything else is a configuration problem that would
 * fail identically forever.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Builds the real OpenRouter-backed embedder (ADR-0002).
 *
 * Retries live here, inside one job attempt, as well as in pg_boss around the
 * whole stage — both are wanted for the same reason as in `openrouter.ts`: a
 * rate limit on the last batch of a 200-page document should cost a 500ms
 * wait, not a re-chunk and re-embed of everything before it.
 */
export function createOpenRouterEmbedder(options: OpenRouterEmbedderOptions): Embedder {
  const baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);

  if (!options.apiKey) {
    throw new Error('An OpenRouter API key is required. Set OPENROUTER_API_KEY.');
  }

  async function attempt(batch: string[]): Promise<ProviderAttempt<number[][]>> {
    const response = await doFetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
        // Same attribution headers as the chat completer: harmless, and it
        // makes this app's spend identifiable in the OpenRouter dashboard.
        'http-referer': 'https://github.com/rag-notebook',
        'x-title': 'RAG Notebook',
      },
      body: JSON.stringify({ model: options.model, input: batch }),
      // AbortSignal.timeout rather than a manual timer: a hung connection must
      // not pin a pg_boss worker for the whole job timeout.
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        retryable: isRetryableStatus(response.status),
        unavailable: isUnavailableStatus(response.status),
        error: `OpenRouter returned ${response.status} for embedding model ${options.model}: ${body.slice(0, 500)}`,
      };
    }

    const payload = (await response.json()) as EmbeddingsResponse;
    if (payload.error?.message) {
      // OpenRouter can report an upstream provider failure in a 200 body.
      return {
        retryable: true,
        unavailable: true,
        error: `OpenRouter error for embedding model ${options.model}: ${payload.error.message}`,
      };
    }

    const entries = payload.data;
    if (!Array.isArray(entries) || entries.length !== batch.length) {
      return {
        retryable: true,
        // A wrong count is a malformed answer, not an outage (NBK-66).
        unavailable: false,
        error:
          `OpenRouter returned ${entries?.length ?? 0} embeddings for ${batch.length} inputs ` +
          `(model ${options.model}).`,
      };
    }

    // Ordered by the `index` the API reports, not by arrival: the whole point
    // of batching is that one request carries many chunks, and a vector
    // attached to the wrong chunk is a wrong Citation that nothing downstream
    // could detect.
    const vectors = new Array<number[]>(batch.length);
    for (const [position, entry] of entries.entries()) {
      const index = entry.index ?? position;
      if (
        !Array.isArray(entry.embedding) ||
        index < 0 ||
        index >= batch.length ||
        vectors[index] !== undefined
      ) {
        return {
          retryable: true,
          unavailable: false,
          error: `OpenRouter returned a malformed embedding for model ${options.model}.`,
        };
      }
      vectors[index] = entry.embedding;
    }
    return { retryable: false, unavailable: false, value: vectors };
  }

  function embedBatch(batch: string[]): Promise<number[][]> {
    return withProviderRetries(() => attempt(batch), {
      retries,
      retryDelayMs,
      neverRan: `OpenRouter embedding call for model ${options.model} never ran.`,
    });
  }

  return async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Batches run one after another rather than all at once. The map pass in
    // stage 2 bounds its concurrency for the same reason (see
    // generated-artifacts.ts): firing every request at a rate-limited API
    // simultaneously is the fastest way to be throttled, and this is a
    // background job where total throughput matters more than latency.
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      vectors.push(...(await embedBatch(texts.slice(start, start + batchSize))));
    }
    return vectors;
  };
}
