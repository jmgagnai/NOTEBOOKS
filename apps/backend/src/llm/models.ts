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
 */
export const DEFAULT_TASK_MODELS: TaskModels = {
  metadata: "qwen/qwen3-30b-a3b-instruct-2507",
  sectionSummary: "mistralai/mistral-small-3.2-24b-instruct",
  chatSnippet: "qwen/qwen3-30b-a3b-instruct-2507",
  executiveSummary: "qwen/qwen3-235b-a22b-2507",
  abstract: "qwen/qwen3-30b-a3b-instruct-2507",
};

/** The environment variable that overrides each task's model. */
export const TASK_MODEL_ENV_VARS: Record<keyof TaskModels, string> = {
  metadata: "OPENROUTER_MODEL_METADATA",
  sectionSummary: "OPENROUTER_MODEL_SECTION_SUMMARY",
  chatSnippet: "OPENROUTER_MODEL_CHAT_SNIPPET",
  executiveSummary: "OPENROUTER_MODEL_EXECUTIVE_SUMMARY",
  abstract: "OPENROUTER_MODEL_ABSTRACT",
};

/**
 * Resolves the per-task models from the environment, falling back to
 * {@link DEFAULT_TASK_MODELS}. Takes the environment as an argument so this
 * is a pure function and a caller can resolve against something other than
 * `process.env`.
 */
export function resolveTaskModels(env: Record<string, string | undefined> = process.env): TaskModels {
  const resolved = { ...DEFAULT_TASK_MODELS };
  for (const task of Object.keys(TASK_MODEL_ENV_VARS) as (keyof TaskModels)[]) {
    const override = env[TASK_MODEL_ENV_VARS[task]]?.trim();
    if (override) resolved[task] = override;
  }
  return resolved;
}
