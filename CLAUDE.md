## Local setup

`pnpm install` does not install everything. Two external boundaries have to
be set up separately, and tests stub both — so `pnpm test` is green without
either, while running the backend is not:

- **Ingestion stage 1** converts documents by spawning a one-shot Docling
  container, so its image has to be pulled. See `docs/ingestion-docling.md`.
- **Ingestion stages 2 and 3, chat, and search** call OpenRouter — stage 2
  for metadata and the three summaries, stage 3 for chunk embeddings, chat
  twice per question (once to embed the question for retrieval, once to
  generate the answer), and search once per query to embed it — so
  `OPENROUTER_API_KEY` must be in the repo-root `.env`, which the backend
  loads at startup. Without it the backend starts and
  says so, but Documents stop at the `converted` status instead of reaching
  `ready`, and asking a question in a Chat Thread or running a search reports
  503. See `docs/ingestion-summaries.md`, `docs/ingestion-embeddings.md` and
  `docs/search.md`.

No test makes a real OpenRouter call.

Hit something the environment fought you on — a gated Docker image, a
Testcontainers flake, a silent `ng build` failure? See
`docs/environment-gotchas.md` before debugging it.

## Checks

`pnpm run check` is the fast gate (no Docker, no network): migration numbering,
formatting, both typechecks, then the published OpenAPI contract against
`GLOSSARY.md`'s `_Avoid_` lists. `pnpm run verify` adds the test suite. The
pre-commit hook runs a subset; CI runs everything.

## Coding standards

The judgement calls review enforces that no check can — glossary vocabulary in
UI copy, mirrored cross-app constants, seam-3 test-helper placement, comments
that carry the why — are in `CODING_STANDARDS.md`.

## Generated code

`apps/frontend/src/app/api/` is ng-openapi-gen output, derived from the
backend's Zod route schemas via `apps/backend/openapi.json`. Change a route or
schema, then run `pnpm run openapi:generate`; never hand-edit it, and resolve
merge conflicts in it by regenerating.

## Agent skills

### Issue tracker

Issues live in Jira Cloud, project NBK (team-managed, Scrum), via the REST API
over curl. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
