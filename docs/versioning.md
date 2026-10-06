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

Following one reaches two Version-scoped reads, neither of which requires the
Version to be the latest or the parent Document to be undeleted — only that
the Version itself is not deleted (and that its Notebook is; see "A deleted
Notebook" below):

- `GET /notebooks/:id/documents/:documentId/versions/:versionId` — that
  Version's own extracted metadata and three Generated document artifacts,
  plus `isLatestVersion` and `latestVersionNumber`.
- `GET .../versions/:versionId/content` — that Version's Converted Markdown.

## Why the Version has its own detail endpoint

`GET .../documents/:documentId` is, and must remain, "this Document as it
stands now": it carries `latestVersion` and the latest Version's artifacts,
because that is what opening a Document from the Notebook means.

Following a Citation is a different question — "what did this Version say" —
and answering it with the Document endpoint produces a page that is **two
Versions at once**: the pinned Version's Converted Markdown beneath the
latest Version's Executive Summary, extracted metadata and version badge. The
summary describes one document, the text another, and the badge sides with the
wrong one. That is not a cosmetic mismatch; version-pinning is the entire
value of a Citation, and a reader who cannot tell which half of the page
belongs to the answer they followed has lost it. No notice can repair it,
because the notice can only say "these disagree".

So the pinned Version gets a read of its own, and every field in it describes
that Version: `version`, `status` (that Version's own ingestion status — a
superseded Version that reached `ready` stays `ready` while its successor
converts), `metadata`, `abstract`, `chatSnippet`, `executiveSummary`.
`isLatestVersion` and `latestVersionNumber` are the only facts about any other
Version, and they exist so the page can place the reader in the Document's
history ("you are reading v1; v3 is current") without a second request.

The frontend normalises both reads into one `OpenDocument` view model
(`documents.store.ts`), so the page renders one shape and the only thing that
differs is which Version it is about. That is deliberate: a template that can
reach for `latestVersion` on a page deliberately not showing the latest
Version is how the blend happened in the first place.

`docs/adr/0007-reading-a-document-is-its-own-route.md` records why the Version
is addressed by id rather than by its ordinal, and why there is no
list-versions endpoint.

## A deleted Notebook takes its contents with it

Orthogonal to all of the above, and easy to confuse with it. A soft-deleted
**Document** stays readable through a Citation — that is the guarantee this
document is about. A soft-deleted **Notebook** is the opposite: the user
deleted the container, and nothing inside it answers until they restore it,
however alive the Document and Version rows are.

Listing routes always enforced that by asking `notebookExists` first. Reading
*one* Document or *one* Chat Thread by id did not, so a caller holding an id
could read a deleted Notebook's contents straight back out. The rule now lives
once, in `notebooks/active-notebooks.ts`, and every by-id read and write goes
through it — `findDocumentDetail`, `findDocumentVersionDetail`,
`findDocumentContent`, `findDownloadableVersion`, `findChatThread` and
`renameChatThread`. `notebookExists` is expressed in terms of the same
predicate, so there is literally one definition of "this Notebook is still
there".

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

`document_versions.deleted_at` exists and every read path honours it, but
nothing in the application ever sets it — only Notebooks and Documents are
soft-deleted. The "deleted latest Version falls back to the newest surviving
one" branch is therefore covered at the SQL level
(`test/searchable-versions.test.ts`) and cannot be driven over HTTP. A future
"delete this Version" feature inherits the behaviour already tested.

The column is dormant, not speculative: NBK-5's acceptance criteria name
`documents` and `document_versions` as "both soft-deletable", and the filter is
already in eight queries (`searchable-versions.ts`, the four Version-scoped
reads, and the three ingestion Stages' input lookups). Dropping it would mean
removing that filter from all of them and putting it back later — the expensive
direction — so it stays, with the reason written next to it in migration 0004.
