# Ingestion stage 2: metadata and the three summaries

Ingestion stage 2 (NBK-7) takes a Document Version that stage 1 left
`converted` and produces, from its Converted Markdown:

- **extracted metadata** — title, authors, document type, language, date,
  subject, keywords, stored as JSONB; and
- the three **Generated document artifacts** of `GLOSSARY.md`: the **Chat
  Snippet**, the **Executive Summary** and the **Abstract**.

It is its own pg_boss queue (`summarize-document`), chained off stage 1, so
per `docs/adr/0004-pg-boss-jobs-and-listen-notify-sse.md` it retries
independently: a rate-limited OpenRouter call never re-runs a Docling
conversion. Status transitions are published as App Events exactly as stage 1
does.

```
queued → converting → converted → summarizing → summarized
                   ↘ failed                  ↘ failed
```

On a *retryable* failure stage 2 returns the Version to `converted` — the
status it consumes — rather than to `queued` (which would claim the
conversion is owed again) or to `failed` (which would claim no retry is
coming).

## Map-reduce, and why

A Document can run past 200 pages, so no step may assume the document fits in
one prompt. Three passes, in this order:

1. **Split.** `src/ingestion/markdown-sections.ts` splits the Converted
   Markdown on its heading structure — the `MarkdownHeaderTextSplitter`
   equivalent NBK-1 specifies. Each section carries its heading path
   (`["Annual Report", "Risks"]`). The embedding stage will subdivide these
   same sections further.
2. **Map.** Each section is summarized on its own, knowing nothing about the
   others, at most four calls in flight.
3. **Reduce.** The section summaries are reduced into each of the three
   artifacts — one call per artifact, each with its own prompt, word range and
   model. If the section summaries themselves don't fit one prompt, they are
   folded in batches first and the fold repeats.

Metadata extraction runs *before* the summaries, and not only for ordering:
the extracted title, type and authors go into every reduce prompt, so the
summaries know what kind of document they are describing. The extractor sees
the top of the document plus its heading outline, not the whole thing —
title, authors and date live in the front matter of essentially every
document kind.

## Models

All generation goes through OpenRouter. The model is **fixed per task type in
server-side configuration and is never user-selectable** (NBK-1 puts a
user-facing model picker explicitly out of scope). `src/llm/models.ts` is the
only place a model id appears.

| Task                | Default                                    | Env override                         |
| ------------------- | ------------------------------------------ | ------------------------------------ |
| Metadata extraction | `qwen/qwen3-30b-a3b-instruct-2507`         | `OPENROUTER_MODEL_METADATA`          |
| Section summary     | `mistralai/mistral-small-3.2-24b-instruct` | `OPENROUTER_MODEL_SECTION_SUMMARY`   |
| Chat Snippet        | `qwen/qwen3-30b-a3b-instruct-2507`         | `OPENROUTER_MODEL_CHAT_SNIPPET`      |
| Executive Summary   | `qwen/qwen3-235b-a22b-2507`                | `OPENROUTER_MODEL_EXECUTIVE_SUMMARY` |
| Abstract            | `qwen/qwen3-30b-a3b-instruct-2507`         | `OPENROUTER_MODEL_ABSTRACT`          |

Every default is open-weights and Apache-2.0, matching ADR-0002's preference
for open models. Each task has its own slot even where two defaults coincide,
so one task's model can move without dragging the others. The section-summary
pass is the cheapest model because a 200-page document makes dozens of those
calls and unit cost dominates; the Executive Summary gets the strongest one
because it is the longest output and the first thing a human reads.

`OPENROUTER_API_KEY` is required. Without it the backend still starts and
stage 1 still runs, but stage 2 has no worker and Documents stop at
`converted` — the server says so at startup.

## Honouring the three sizes

`GLOSSARY.md` defines the three artifacts partly *by* their sizes, and they
are not interchangeable. `ARTIFACT_SPECS` in
`src/ingestion/generated-artifacts.ts` is the only place those sizes are
written down:

| Artifact          | Size (GLOSSARY.md) | Enforced as    |
| ----------------- | ------------------ | -------------- |
| Chat Snippet      | 150–300 words      | 150–300 words  |
| Executive Summary | 1–2 pages          | 500–1000 words |
| Abstract          | 50–100 words       | 50–100 words   |

"1–2 pages" becomes 500–1000 words at the conventional ~500 words a page,
because a word range is the only form a model can be held to and a test can
assert.

Models do not reliably count. Measured against the real API, an Abstract
asked for at 50–100 words came back at 99, 108, 112 and 126 words across
runs. So the range is enforced in four steps, in order:

1. the prompt states the range;
2. an answer outside it gets **one** corrective rewrite, told the actual count
   and the required range (one, not a loop: models converge on the second try
   or not at all, and the job has its own retry budget to protect);
3. a still-too-long answer is cut back at a boundary that artifact's own
   definition makes safe. All three have one — an artifact defined by its size
   with nothing enforcing that size ships whatever the model felt like
   producing:

   | Artifact          | `trim`        | Cuts at                            |
   | ----------------- | ------------- | ---------------------------------- |
   | Chat Snippet      | `"sentences"` | whole trailing sentences           |
   | Abstract          | `"sentences"` | whole trailing sentences           |
   | Executive Summary | `"sections"`  | whole trailing `#`-headed sections |

   The two prose artifacts are cut by sentence because the sentence is their
   only structure — the Abstract's brief says "no headings, no bullet points,
   no Markdown" outright. The Executive Summary's brief *asks* for "short
   Markdown sections with headings and bullet points", so cutting its trailing
   sentences would end it mid-table, mid-bullet, or on a heading introducing
   content that is no longer there. Its unit is therefore the section:
   everything under a heading goes or stays together, and a fenced code block
   can't be split by a `#` comment inside it being mistaken for a heading.

4. if even that can't bring it into range without dropping below `minWords`,
   the artifact is stored **unchanged** and the out-of-range result is recorded
   in `document_versions.artifact_warnings` (migration 0011), naming the
   artifact, the count it measured and the range it needed.

A still-out-of-range artifact is stored anyway rather than failing the stage:
a slightly-long Abstract is worth far more to a user than a Document stuck in
`failed` because a model would not count. Step 4 exists because that trade is
right and is also how a size guarantee quietly stops being one — it is the
difference between "stored anyway" and "stored anyway, and nobody can tell".
The column is `NULL` when everything fitted, so "nothing to report" is one
value rather than two, and it is deliberately *not* `ingestion_error`, which
records why a stage failed — for operators; what the UI shows a user is the
Version's failure reason (ADR-0009), and a stored-anyway artifact is not a
failure at all.

The residual case is a real one: an over-long Executive Summary with no
internal structure at all is one section, so there is no boundary to cut at
and nothing safe to drop. That is what gets written down.

## Retrying without re-paying for the map pass

Stage 2 is one job making 1 metadata call, one call **per section**, and 3
reductions. On a 200-page document the map pass is dozens of calls and
essentially the whole bill, so a rate-limited *reduction* — the last three
calls — used to discard every section summary with it. NBK-1's operator story
is explicit that a transient failure must not force expensive work to be
redone.

Each section summary is therefore persisted as it completes, in
`document_versions.section_summaries`, keyed by section index and
fingerprinted with a SHA-256 of the Converted Markdown it came from. A retry
reuses what is done and generates only the rest: a failed reduction now costs
its retry three calls instead of forty.

The fingerprint is what makes reuse safe rather than merely fast — stage 1 can
re-run against the same Version id and leave different Markdown behind, and
reducing last attempt's summaries of text that is no longer in the document
would leave every status reading `summarized` with only the content wrong. A
cache whose fingerprint doesn't match is discarded wholesale.

The cache is cleared once stage 2 succeeds: it is work-in-progress, not an
artifact. `generated-artifacts.ts` reaches it through a `SectionSummaryStore`
interface and still touches no database.

`docs/adr/0006-three-ingestion-queues-with-a-resumable-map-pass.md` records why
this is a resumable job rather than one queue per stage named in the spec.

## Two things found by running it for real

Both were found by running stage 2 against the live API, not by the test
suite, and both are now covered by tests:

- **A heading with no body of its own** ("`## 2. Distribution network`" above
  a "`### 2.1 ...`") was sent to the summarizer as an empty prompt, and the
  model invented a whole plausible section — fabricated pipe lengths,
  fabricated customer counts — which then flowed into all three artifacts.
  Empty sections are no longer sent; they remain in the outline and in their
  children's heading paths.
- **A section shorter than its own summary** (a two-line byline) was padded
  out the same way. Anything under 600 characters is now passed through
  verbatim: it cannot be hallucinated, it costs nothing, and the reduce pass
  gets the actual words instead of a summary of them.

The prompts also forbid unit conversion outright, because the summarizer was
restating "3,140 km" as "315 miles" and "13.3 per 100 km" as "18 per 100
miles" — both wrong.

## Reading the results

| Endpoint                                                    | Carries                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /notebooks/:id/documents`                              | each Document's **Abstract** (for cards and search results)                 |
| `GET /notebooks/:id/documents/:documentId`                  | the **latest** Version's metadata, Executive Summary, Chat Snippet, Abstract |
| `GET .../documents/:documentId/versions/:versionId`         | **that** Version's own metadata, Executive Summary, Chat Snippet, Abstract   |
| `GET .../documents/:documentId/versions/:versionId/content` | the **Converted Markdown**                                                   |

Four endpoints, not one payload, because the split follows the artifacts'
consumers: an Abstract belongs in a list, an Executive Summary belongs on an
opened Document, and the Converted Markdown — up to 200+ pages — is fetched
only when a reader expands past the summary.

The third row is the one a Citation reads, and it is a separate endpoint
rather than a parameter on the second because the two answer different
questions: "what does this Document say now" and "what did this Version say".
See `docs/versioning.md`.

The frontend renders both the Executive Summary and the full content through
`MarkdownView`, which runs `marked` and binds the result with `[innerHTML]`
so Angular's own sanitizer strips scripts while headings, lists and tables
survive.

## Tests

`ChatCompleter` (a `(request) => Promise<string>`) is the seam most code
depends on, but the seam-2 job tests deliberately stub **`fetch`** instead, so
request construction and response parsing are under test too and only the
network is fake:

- `apps/backend/test/summarize-document.job.test.ts` — seam-2: the stage-2
  handler against real Postgres, OpenRouter stubbed at its HTTP boundary.
  Covers a single-section document, a multi-section one, empty and short
  sections, the word-range rewrite and trim, and the failure/retry statuses.
- `apps/backend/test/convert-to-markdown.job.test.ts` — that stage 1 hands
  over to stage 2 on success and not on failure.
- `apps/backend/test/job-queue.test.ts` — the chain end to end through
  pg_boss: one enqueue carries a Version to `summarized`.
- `apps/backend/test/documents.route.test.ts` — seam-1: the three read
  endpoints above.
- `apps/frontend/src/app/notebooks/notebook-detail-page.spec.ts` and
  `apps/frontend/src/app/documents/document-detail-page.spec.ts` — seam-3:
  the Abstract on a Document card, and the Executive Summary shown first with
  an action to expand to the rendered Markdown.

**No test makes a real OpenRouter call**, so `pnpm test` costs nothing and
needs no key.

### Verifying against the real API

Measured on a 5.4 KB, 10-section report (`qwen3-30b` / `mistral-small-3.2` /
`qwen3-235b` at the defaults above): **9 calls, ~86 s wall clock, ~$0.002**.
Extrapolated to a 200-page document, where the map pass dominates:
**roughly $0.05 and 5–8 minutes** at four concurrent calls.
