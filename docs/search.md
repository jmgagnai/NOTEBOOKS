# Search across a Notebook's Documents

Search (NBK-9) is the half of retrieval that isn't chat: a user types keywords
or a topic and gets back the Documents in a Notebook that are about it, each
with its **Abstract** — per GLOSSARY.md the 50–100 word artifact "used in
search results, search-result previews, and document cards", written "to be
skimmed in a list, not to stand in for the full document".

```
GET /notebooks/:notebookId/search?q=<query>&limit=<n>
```

Behind the auth guard and, per `docs/adr/0001-shared-notebook-access.md`,
with no ownership check — any authenticated user can search any Notebook.

## What one request does

1. **Embeds the query**, through the same `Embedder` ingestion stage 3
   embedded the Chunks with (`src/llm/embeddings.ts`, ADR-0002). It has to be
   the same model on both sides: comparing one model's vector against
   another's is meaningless, which is why `server.ts` builds one embedder and
   hands it to both the job worker and the app.
2. **Ranks Chunks** by vector similarity, within one Notebook.
3. **Rolls the matches up to their parent Document** and returns each
   Document with its Abstract, best match first.

Two filters are applied before anything is ranked, both straight out of
GLOSSARY.md:

- **Only `ready` Document Versions are searched.** `ready` "is the end of the
  pipeline and the only status that means a Document is safe to rely on".
- **Only a Document's latest Version is ever matched.** And the `ready` test
  is applied *after* the latest Version is chosen, never as part of choosing
  it — so a Document whose newest Version is still ingesting drops out of
  search entirely rather than quietly answering from the previous Version's
  Chunks, which would serve content the user has already replaced.

A soft-deleted Document, and a soft-deleted Version, are both invisible here.

Both filters are shared with chat retrieval rather than written twice: they
live in `src/documents/searchable-versions.ts` as the `searchable_versions`
`WITH` clause, which this query and `src/chat/retrieval.ts` both open with.
NBK-9 and NBK-12 had independently derived the same rule in two different SQL
idioms, and NBK-13 consolidated them — see `docs/versioning.md`.

## Rolled up to the Document, scored by its best Chunk

Retrieval ranks Chunks, but a *result* is a Document: `MIN(distance) ...
GROUP BY` is what makes a Document appear once however many of its passages
matched. A Document's score is its single best Chunk rather than an average,
because one strongly matching passage is exactly what makes a 200-page
document worth opening — averaging would bury it under a short document that
is mildly on-topic throughout.

The response is `documentSchema` plus a `score`, deliberately: a search
result and a document card show the same thing, so the frontend renders one
type in both places and the Abstract is already on it.

### The best Chunk travels with the result (NBK-96)

Each result also carries `match`: its best Chunk's Version id, Chunk id, and
character range in that Version's Converted Markdown. That's the same pin a
Citation carries (NBK-12). The Search page links a result the way a Citation
links (`?version=&chunk=&from=&to=`), so opening it shows the Converted Markdown
scrolled to that Chunk and highlighted. A Chunk whose text can't be found
in the Markdown gets a null range and opens unscrolled.

The range is found the way a Citation's is (`src/documents/chunk-ranges.ts`,
a forward scan over the Version's Chunks), but per query rather than once:
each search reads its results' Converted Markdown. That is at most `limit`
Versions, bounded and only on a search the user ran. If it shows up in the
latency, the range could be stored on the Chunk at ingestion instead.

### Why cosine distance (`<=>`) and not inner product (`<#>`)

Qwen3-Embedding-4B returns L2-normalised vectors — ‖v‖ = 1.0000, measured
again during this ticket's live check — so for this data the two operators
rank *identically* and the choice is about everything other than ordering.
Cosine wins twice:

- It is bounded in [0, 2] whatever the magnitudes, so `1 - distance` is a
  similarity a human and a UI can both read. pgvector's `<#>` returns the
  *negative* inner product, whose range depends on the vectors.
- It stays correct if a future embedding model (or an
  `OPENROUTER_MODEL_EMBEDDING` override) returns vectors that are not
  normalised, where inner product would silently start ranking by length.

## The index decision

Migration `0007` left this open on purpose: "a decision for the retrieval
ticket, with real data to measure, not a guess made here". **The decision is
to stay exact** — see `docs/adr/0005-exact-vector-scan-over-ann-index.md`.
The measurement behind it, against pgvector 0.8.7 in the same
`pgvector/pgvector:pg16` container the tests use, on a corpus of random
L2-normalised 2560-dimension vectors at 700 Chunks per Document (what NBK-8's
live run produced from a 150-page document):

| Documents | Chunks | `chunks` size | Exact scan (median) | p95 |
| --- | --- | --- | --- | --- |
| 1 | 700 | 8.8 MB | **10 ms** | 12 ms |
| 10 | 7,000 | 85 MB | **62 ms** | 68 ms |
| 50 | 35,000 | 425 MB | **488 ms** | 873 ms |
| 100 | 70,000 | 849 MB | **1,127 ms** | 3,587 ms |

And the alternatives, at 70,000 Chunks:

| Option | Build | Storage | Query | Agreement with exact top 10 |
| --- | --- | --- | --- | --- |
| `vector(2560)`, no index (shipped) | — | 849 MB | 1,127 ms | — |
| `vector(2560)` + HNSW / ivfflat | **impossible** | — | — | — |
| `halfvec(2560)` column, no index | 35 s backfill | +820 MB | **806 ms** | 10/10 (still exact) |
| `halfvec(2560)` + HNSW, top-200 roll-up | 334 s (1 worker) | +820 MB col, +547 MB index | **8 ms** | **2/10** |

Three things in that table decide it:

- **pgvector cannot index this column at all.** Both methods answer `column
  cannot have more than 2000 dimensions for hnsw index` (and the same for
  ivfflat) — re-confirmed here, as NBK-8 found. The only index available is
  on a *duplicated* `halfvec(2560)` column.
- **An HNSW index cannot serve this query's shape.** `EXPLAIN` on the
  `MIN()`-roll-up confirms the planner does not use the index: ANN serves
  `ORDER BY ... LIMIT k` only. Using it means a different query — top-k
  Chunks globally, then roll up — which is a different *answer*: a Document
  whose best Chunk misses the global cut disappears, and that is why
  agreement with the exact top ten is 2/10 here.
- **The scan is not the bottleneck at realistic sizes.** Embedding the query
  takes ~400 ms of OpenRouter round trip in the same request (measured live,
  below); a 10–62 ms scan over one to ten 150-page Documents is noise beside
  it.

What is given up: latency grows linearly with a Notebook's Chunk count, and a
Notebook holding a hundred 150-page Documents will feel slow (~1 s, p95
worse). When that happens the cheapest step is the `halfvec` column **with no
index** — 28% faster for an identical top ten, because it is still an exact
scan, just over half the bytes. The ANN rewrite comes after that, and needs a
recall measurement against real embeddings first.

> **Caveat on the recall number.** The corpus is uniformly random vectors.
> That is faithful for *scan cost*, which is bytes read times distance
> operations and does not care what the numbers are — but it is adversarial
> for *ANN recall*, since random points in 2560 dimensions are all nearly
> equidistant. Real embeddings cluster, so 2/10 understates what HNSW would
> actually recall. It is enough to say the ANN path cannot be adopted without
> measuring recall on real embeddings; it is not enough to say HNSW is bad.

## Tests

`Embedder` is the seam, but the seam-1 test stubs **`fetch`** underneath it —
the same choice stages 2 and 3 make — so the query's embedding request is
built and parsed by the real code and only the network is fake.

- `apps/backend/test/search.route.test.ts` — seam-1: the real Fastify app
  through `app.inject()`, against a real Postgres+pgvector container with
  seeded Chunks. Covers the 401, the ranking and the Abstract on each result,
  that the query itself is embedded through the configured model, the
  roll-up, the `ready`-only filter, the no-fallback-to-an-older-Version rule,
  latest-Version-only matching, a deleted latest Version, Notebook scoping
  and soft-deleted Documents, the 404, a blank query, `limit`, and the 503
  when no embedding model is configured.
  Chunk embeddings in that test are **basis vectors** of the embedding space:
  cosine similarity between two distinct axes is exactly 0 and between an
  axis and itself exactly 1, so every expected score is a known-good literal
  rather than something recomputed the way the code computes it.
- `apps/backend/test/searchable-versions.test.ts` — the shared
  latest-then-`ready` rule on its own, for every non-`ready` status.
- `apps/backend/test/versioning-integrity.test.ts` — NBK-13: the same rule
  from a real upload through a real ingestion run, where a re-upload's
  supersession and an old Citation's survival are checked in one sequence.
- `apps/frontend/src/app/search/search-page.spec.ts` — seam-3: the real page
  and `SearchStore`, mocking only the generated `SearchService`. Covers
  results rendered with their Abstract, no request before a search is
  submitted, "no matches" told apart from "nothing searched yet", a failed
  search's message, a blank query, and the link from a result to its
  Document.
- `apps/frontend/src/app/notebooks/notebook-detail-page.spec.ts` — that a
  Notebook links to its search page.

**No test makes a real OpenRouter call**, so `pnpm test` costs nothing and
needs no key.

### Verified against the real API

Run outside the test suite with `OPENROUTER_API_KEY` set: three short,
clearly unrelated documents (cooking, distributed consensus, coastal birds),
embedded for real and stored as nine Chunks, then searched with real query
embeddings.

| Query | Top result | Score | Next best |
| --- | --- | --- | --- |
| "how do replicas agree on a value when the network splits" | distributed-consensus.md | 0.737 | 0.364 |
| "what to do with dried chickpeas" | mediterranean-cooking.md | 0.664 | 0.369 |
| "identifying shorebirds in winter" | coastal-birds.md | 0.661 | 0.379 |
| "quorum" | distributed-consensus.md | 0.519 | 0.374 |

The right Document ranked first every time, including for the single word
"quorum", which appears in no Abstract and only inside one Chunk — the point
of embedding rather than matching text. Every vector came back 2560-dimension
and L2-normalised (‖v‖ = 1.0000).

Two numbers worth keeping from that run:

- **End-to-end latency 400–600 ms** on a nine-Chunk corpus — essentially all
  of it the OpenRouter embeddings round trip. That is the floor for any
  search, and the reason the exact scan's 10–62 ms at realistic corpus sizes
  does not matter.
- **A relevant Document scores 0.52–0.74; an irrelevant one 0.23–0.38.**
  There is a real gap, so a relevance *threshold* is feasible — but three
  documents is not enough data to pick one, so search currently returns the
  top `limit` Documents ranked and filters nothing. Everything in a Notebook
  that is `ready` is therefore a potential result; the ordering is what
  carries the relevance. Choosing a cut-off is a tuning decision for a later
  ticket, with these numbers as its starting point.
