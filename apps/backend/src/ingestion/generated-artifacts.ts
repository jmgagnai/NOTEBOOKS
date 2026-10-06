import { z } from "zod";
import type { ChatCompleter } from "../llm/openrouter.js";
import type { TaskModels } from "../llm/models.js";
import { splitMarkdownSections, type MarkdownSection } from "./markdown-sections.js";

/**
 * Metadata extracted from a Document Version's Converted Markdown.
 *
 * Every field is nullable or an empty array by default: a model that cannot
 * find an author in a document must be able to say so, and "the extractor
 * found nothing" has to be representable without inventing a value. Nothing
 * here is required, which is also why it is stored as JSONB rather than as
 * typed columns.
 */
export const documentMetadataSchema = z.object({
  title: z.string().nullable().default(null),
  authors: z.array(z.string()).default([]),
  documentType: z.string().nullable().default(null),
  language: z.string().nullable().default(null),
  publishedOn: z.string().nullable().default(null),
  subject: z.string().nullable().default(null),
  keywords: z.array(z.string()).default([]),
});
export type DocumentMetadata = z.infer<typeof documentMetadataSchema>;

/**
 * The three Generated document artifacts of GLOSSARY.md, in the only place
 * their sizes are written down.
 *
 * They are three distinct artifacts, not three lengths of one summary, and
 * each has a different consumer — so each gets its own prompt, its own word
 * range, and (via `TaskModels`) its own model. "1-2 pages" is expressed as
 * 500-1000 words at the conventional ~500 words a page, because a word range
 * is the only form a model can be held to and a test can assert.
 */
export interface ArtifactSpec {
  minWords: number;
  maxWords: number;
  /** What this artifact is and who reads it — goes into the system prompt. */
  brief: string;
  /**
   * Whether an over-long answer may be cut back by dropping whole trailing
   * sentences.
   *
   * True only for the artifacts that are plain prose *by definition*. For
   * structured Markdown (the Executive Summary) the same operation would
   * strand a heading over nothing, so that one is only ever re-asked for.
   */
  trimmable: boolean;
}

export const ARTIFACT_SPECS = {
  // "Optimized for a model to read, not a human" (GLOSSARY.md).
  chatSnippet: {
    minWords: 150,
    maxWords: 300,
    brief:
      "a Chat Snippet: a dense, factual description of this document that will be injected into another " +
      "language model's context as grounding about this source. Write it for a model to read, not a human: " +
      "no preamble, no hedging, no marketing tone. State what the document is, what it covers, the entities, " +
      "dates and figures that identify it, and what kinds of question it can answer.",
    // Prose by definition, so a too-long answer can be cut back safely.
    trimmable: true,
  },
  // "Shown first when a user opens a document" (GLOSSARY.md).
  executiveSummary: {
    minWords: 500,
    maxWords: 1000,
    brief:
      "an Executive Summary: a one-to-two-page summary of this document's key points for a human reader who " +
      "will decide from it whether to read the full document. Use short Markdown sections with headings and " +
      "bullet points where they help. Cover the document's purpose, its main findings or provisions, and any " +
      "conclusions, obligations or figures a reader must not miss.",
    // Structured Markdown: cutting trailing sentences would leave a heading
    // over nothing, so this one is only ever re-asked for.
    trimmable: false,
  },
  // "Written to be skimmed in a list, not to stand in for the full document"
  // (GLOSSARY.md).
  abstract: {
    minWords: 50,
    maxWords: 100,
    brief:
      "an Abstract: a single short paragraph describing what this document is, to be skimmed in a list of " +
      "search results and on a document card. Plain prose, no headings, no bullet points, no Markdown. It " +
      "must help a reader judge relevance at a glance — it does not stand in for the document.",
    // "Plain prose, no headings" above is exactly what makes the trim safe.
    trimmable: true,
  },
} as const satisfies Record<string, ArtifactSpec>;

export type ArtifactName = keyof typeof ARTIFACT_SPECS;

/** The three artifacts, as produced for one Document Version. */
export type GeneratedArtifacts = Record<ArtifactName, string>;

/** Counts words the way the prompts and the specs mean them. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * A model asked for JSON will sometimes wrap it in a ```json fence or
 * preface it with a sentence. Pulling the outermost braces out is more
 * reliable than instructing harder, and a fenced-or-not answer must not fail
 * a whole ingestion stage.
 */
function parseJsonObject(text: string): unknown {
  const withoutFence = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`Expected a JSON object in the model's answer, got: ${text.slice(0, 200)}`);
  }
  return JSON.parse(withoutFence.slice(start, end + 1));
}

/** How much of one section's text is sent in its map-pass prompt. */
const SECTION_CHAR_BUDGET = 24_000;
/**
 * Below this, a section's text is used as its own "summary" instead of being
 * sent to the model.
 *
 * A section summary is capped at 120 words — roughly 800 characters — so
 * asking for a summary of less text than that cannot shorten anything; it can
 * only invite the model to pad. Verified against the real API: given a
 * two-line byline, the summarizer invented an entire report's worth of
 * figures. Passing the text through is free, strictly faithful, and gives the
 * reduce pass the actual words.
 */
const SECTION_PASSTHROUGH_CHARS = 600;
/** How much text the metadata extractor sees, from the top of the document. */
const METADATA_CHAR_BUDGET = 12_000;
/** How many section summaries one reduce prompt may carry. */
const REDUCE_CHAR_BUDGET = 120_000;
/** Concurrent map-pass calls. */
const DEFAULT_MAP_CONCURRENCY = 4;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n[truncated]`;
}

/**
 * Cuts `text` back under `spec.maxWords` by dropping whole trailing
 * sentences, or returns it unchanged if that can't be done without falling
 * below `spec.minWords`.
 *
 * This is the last line of defence on the sizes GLOSSARY.md gives the three
 * artifacts. Verified against the real API: asked for 50-100 words, the
 * model returns 99, 108, 112, 126 — in range about half the time, and the
 * corrective rewrite does not reliably fix it. For the Abstract that is not
 * cosmetic, because being skimmable on a card is what the Abstract *is*.
 *
 * Whole sentences, never a word cap: an Abstract ending mid-clause reads as
 * a bug, and a card is exactly where a user would see it.
 */
export function trimToWordRange(text: string, spec: ArtifactSpec): string {
  if (!spec.trimmable || countWords(text) <= spec.maxWords) return text;

  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g);
  if (!sentences) return text;

  const kept: string[] = [];
  let words = 0;
  for (const sentence of sentences) {
    const next = words + countWords(sentence);
    if (next > spec.maxWords) break;
    kept.push(sentence);
    words = next;
  }

  const trimmed = kept.join("").trim();
  // Better a slightly-long artifact than one cut below the length its
  // definition requires.
  return words >= spec.minWords ? trimmed : text;
}

/** `"Annual Report > Risks"`, or a placeholder for the pre-heading preamble. */
export function describeSection(section: MarkdownSection): string {
  return section.headingPath.length > 0 ? section.headingPath.join(" > ") : "(document preamble)";
}

export interface GenerationDeps {
  complete: ChatCompleter;
  models: TaskModels;
  /** Parallel map-pass calls. Defaults to 4. */
  mapConcurrency?: number;
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving
 * order. Bounded because the map pass over a 200-page document is dozens of
 * calls and firing them all at once is the fastest way to get rate-limited.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Extracts metadata from the top of a document plus its heading outline.
 *
 * Only the top, not the whole document: title, authors, type and date live in
 * the front matter of essentially every document kind, and sending 200 pages
 * to find them would cost more than the rest of this stage put together. The
 * outline is included because it is cheap and it is what distinguishes a
 * contract from a report when the first page is ambiguous.
 */
export async function extractMetadata(
  deps: GenerationDeps,
  { filename, markdown, sections }: { filename: string; markdown: string; sections: MarkdownSection[] },
): Promise<DocumentMetadata> {
  const outline = sections
    .filter((section) => section.heading !== null)
    .slice(0, 80)
    .map((section) => `${"  ".repeat(Math.max(0, section.level - 1))}- ${section.heading}`)
    .join("\n");

  const answer = await deps.complete({
    model: deps.models.metadata,
    system:
      "You extract bibliographic metadata from documents. Answer with a single JSON object and nothing else. " +
      'Schema: {"title": string|null, "authors": string[], "documentType": string|null, "language": string|null, ' +
      '"publishedOn": string|null, "subject": string|null, "keywords": string[]}. ' +
      "`documentType` is a short noun phrase such as \"contract\", \"annual report\", \"research paper\", " +
      '"meeting notes". `language` is a BCP-47 code such as "en". `publishedOn` is whatever date or year the ' +
      "document states, copied verbatim. Use null or [] for anything the document does not state — never guess, " +
      "and never infer an author from the filename.",
    user: [
      `Filename: ${filename}`,
      "",
      "Heading outline:",
      outline || "(no headings)",
      "",
      "Beginning of the document:",
      truncate(markdown, METADATA_CHAR_BUDGET),
    ].join("\n"),
    maxOutputTokens: 800,
  });

  return documentMetadataSchema.parse(parseJsonObject(answer));
}

/**
 * The map pass: one summary per header-delimited section, each generated
 * independently and knowing nothing about the others.
 *
 * This is what makes a 200-page Document summarizable at all — no prompt here
 * ever holds more than one section.
 */
export async function summarizeSections(deps: GenerationDeps, sections: MarkdownSection[]): Promise<string[]> {
  return mapWithConcurrency(sections, deps.mapConcurrency ?? DEFAULT_MAP_CONCURRENCY, async (section) => {
    // Shorter than a summary would be: pass it through rather than asking a
    // model to "shorten" it (see SECTION_PASSTHROUGH_CHARS).
    if (section.content.length <= SECTION_PASSTHROUGH_CHARS) {
      return `## ${describeSection(section)}\n${section.content}`;
    }

    const summary = await deps.complete({
      model: deps.models.sectionSummary,
      system:
        "You summarize one section of a larger document. Produce a compact factual summary of at most 120 " +
        "words covering this section's specific claims, figures, names and dates. Do not editorialise, do not " +
        "add context the section does not contain, and do not mention that you are summarizing. " +
        // Added after live verification against OpenRouter: without this, the
        // map pass silently restated "3,140 km" as "315 miles" and
        // "13.3 per 100 km" as "18 per 100 miles" — both wrong. A summary of
        // a technical document whose numbers have quietly changed is worse
        // than no summary, and it poisons every reduce pass downstream.
        "Copy every number, unit and currency exactly as the section states it. Never convert between units, " +
        "never round, and never restate a figure in a different measurement system.",
      user: [`Section: ${describeSection(section)}`, "", truncate(section.content, SECTION_CHAR_BUDGET)].join("\n"),
      maxOutputTokens: 400,
    });
    return `## ${describeSection(section)}\n${summary.trim()}`;
  });
}

/**
 * Collapses section summaries until they fit one reduce prompt.
 *
 * Usually a no-op: section summaries are a small fraction of the document.
 * But the whole point of map-reduce here is that *no* step assumes the input
 * fits, so when they don't, neighbouring summaries are summarized together
 * and the fold repeats. Without this a sufficiently enormous Document would
 * fail at exactly the step that was supposed to make it possible.
 */
export async function foldSectionSummaries(deps: GenerationDeps, sectionSummaries: string[]): Promise<string> {
  let current = sectionSummaries;
  let joined = current.join("\n\n");

  while (joined.length > REDUCE_CHAR_BUDGET && current.length > 1) {
    const groupSize = Math.max(2, Math.ceil(current.length / Math.ceil(joined.length / REDUCE_CHAR_BUDGET)));
    const groups: string[][] = [];
    for (let i = 0; i < current.length; i += groupSize) groups.push(current.slice(i, i + groupSize));

    current = await mapWithConcurrency(groups, deps.mapConcurrency ?? DEFAULT_MAP_CONCURRENCY, async (group) =>
      (
        await deps.complete({
          model: deps.models.sectionSummary,
          system:
            "You merge several section summaries of one document into a single shorter summary of at most 250 " +
            "words, keeping the concrete facts, figures and names and dropping repetition.",
          user: group.join("\n\n"),
          maxOutputTokens: 700,
        })
      ).trim(),
    );
    joined = current.join("\n\n");
  }

  return joined;
}

/**
 * Generates one artifact from the folded section summaries, then — if the
 * answer missed its word range — asks once for a corrected rewrite.
 *
 * The one corrective pass is there because the sizes in GLOSSARY.md are part
 * of what each artifact *is*: an Abstract that runs to 400 words is not a
 * long Abstract, it is an Executive Summary in the wrong field, and it would
 * break the Document card it was written for. One retry rather than a loop:
 * models converge on the second try or not at all, and this is inside a job
 * that already has its own retry budget to protect.
 */
export async function reduceToArtifact(
  deps: GenerationDeps,
  artifact: ArtifactName,
  { filename, metadata, summaryContext }: { filename: string; metadata: DocumentMetadata; summaryContext: string },
): Promise<string> {
  const spec = ARTIFACT_SPECS[artifact];
  const model = deps.models[artifact];
  const system =
    `You write ${spec.brief}\n\n` +
    // Same grounding discipline as the map pass, for the same reason: these
    // artifacts are read as statements about the document, so a figure that
    // is not in the section summaries must not appear in them.
    "Use only what the section summaries below state. Do not add facts, do not infer figures, and copy every " +
    "number, unit and currency exactly as given — never converting between units or measurement systems.\n\n" +
    `Length: between ${spec.minWords} and ${spec.maxWords} words. Answer with the ${artifact} text only — no ` +
    "title, no preamble, no explanation of what you produced.";
  const user = [
    `Document: ${metadata.title ?? filename}`,
    metadata.documentType ? `Type: ${metadata.documentType}` : null,
    metadata.authors.length > 0 ? `Authors: ${metadata.authors.join(", ")}` : null,
    "",
    "Section summaries of the document, in order:",
    "",
    summaryContext,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const first = (
    await deps.complete({ model, system, user, maxOutputTokens: Math.ceil(spec.maxWords * 2) + 200 })
  ).trim();
  const count = countWords(first);
  if (count >= spec.minWords && count <= spec.maxWords) return first;

  const corrected = (
    await deps.complete({
      model,
      system,
      user:
        `${user}\n\nA previous attempt came out at ${count} words, which is outside the required ` +
        `${spec.minWords}-${spec.maxWords} word range. Rewrite it to land inside that range, ` +
        `${count > spec.maxWords ? "cutting the least important material" : "adding the detail that is missing"}. ` +
        "Keep it factual and grounded in the section summaries above.\n\nPrevious attempt:\n" +
        first,
      maxOutputTokens: Math.ceil(spec.maxWords * 2) + 200,
    })
  ).trim();

  // Whichever attempt is closer to the range is kept rather than failing the
  // stage: a slightly-off artifact is worth far more to a user than a
  // Document stuck in "failed" because a model would not count.
  const distance = (text: string): number => {
    const n = countWords(text);
    return n < spec.minWords ? spec.minWords - n : Math.max(0, n - spec.maxWords);
  };
  const best = distance(corrected) <= distance(first) ? corrected : first;

  // Last resort, and only for the artifacts that are plain prose: cut whole
  // trailing sentences so the size GLOSSARY.md requires actually holds,
  // rather than depending on the model having counted.
  return trimToWordRange(best, spec);
}

export interface GenerationResult {
  metadata: DocumentMetadata;
  artifacts: GeneratedArtifacts;
  /** How many header-delimited sections the map pass ran over. */
  sectionCount: number;
}

/**
 * The whole of stage 2's generation work for one Document Version: metadata
 * first, then map-reduce over the header-delimited sections into the three
 * artifacts.
 *
 * Order is deliberate and specified by NBK-1/NBK-7 — metadata extraction,
 * then the summaries — and it is not merely sequencing: the extracted title,
 * type and authors go into every reduce prompt, so the summaries know what
 * kind of document they are describing.
 *
 * Pure in the sense that matters: it touches no database and publishes no
 * events. Its only effect is OpenRouter calls.
 */
export async function generateArtifacts(
  deps: GenerationDeps,
  { filename, markdown }: { filename: string; markdown: string },
): Promise<GenerationResult> {
  const sections = splitMarkdownSections(markdown);
  const wholeDocument: MarkdownSection = {
    headingPath: [],
    heading: null,
    level: 0,
    content: markdown.trim(),
  };

  // Headings that only introduce subsections ("## 2. Distribution network"
  // above a "### 2.1 ...") have no body of their own. They are kept for the
  // outline the metadata extractor sees — and they still appear in their
  // children's heading paths — but they are never sent to the map pass.
  //
  // This is not an optimisation. Verified against the real OpenRouter API:
  // handed an empty section, the summarizer invents a plausible one, and
  // those fabricated figures then flow into all three reduced artifacts.
  // There is nothing to summarize, so there is nothing to ask.
  const summarizable = sections.filter((section) => section.content !== "");

  // A document with no headings at all (a plain .txt, say) still has to be
  // summarized, as does one that is nothing but an outline.
  const effectiveSections: MarkdownSection[] = summarizable.length > 0 ? summarizable : [wholeDocument];

  const metadata = await extractMetadata(deps, {
    filename,
    markdown,
    sections: sections.length > 0 ? sections : [wholeDocument],
  });
  const sectionSummaries = await summarizeSections(deps, effectiveSections);
  const summaryContext = await foldSectionSummaries(deps, sectionSummaries);

  // Sequential, in the order GLOSSARY.md lists them, so the three calls are
  // easy to follow in a log and in a test's recorded call list. They are also
  // three different models, so parallelism would buy little beyond latency on
  // a path that is already a background job.
  const chatSnippet = await reduceToArtifact(deps, "chatSnippet", { filename, metadata, summaryContext });
  const executiveSummary = await reduceToArtifact(deps, "executiveSummary", { filename, metadata, summaryContext });
  const abstract = await reduceToArtifact(deps, "abstract", { filename, metadata, summaryContext });

  return {
    metadata,
    artifacts: { chatSnippet, executiveSummary, abstract },
    sectionCount: effectiveSections.length,
  };
}
