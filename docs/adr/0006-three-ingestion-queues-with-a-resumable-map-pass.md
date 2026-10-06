# Three ingestion queues with a resumable map pass, not one queue per spec stage

NBK-1 gives the operator's requirement directly:

> As an operator, I want each stage of the document ingestion pipeline
> (store, convert, extract metadata, summarize, chunk, embed) to retry
> independently on failure, so that a transient failure in one stage (e.g. a
> rate-limited OpenRouter call) doesn't force the whole pipeline to restart
> from the raw upload.

That sentence names **six** stages. The pipeline is built as **three** pg_boss
queues: convert (stage 1), metadata + the three summaries (stage 2), chunk +
embed (stage 3). The parenthesis is a list of the work, not a specification of
the queue topology — but the requirement underneath it is real, and for a
while stage 2 did not meet it.

## What the shortfall actually was

The expensive half of stage 2 is the **map pass**: one OpenRouter call per
header-delimited section. Measured on a 5.4 KB, 10-section report it is 9
calls, ~86 s and ~$0.002; extrapolated to a 200-page document it is dozens of
calls, **roughly $0.05 and 5–8 minutes**, and the map pass dominates both
(`docs/ingestion-summaries.md`).

The cheap half is 1 metadata call and 3 reductions.

All of it was one job. So a rate-limited *reduction* — the last three calls —
failed the job, and the retry re-paid for every section summary. That is
precisely the shape the story forbids: a transient failure in one piece of
work forcing much more expensive work to be redone. It just happened *inside*
a stage rather than across stages, which is why the queue-per-stage design
looked like it had already solved it.

## The decision

**Keep three queues. Make the map pass resumable instead.**

Each section summary is persisted as it completes, in
`document_versions.section_summaries` (migration 0011), keyed by section index
and fingerprinted with a SHA-256 of the Converted Markdown it was derived
from. A retry loads what is already done and only generates the rest. A
reduction that fails now costs its retry three calls, not forty.

The fingerprint is load-bearing, not caution: section indexes mean nothing
against text they were not derived from, and stage 1 can legitimately re-run
against the same Version id and leave *different* Markdown behind. A cache
whose fingerprint no longer matches is discarded wholesale, so the failure
mode "reduce last attempt's summaries of text that is no longer in the
document" — which would leave every status reading `summarized` and only the
content wrong — cannot happen.

The cache is cleared when stage 2 succeeds. It is work-in-progress, not an
artifact, and a finished 200-page Version has no use for dozens of
intermediate summaries.

## Why not six queues

Splitting metadata and summarization into separate queues would satisfy the
spec's wording more literally and fix almost none of the problem:

- **It does not help the expensive case.** Metadata is one call. Moving it to
  its own queue saves one call per retry while the map pass — dozens — still
  re-runs whole, because the map and the reduce would still be the same job.
  To fix it with queues you would need a queue *per section*, i.e. a job count
  that depends on the document, with the reduce waiting on a fan-in.
- **Fan-in is the expensive part, and pg_boss is not built for it.** Three
  queues chain because each stage enqueues exactly one successor on success
  (ADR-0004). A per-section fan-out needs a completion barrier — the last
  section to finish enqueues the reduce — which means a counter, a race on
  that counter, and a story for a section whose retries are exhausted while
  its siblings succeeded. Every one of those failure modes is new, and none of
  them is visible in the status column a user watches.
- **The status model would have to split too.** A Version's progress *is* its
  `ingestion_status`, one value per Stage (GLOSSARY.md). Six queues means
  either six more statuses for a user to interpret or a status that no longer
  says which queue holds the work.
- **Persisting the summaries is what the operator actually asked for.** The
  story's concern is cost and time, not queue count: "doesn't force the whole
  pipeline to restart". Resumability delivers that for the one piece of work
  where it is worth money.

Where the spec's three *other* boundaries are concerned, the queues already
match: conversion (Docling, minutes of CPU), summarization (OpenRouter
generation), and chunk+embed (OpenRouter embeddings). Those are the real
failure-isolation boundaries — each uses a different external dependency with
a different failure mode — and a failure in one never re-runs another.

## Consequences

- Stage 2 writes one small `UPDATE` per section summary — dozens of tiny
  statements spread over several minutes. Negligible against the OpenRouter
  calls they protect.
- Concurrent map-pass runners (four by default) each write their own key with
  `jsonb_set`, so a read-modify-write cannot lose a sibling's summary.
- `generated-artifacts.ts` stays free of database access: resumability enters
  through a `SectionSummaryStore` interface, and the module remains callable
  without a Postgres connection.
- Metadata extraction and the three reductions are still re-paid on a retry.
  That is 4 calls out of ~44 on a large document, and making them resumable
  too would mean caching intermediate results nobody reads for a saving
  inside the noise.
- The deviation from the spec's six-stage wording is this document.
