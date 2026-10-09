# Ingestion stage 3: chunking and embeddings

Ingestion stage 3 (NBK-8) takes a Document Version that stage 2 left
`summarized` and, from its Converted Markdown, produces the rows chat will
later be grounded in: **chunks**, each with its heading path and its
embedding vector. Completing it is what makes the Version searchable, so it
is also what moves the Version to `ready`.

It is its own pg_boss queue (`embed-chunks`), chained off stage 2, so per
`docs/adr/0004-pg-boss-jobs-and-listen-notify-sse.md` it retries
independently: a rate-limited embeddings call never re-runs a Docling
conversion and never regenerates the three summaries. Status transitions are
published as App Events exactly as stages 1 and 2 do.

```
queued → converting → converted → summarizing → summarized → indexing → ready
                   ↘ failed                  ↘ failed                ↘ failed
```

On a *retryable* failure stage 3 returns the Version to `summarized` — the
status it consumes — rather than to `failed` (which would claim no retry is
coming). `indexing` is GLOSSARY.md's own word for this stage: it tells the
reader to "reserve 'indexing' for the embedding/retrieval stage
specifically".

## Chunking: two passes

Per NBK-1, and in this order:

1. **Heading split.** `src/ingestion/markdown-sections.ts` — the same
   `MarkdownHeaderTextSplitter` equivalent stage 2 already maps over. One
   splitter used by both stages, so a chunk's heading path and a section
   summary's are the same notion of "where".
2. **Recursive character split, within each section.**
   `src/ingestion/chunking.ts` — `chunk_size=1000`, `chunk_overlap=150`
   characters.

Splitting *within* a section rather than across the whole document is what
guarantees no chunk straddles two headings, so every chunk has exactly one
true heading path. A heading with no body of its own contributes no chunk —
there is nothing to embed — but still appears in its children's paths.

The recursive pass prefers, strongest first: a paragraph break, then a line
break, then a sentence end, then a space, and only then a mid-word cut. That
hierarchy *is* Markdown's own structure — a blank line separates block
elements — so a cut falls between a paragraph and a list rather than through
a table row.

Two properties are deliberate and under test:

- **Chunk text is a verbatim, contiguous slice of the Converted Markdown.**
  The splitter keeps every separator it splits on, so concatenating its
  pieces reproduces the input exactly. A Citation (GLOSSARY.md) points at one
  chunk, and following it has to find that passage in the document the reader
  is shown — which it cannot do if the chunker quietly rewrote whitespace.
- **The heading path travels beside the text, not prepended to it.** It is a
  `TEXT[]` column, which is also what lets a later retrieval query filter or
  display by it.

## Embeddings

| | |
| --- | --- |
| Endpoint | `POST https://openrouter.ai/api/v1/embeddings` (OpenAI-compatible) |
| Model | `qwen/qwen3-embedding-4b` |
| Env override | `OPENROUTER_MODEL_EMBEDDING` |
| Dimension | **2560** |
| Batch size | 32 chunks per request |

Per ADR-0002 this is OpenRouter-hosted rather than a self-hosted bge-m3
sidecar, which keeps the Python surface limited to Docling conversion alone.
`src/llm/models.ts` is the only place the model id appears, and it is
server-side configuration only — never user-selectable (NBK-1 puts a model
picker out of scope).

### Confirming the dimension

NBK-1 requires the pgvector column be sized to "whatever dimension this
model's OpenRouter listing reports, confirmed before the schema migration is
written, rather than assuming a number". Two things were found doing that:

- `GET /api/v1/models` does **not** list embedding models at all. They are on
  a separate endpoint, `GET /api/v1/embeddings/models` (33 models, including
  `qwen/qwen3-embedding-4b` and `qwen/qwen3-embedding-8b`).
- That listing publishes no dimension field — `context_length`, pricing and
  modality (`text->embeddings`), but nothing about output width.

So it was confirmed the only way left: by calling the endpoint for real and
counting what came back. It is **2560**, Qwen3-Embedding-4B's full hidden
size, for a single input and for a batch alike. `EMBEDDING_DIMENSIONS` in
`src/llm/models.ts` and `vector(2560)` in
`src/db/migrations/0007_create_chunks.sql` must stay equal, which is why
stage 3 rejects a vector of any other length itself rather than letting the
insert fail with a type error.

The returned vectors are already L2-normalised (‖v‖ = 1.0000 as measured), so
cosine distance and inner product rank identically — worth knowing for the
retrieval ticket.

### Batching

OpenRouter's endpoint accepts an array `input` and answers with `data`
entries each carrying its own `index`. Stage 3 sends 32 chunks per request:
a 150-page document is ~700 chunks, and one round trip each would dominate
the stage. Vectors are reordered by the reported `index`, never by arrival —
a vector attached to the wrong chunk is a wrong Citation that nothing
downstream could detect, so a test scripts the responses in reverse order on
purpose.

Batches are sent one after another rather than all at once, the same choice
stage 2's map pass makes: firing every request at a rate-limited API
simultaneously is the fastest way to be throttled, and this is a background
job where throughput matters more than latency.

## Storage

`chunks` (migration `0007`): `document_version_id`, `chunk_index`,
`heading_path TEXT[]`, `text`, `embedding vector(2560)`, with
`UNIQUE (document_version_id, chunk_index)`.

A re-run **replaces** a Version's chunks — delete then insert, in one
transaction — rather than upserting. A retry (or a re-run after the chunker
itself changed) can legitimately produce *fewer* chunks than the attempt
before it, and an upsert would leave the surplus behind: stale passages a
Citation could still point at.

It also stores where each Chunk sits in the Converted Markdown (NBK-107):
one `chunk_ranges` row per Chunk that can be found, from the same forward
scan Citations use (`locateInMarkdown`), and it stamps the Version
`chunk_ranges_located_at`, all in the same transaction. A search then opens
a result at its Chunk without rescanning the Document; see `docs/search.md`.

There is deliberately **no ivfflat or HNSW index** on `embedding`. pgvector
caps both at 2000 dimensions and these vectors are 2560 — verified against
pgvector 0.8.7, which answers `column cannot have more than 2000 dimensions
for hnsw index`. Similarity search is therefore an exact scan within one
Notebook's chunks. Indexing it later means either storing a `halfvec(2560)`
alongside (HNSW allows 4000 half-precision dimensions — also verified) or
reducing the dimension; both are decisions for the retrieval ticket, with
real data to measure, rather than a guess made here.

## Tests

`Embedder` (a `(texts: string[]) => Promise<number[][]>`) is the seam, but
the seam-2 job test deliberately stubs **`fetch`** instead, so request
construction and response parsing are under test too and only the network is
fake — the same choice stage 2's tests make:

- `apps/backend/test/embed-chunks.job.test.ts` — seam-2: the stage-3 handler
  against real Postgres with pgvector, OpenRouter stubbed at its HTTP
  boundary. Covers the happy path to `ready`, a long section split into
  overlapping chunks that tile it, heading paths across a multi-section
  document, batching and index-based pairing, the replace-on-re-run
  behaviour, the retryable and terminal failure statuses, a dimension
  mismatch, and missing Converted Markdown.
- `apps/backend/test/summarize-document.job.test.ts` — that stage 2 hands
  over to stage 3 on success and not on failure.
- `apps/backend/test/job-queue.test.ts` — the whole chain through pg_boss:
  one enqueue of stage 1 carries a Version to `ready`.
- `apps/frontend/src/app/notebooks/notebook-detail-page.spec.ts` — seam-3:
  the status badge following a Document through `indexing` to `ready`.

**No test makes a real OpenRouter call**, so `pnpm test` costs nothing and
needs no key.

### Verified against the real API

Measured twice, with `OPENROUTER_API_KEY` set, outside the test suite.

| Document | Chars | Chunks | Requests | Wall clock | Prompt tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| `docs/ingestion-summaries.md` | 9,446 | 16 | 1 | 1.5 s | 2,586 | $0.000052 |
| ~150 pages (382 KB) | 382,076 | 696 | 22 | 38.4 s | 96,372 | $0.0019 |

Every vector came back at 2560 dimensions. Extrapolated to a 200-page
document: roughly **900 chunks, 30 requests, under a minute, ~$0.0025** — an
order of magnitude cheaper than stage 2's summaries on the same document.

### One thing found by running it for real

The 9 KB run produced a chunk of **1061 characters**, over NBK-1's
`chunk_size=1000`. The overlap was the cause: a chunk ending on a long
paragraph carries that paragraph's 150-character tail into the next chunk,
and when the following paragraph is itself near the full budget, tail +
paragraph exceeds it. Alternating long and short paragraphs triggers it —
which is what a real document's prose-then-aside rhythm looks like.

It is now fixed by giving up overlap rather than the size (the size is the
budget every downstream prompt is built on), and covered by a test using
that same alternating shape.
