# Search across a Notebook

Search is the half of retrieval that isn't chat: a user types the words they
remember and gets back the places in a Notebook where those words occur, in
its Documents and its Chat Threads. Both are searched **by keyword** since
NBK-104 (spec 09). Semantic search by embedding was NBK-9's first answer for
Documents, but a reader at a search box wants to see the word they typed,
not text "about" it. Embeddings remain chat's retrieval tool
(`src/chat/retrieval.ts`).

```
GET /notebooks/:notebookId/search?q=<keywords>           Documents
GET /notebooks/:notebookId/search/threads?q=<keywords>   Chat Threads
```

Behind the auth guard and, per `docs/adr/0001-shared-notebook-access.md`,
with no ownership check: any authenticated user can search any Notebook.
Neither route embeds anything, so neither needs an OpenRouter key or costs
a paid call.

## Matching: words, accents and case ignored

Both routes use Postgres full-text search on one text search configuration,
`simple_unaccent` (migration 0015): `simple`, so no stemming, with every
word run through `unaccent` first.
- **No stemming** is deliberate. Notebooks mix French and English, and one
  language's stemmer mangles the other's words and the names people search
  for. The cost: "planet" does not find "planets".
- **Accents and case are ignored**, both ways: "etretat" and "ÉTRÉTAT" find
  "Étretat".

The query is in web-search syntax (`websearch_to_tsquery`): `"a phrase"`,
`-word` and `or` work. A query that names no word to look for, only
exclusions (`-lupin`) or only punctuation, finds nothing (`namesAWord`).
No index can serve "not this word": on a 45,000-Chunk Notebook such a
query took 24 s to return 20 arbitrary Chunks.

Migration 0015 indexes exactly `to_tsvector('simple_unaccent', …)` on
`chunks.text` and `chat_messages.content`, and the queries match on that
same expression, so they use the GIN indexes. The configuration's name lives
once in TypeScript, `TEXT_SEARCH_CONFIG` in `src/search/keywords.ts`, along
with the Excerpt helpers both routes share.

## Documents: one result per Chunk

A result is a **Chunk**, not a Document. A reader looks for the places a word
occurs, so a Document appears once per Chunk that holds it. Results are
ranked by `ts_rank`, with ties broken by Document age and Chunk position,
and capped at 20.

Each result carries:
- the Document's id, filename and extracted title;
- the heading path the Chunk sits under;
- `match`, the pin a Citation carries (NBK-96): the Version, the Chunk and
  its character range in the Converted Markdown;
- an **Excerpt** (GLOSSARY.md).

The Search page links a result the way a Citation links
(`?version=&chunk=&from=&to=`), so opening it shows the Converted Markdown
scrolled to that Chunk and highlighted. The range is found per query
(`src/documents/chunk-ranges.ts`); a Chunk whose text can't be found in the
Markdown gets a null range and opens unscrolled.

Two filters are applied before anything is matched, both straight out of
GLOSSARY.md:

- **Only `ready` Document Versions are searched.** `ready` "is the end of the
  pipeline and the only status that means a Document is safe to rely on".
- **Only a Document's latest Version is ever matched.** And the `ready` test
  is applied *after* the latest Version is chosen, never as part of choosing
  it, so a Document whose newest Version is still ingesting drops out of
  search entirely rather than answering from the previous Version's Chunks.

A soft-deleted Document, Version or Notebook is invisible here. Both filters
are shared with chat retrieval in `src/documents/searchable-versions.ts` (the
`searchable_versions` `WITH` clause; see `docs/versioning.md`).

### The Excerpt

About two lines (`ts_headline`, 15 to 30 words) around the matches, cut
from the Chunk's text with its Markdown markers stripped first
(`src/search/plain-text.ts`):
- headings' `#`;
- emphasis and code ticks;
- quotes and list bullets;
- table pipes and rules;
- link and image syntax.

An Excerpt is for recognising a match, not for reading layout, so a table
becomes its cells in a row. Backslash escapes (Docling's `file\_name`) and
HTML entities (`&amp;`) come back as the characters they stand for.
Numbered items keep their number, because "2024." may open a sentence.

`ts_headline` cuts one fragment around the matches (`MaxFragments=1`); the
default mode would start at the first match with nothing before it.
`excerpt` in `src/search/keywords.ts` frames the fragment:
- "… " before it and " …" after it, where text was left out;
- the left-out text itself when it is only a few characters, such as the
  sentence's closing punctuation (which a fragment drops) or a number (which
  a fragment never starts or ends on).

One gap is left as is. Matching runs on the Chunk's Markdown, but the
Excerpt is cut from its prose, so a word that occurs only in a link's
address finds the Chunk and shows an Excerpt with nothing bold.

Excerpts travel as **segments** (`{ text, match }`), never markup. The
matches are delimited with private-use characters that stored text never
contains, then split apart, so the client renders text and bold and never
parses HTML. `<` and `>` are swapped for two more private-use characters on
the way through `ts_headline` and swapped back afterwards. Otherwise it
would take `<script>`, or `List<String>` in a code sample, for an HTML tag
and drop it from the Excerpt.

## Chat Threads, by keyword (NBK-97)

```
GET /notebooks/:notebookId/search/threads?q=<keywords>
```

Every question and answer is matched as above, on `simple_unaccent`.
Migration 0014 first indexed it on plain `simple`; 0015 moved the index.

A result is an **Exchange** (GLOSSARY.md): a hit on a question pairs with the
answer after it, and a hit on an answer pairs with the question before it.
An Exchange whose two halves both match is one result, ranked by the two
together. There are at most 20 results, best first. Deleted Chat Threads
(NBK-95) and Notebooks are left out.

The question comes back whole and the answer as up to two Excerpts around
its matches, both as segments, the same way as a Document's Excerpt.

On the page, both searches run at once: Documents first, then Chat Threads,
each section shown only when it has matches or failed (one failing never
hides the other). A result opens the Notebook at
`?thread=<threadId>&message=<answerId>`. `ChatStore.loadThreads` then opens
that Thread even over one already open, and `ThreadView` lands with the
Exchange's question at the top and both halves in the cited Chunk's tint.
That replaces NBK-53's rule 1 for that arrival only. An unknown Thread falls
back to the newest.

## The vector index decision (chat retrieval)

Measured for NBK-9's semantic Document search, which NBK-104 replaced.
Chat retrieval (`src/chat/retrieval.ts`) still ranks Chunks by these
vectors, and some of the measurement carries over to it, but not all:
- **Carries over:** pgvector cannot index a 2560-dimension column, and the
  exact scan's cost per Chunk is the same for chat's query.
- **Does not carry over:** the argument that an ANN index "cannot serve
  this query's shape". It was about search's `MIN()` roll-up per Document.
  Chat's query is a plain `ORDER BY embedding <=> $q LIMIT k`, the shape
  HNSW serves, so a `halfvec` + HNSW index is a real option for chat, at the
  recall cost measured below.

What follows is the original measurement.

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

- `apps/backend/test/search.route.test.ts`: seam 1, the real Fastify app
  through `app.inject()` against a real Postgres container with seeded
  Chunks. The app is built with no embedder, which proves search needs no
  OpenRouter key. It covers:
  - the 401;
  - a Chunk found with its Excerpt, title, heading path and range;
  - one result per Chunk;
  - accents and case;
  - stripped Markdown;
  - ranking and the cap of 20;
  - `-word`;
  - latest-ready-Version-only matching;
  - deleted Documents, other Notebooks and a deleted Notebook (404);
  - a blank query;
  - markup kept as text.
- `apps/backend/test/search-threads.route.test.ts`: the same seam for Chat
  Threads (NBK-97), with accents (NBK-104).
- `apps/backend/test/searchable-versions.test.ts`: the shared
  latest-then-`ready` rule on its own, for every non-`ready` status.
- `apps/frontend/src/app/search/search-page.spec.ts`: seam 3, the real page
  and `SearchStore` behind the real router, mocking only the generated
  `SearchService`. It covers:
  - Chunk rows, their Excerpt and link;
  - Exchange rows;
  - sections and their failures;
  - the query in the URL;
  - Back reusing the results.

**No test makes a real OpenRouter call**, so `pnpm test` costs nothing and
needs no key.
