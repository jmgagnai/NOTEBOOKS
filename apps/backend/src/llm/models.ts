/**
 * Which OpenRouter model runs which generation task.
 *
 * Per NBK-1: "the specific model is fixed per task type via server-side
 * configuration, not user-selectable in V1" — a user-facing model picker is
 * explicitly out of scope. So this is the only place a model id appears, and
 * the only way to change one is an environment variable on the server.
 *
 * Every default is an open-weights, Apache-2.0 model, matching the project's
 * existing preference for open models (ADR-0002 picked an open embedding
 * model over a proprietary one). Each task gets its own slot even where two
 * defaults coincide, so one task's model can be moved without dragging the
 * others with it.
 */
export interface TaskModels {
  /** Pulls title/authors/type/... out of the front of a document as JSON. */
  metadata: string;
  /** The map pass: one call per header-delimited section. */
  sectionSummary: string;
  /** The reduce pass for the Chat Snippet (150-300 words, model-facing). */
  chatSnippet: string;
  /** The reduce pass for the Executive Summary (1-2 pages, human-facing). */
  executiveSummary: string;
  /** The reduce pass for the Abstract (50-100 words, human-facing). */
  abstract: string;
  /** One grounded chat answer, from retrieved Chunks and Chat Snippets. */
  chatAnswer: string;
}

/**
 * Why each default:
 *
 * - `metadata` — Qwen3-30B-A3B-Instruct follows "answer with JSON only"
 *   reliably and is cheap; a 262k context means the front matter of even a
 *   huge document fits without truncation games.
 * - `sectionSummary` — this is the *per-section* pass, so a 200-page document
 *   makes dozens of these calls and unit cost dominates. Mistral Small 3.2 is
 *   the cheapest capable summarizer here, and a section summary is a short,
 *   mechanical job.
 * - `executiveSummary` — the longest output and the one a human reads first,
 *   so it gets the strongest open model (Qwen3-235B-A22B, a sparse MoE whose
 *   input price is low despite its size).
 * - `chatSnippet` / `abstract` — short, tightly-constrained outputs where
 *   instruction-following (hitting a word range) matters more than prose
 *   flair; the same mid-size Qwen3 as metadata.
 * - `chatAnswer` — the one output a user reads *as the product*, and the one
 *   where an invented figure does real damage, so it gets the strongest open
 *   model available (the same Qwen3-235B-A22B as the Executive Summary).
 *   Unlike the ingestion tasks this is one call per question rather than
 *   dozens per document, so unit cost barely matters next to answer quality
 *   and grounding discipline. A sparse MoE also keeps latency acceptable for
 *   a request a user is sitting and waiting on.
 */
export const DEFAULT_TASK_MODELS: TaskModels = {
  metadata: 'qwen/qwen3-30b-a3b-instruct-2507',
  sectionSummary: 'mistralai/mistral-small-3.2-24b-instruct',
  chatSnippet: 'qwen/qwen3-30b-a3b-instruct-2507',
  executiveSummary: 'qwen/qwen3-235b-a22b-2507',
  abstract: 'qwen/qwen3-30b-a3b-instruct-2507',
  chatAnswer: 'qwen/qwen3-235b-a22b-2507',
};

/** The environment variable that overrides each task's model. */
export const TASK_MODEL_ENV_VARS: Record<keyof TaskModels, string> = {
  metadata: 'OPENROUTER_MODEL_METADATA',
  sectionSummary: 'OPENROUTER_MODEL_SECTION_SUMMARY',
  chatSnippet: 'OPENROUTER_MODEL_CHAT_SNIPPET',
  executiveSummary: 'OPENROUTER_MODEL_EXECUTIVE_SUMMARY',
  abstract: 'OPENROUTER_MODEL_ABSTRACT',
  chatAnswer: 'OPENROUTER_MODEL_CHAT_ANSWER',
};

/**
 * Resolves the per-task models from the environment, falling back to
 * {@link DEFAULT_TASK_MODELS}. Takes the environment as an argument so this
 * is a pure function and a caller can resolve against something other than
 * `process.env`.
 */
export function resolveTaskModels(
  env: Record<string, string | undefined> = process.env,
): TaskModels {
  const resolved = { ...DEFAULT_TASK_MODELS };
  for (const task of Object.keys(TASK_MODEL_ENV_VARS) as (keyof TaskModels)[]) {
    const override = env[TASK_MODEL_ENV_VARS[task]]?.trim();
    if (override) resolved[task] = override;
  }
  return resolved;
}

/**
 * The embedding model for ingestion stage 3 (NBK-8), per ADR-0002:
 * OpenRouter-hosted Qwen3-Embedding-4B rather than a self-hosted bge-m3
 * sidecar.
 *
 * Kept out of {@link TaskModels} on purpose. Those are generation tasks and
 * moving one is a pure configuration change; this one is welded to the
 * database — every stored vector has {@link EMBEDDING_DIMENSIONS} components
 * and `chunks.embedding` is declared that wide — so changing it means
 * re-embedding every chunk. ADR-0002 calls that "a real migration, not a
 * config change", and these two constants sitting together is the reminder.
 */
export const DEFAULT_EMBEDDING_MODEL = 'qwen/qwen3-embedding-4b';

/** Overrides {@link DEFAULT_EMBEDDING_MODEL}. See the dimension warning above. */
export const EMBEDDING_MODEL_ENV_VAR = 'OPENROUTER_MODEL_EMBEDDING';

/**
 * How many components a Qwen3-Embedding-4B vector has on OpenRouter.
 *
 * **Measured, not assumed.** NBK-1 requires this be "confirmed before the
 * schema migration is written", and OpenRouter's embeddings catalogue
 * publishes no dimension for this model — so it was confirmed by calling
 * `POST /api/v1/embeddings` against the live API and counting what came
 * back: 2560, Qwen3-Embedding-4B's full hidden size, for both a single input
 * and a batch.
 *
 * It must stay equal to the width of `chunks.embedding` in migration
 * `0007_create_chunks.sql`, which is why stage 3 refuses a vector of any
 * other length rather than letting Postgres reject the insert later.
 */
export const EMBEDDING_DIMENSIONS = 2560;

/**
 * Resolves the embedding model from the environment. Same shape and same
 * reasoning as {@link resolveTaskModels} — server-side configuration only,
 * never user-selectable (NBK-1 puts a model picker out of scope).
 *
 * An override that does not return {@link EMBEDDING_DIMENSIONS}-component
 * vectors will be rejected chunk-by-chunk by stage 3 rather than corrupting
 * the column; swapping the model for real needs a migration.
 */
export function resolveEmbeddingModel(
  env: Record<string, string | undefined> = process.env,
): string {
  return env[EMBEDDING_MODEL_ENV_VAR]?.trim() || DEFAULT_EMBEDDING_MODEL;
}
