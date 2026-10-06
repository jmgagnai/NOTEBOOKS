# Document Versions: what is searched, and what a Citation keeps

Two sentences in `GLOSSARY.md` carry the whole versioning guarantee, and
NBK-13 exists to show they hold *together* rather than one subsystem at a
time:

- **Document Version** — "Only a Document's latest Version is searched in
  chat; older Versions stay retrievable through Citations that point to them."
- **Citation** — "Following a Citation opens that exact Version at that
  location, even after newer Versions exist."

Four tickets built the halves of that (NBK-5 upload versioning, NBK-8
chunking/embeddings per Version, NBK-9 search, NBK-12 version-pinned
Citations) and each tested its own slice with rows it seeded itself. What
NBK-13 adds is the composition.

## The selection rule, in one place

`apps/backend/src/documents/searchable-versions.ts` holds the `WITH` clause
both retrieval paths use — `search/repository.ts` and `chat/retrieval.ts`.
Before NBK-13 those two had independently derived the same rule in two
different SQL idioms (`JOIN LATERAL` and `DISTINCT ON`), which is two places
for it to drift apart in exactly the way nobody would notice.

The rule is two steps and **the order is the rule**:

1. Per Document, pick the **latest non-deleted Version**.
2. Keep it only if that Version is **`ready`** — tested *after* the Version
   was chosen, never folded into choosing it.

Folding step 2 into step 1 produces "the latest *ready* Version", which looks
equivalent and is not: a Document whose newest Version is still ingesting, or
whose newest Version failed, would silently fall back to serving the previous
Version's Chunks — content the user has already replaced. Instead the Document
leaves retrieval entirely until its newest Version is `ready`. It stays
visible in the Notebook with its status, which is where a user is told to wait
or to retry.

A Document's *listing* deliberately does not share this rule:
`SELECT_DOCUMENTS_WITH_LATEST_VERSION` in `documents/repository.ts` takes step
1 and not step 2, because a Document mid-ingestion is exactly what a user
needs to see.

## What a Citation pins

A Citation stores `(document_version_id, chunk_id)` as written at the moment
the answer was recorded, and both are read back off the pinned rows — never
re-resolved against whatever is current (`migration 0010`, and
`SELECT_CITATIONS` in `chat/repository.ts`). `version_number`, `filename` and
`heading_path` come off the pinned Version and chunk too, so a reader is told
where in *that* Version they are going.

Following one reaches `GET
/notebooks/:id/documents/:documentId/versions/:versionId/content`, which does
not require the Version to be the latest or the parent Document to be
undeleted — only that the Version itself is not deleted.

`chunks` is replaced per Version by ingestion stage 3, and
`citations.chunk_id` has no `ON DELETE`, so Postgres refuses to delete a chunk
a Citation holds. A **re-upload makes a new Version**, whose stage 3 only ever
replaces that new Version's chunks, so the cited rows are never in its way.
Re-driving stage 3 at an already-cited Version by hand is the only route to
that refusal, and it is left loud on purpose.

## Where this is tested

- `apps/backend/test/versioning-integrity.test.ts` — NBK-13, seams 1 and 2
  combined. Nothing in it seeds a `document_versions` row: every Version is
  created by `POST /notebooks/:id/documents` and filled in by the three real
  ingestion job handlers, chained the way pg_boss chains them, against real
  Postgres+pgvector and MinIO with OpenRouter stubbed at `fetch` and Docling
  at the `MarkdownConverter`. It covers the full sequence (upload → ask →
  Citation → re-upload → search again), a re-upload while the previous Version
  is mid-ingestion *and finishing after its successor*, a newest Version that
  failed ingestion, a Citation to v1 after v2 and v3 exist, and the chunk-FK
  edge above.

  Chunk embeddings there are basis vectors of the embedding space, one per
  figure a Version claims ("fourteen weeks", "six weeks", "nine weeks"), so
  "which Version answered this" is readable straight off the similarity score:
  the current Version's figure scores exactly 1 and a superseded Version's
  exactly 0. Every "the new Version is included" assertion is positive — its
  own content in the prompt, its own Abstract in the search result — so the
  test cannot pass merely because retrieval returned nothing.

  It asks its questions down the synchronous answer path, not the streamed one
  (NBK-11). That is enough for *this* guarantee: both paths run the same
  `groundQuestion`, so retrieval and the prompt are literally the same code,
  and NBK-11's `test/chat-streaming.route.test.ts` is what proves the two
  paths persist the same row. A versioning rule cannot differ between them
  without that test failing first.
- `apps/backend/test/searchable-versions.test.ts` — the shared rule on its
  own, including the ordering of its two steps for every non-`ready` status.
- `apps/backend/test/search.route.test.ts`, `test/chat-citations.route.test.ts`
  — the same rules through each caller's own seam (NBK-9, NBK-12).

## Found while verifying this

**Restoring a Document whose filename has since been re-uploaded answered
500.** Filename-collision versioning groups only *non-deleted* Documents
(`idx_documents_notebook_filename_active`, migration 0004), so an upload after
a delete starts a new Document rather than a new Version — and the deleted one
then has nowhere to come back to. `POST .../restore` leaked the raw unique
violation. It now answers **409** naming the filename and saying to delete the
current Document first; the Notebook is left untouched, and the restore
succeeds once the collision is gone.

## Not reachable today

`document_versions.deleted_at` exists and both retrieval paths honour it, but
nothing in the application ever sets it — only Notebooks and Documents are
soft-deleted. The "deleted latest Version falls back to the newest surviving
one" branch is therefore covered at the SQL level
(`test/searchable-versions.test.ts`) and cannot be driven over HTTP. A future
"delete this Version" feature inherits the behaviour already tested.
