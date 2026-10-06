-- Two operational columns for ingestion stage 2 (NBK-7), both about the
-- *making* of the three Generated document artifacts rather than about the
-- artifacts themselves — which is why neither is on any API payload, the same
-- way `converted_at`, `summarized_at` and `ingestion_error` are not.

-- Completed section summaries, so a retry does not re-pay for the map pass.
--
-- NBK-1's operator story is explicit: "a transient failure in one stage (e.g.
-- a rate-limited OpenRouter call) doesn't force the whole pipeline to restart
-- from the raw upload". Stage 2 honours that *between* stages already — it
-- never re-runs a Docling conversion — but inside itself it was all-or-
-- nothing: one job makes the metadata call, one call per header-delimited
-- section, and three reductions, so a rate-limited *reduction* threw away
-- every section summary with it. On a 200-page document the map pass is
-- dozens of calls and essentially the entire bill (~$0.05 and 5-8 minutes
-- measured; see docs/ingestion-summaries.md), so that is the expensive half
-- being re-paid for a failure in the cheap half.
--
-- Shape: {"fingerprint": "<sha256 of the Converted Markdown>",
--         "summaries": {"<section index>": "<summary>", ...}}
--
-- An object keyed by index rather than an array, because the map pass runs
-- four calls concurrently and each one writes its own key with `jsonb_set`:
-- two concurrent read-modify-writes of one array would lose a summary.
--
-- The fingerprint is what makes reuse safe. Section indexes are only
-- meaningful against the Markdown they were derived from, and stage 1 can
-- legitimately re-run against the same Version id and produce different
-- Markdown — so a cache whose fingerprint no longer matches is discarded
-- rather than reduced into a summary of text nobody uploaded.
--
-- Cleared when stage 2 succeeds: it is work-in-progress, not an artifact, and
-- a finished Version has no use for dozens of intermediate summaries.
-- ADR-0006 records why this is a resumable job rather than one queue per
-- stage.
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS section_summaries JSONB;

-- Generated document artifacts that shipped outside the size GLOSSARY.md
-- defines them by.
--
-- The three artifacts are partly *defined* by their sizes (150-300 words,
-- 1-2 pages, 50-100 words), and a still-out-of-range artifact is stored
-- anyway rather than failing the stage — a slightly-long Abstract is worth
-- far more to a user than a Document stuck in `failed` because a model would
-- not count. That trade is right, and it is also how a size guarantee quietly
-- stops being one. This column is the difference between "stored anyway" and
-- "stored anyway, and someone can find out".
--
-- Shape: [{"artifact": "executiveSummary", "words": 1500, "minWords": 500,
--          "maxWords": 1000}, ...]. NULL — not `[]` — when everything fitted,
-- so "nothing to report" is one value and not two.
--
-- Deliberately not `ingestion_error`: that column means the stage failed and
-- is read as such by the UI's status badge. An over-long summary is a
-- successful stage with a caveat.
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS artifact_warnings JSONB;
