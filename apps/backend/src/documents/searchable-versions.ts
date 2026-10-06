/**
 * The one definition of which Document Versions retrieval may read.
 *
 * Two rules from GLOSSARY.md, in this order, and the order is the whole
 * point:
 *
 * 1. **Latest Version only.** "Only a Document's latest Version is searched
 *    in chat" — so the newest non-deleted Version of each Document is picked
 *    first, before anything else filters. A superseded Version is never a
 *    candidate, even though its Chunks still exist, because a Citation has to
 *    be able to reach them (NBK-12).
 * 2. **`ready` only, applied after.** "`ready` is the end of the pipeline and
 *    the only status that means a Document is safe to rely on for chat" — and
 *    it is tested on the Version already chosen, never folded into choosing
 *    it. A Document whose newest Version is still ingesting, or failed,
 *    therefore drops out of retrieval entirely rather than quietly answering
 *    from the previous Version's Chunks, which would serve content the user
 *    has already replaced.
 *
 * Swapping those two steps is a silent bug: every ordinary query still
 * answers, and only a re-upload that hasn't finished starts serving stale
 * text. That is why the rule lives here once instead of in each caller —
 * NBK-9 (search) and NBK-12 (chat retrieval) had independently derived it in
 * two different SQL idioms, which is two places for it to drift. It has its
 * own tests in `test/searchable-versions.test.ts`, and NBK-13's
 * `test/versioning-integrity.test.ts` proves it end to end through both
 * callers.
 *
 * Deliberately *not* shared with `SELECT_DOCUMENTS_WITH_LATEST_VERSION` in
 * `repository.ts`, which looks similar and must not be: listing a Notebook's
 * Documents shows the latest Version whatever its status, because a Document
 * mid-ingestion is exactly what a user needs to see. Only retrieval adds the
 * `ready` test. Same first step, different rule.
 *
 * Raw SQL per ADR-0003.
 */

/**
 * A `WITH` clause defining `searchable_versions`: one row per Document in a
 * Notebook whose latest Version is `ready`, carrying that Version.
 *
 * **Takes `$1` as the Notebook id**, so a caller's own parameters start at
 * `$2`. Both callers already passed the Notebook id first.
 *
 * Columns: `document_id`, `notebook_id`, `filename`, `document_created_at`,
 * `version_id`, `version_number`, `mime_type`, `size_bytes`,
 * `version_created_at`, `ingestion_status`, `abstract`, `chat_snippet`.
 * `ingestion_status` is always `'ready'` here and is projected anyway because
 * a Document card publishes it.
 *
 * `markdown` is deliberately absent: the Converted Markdown can run past 200
 * pages, so it is never selected alongside a set of Documents.
 */
export const SEARCHABLE_VERSIONS_CTE = `
  searchable_versions AS (
    SELECT
      d.id AS document_id,
      d.notebook_id,
      d.filename,
      d.created_at AS document_created_at,
      v.id AS version_id,
      v.version_number,
      v.mime_type,
      v.size_bytes,
      v.created_at AS version_created_at,
      v.ingestion_status,
      v.abstract,
      v.chat_snippet
    FROM documents d
    -- The latest Version, chosen on its own: LATERAL + LIMIT 1 so the choice
    -- cannot be influenced by any filter outside this subquery.
    JOIN LATERAL (
      SELECT id, version_number, mime_type, size_bytes, created_at,
             ingestion_status, abstract, chat_snippet
      FROM document_versions
      WHERE document_id = d.id AND deleted_at IS NULL
      ORDER BY version_number DESC
      LIMIT 1
    ) v ON true
    WHERE d.notebook_id = $1
      AND d.deleted_at IS NULL
      -- Applied here, on the Version already chosen. See the rule above.
      AND v.ingestion_status = 'ready'
  )
`;
