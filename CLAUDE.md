## Local setup

`pnpm install` does not install everything. Two external boundaries have to
be set up separately, and tests stub both — so `pnpm test` is green without
either, while running the backend is not:

- **Ingestion stage 1** converts documents by spawning a one-shot Docling
  container, so its image has to be pulled. See `docs/ingestion-docling.md`.
- **Ingestion stages 2 and 3, and chat** call OpenRouter — stage 2 for
  metadata and the three summaries, stage 3 for chunk embeddings, chat twice
  per question (once to embed the question for retrieval, once to generate
  the answer) — so `OPENROUTER_API_KEY` must be in the repo-root `.env`,
  which the backend loads at startup. Without it the backend starts and
  says so, but Documents stop at the `converted` status instead of reaching
  `ready`, and asking a question in a Chat Thread reports 503. Search is by
  keyword and needs no key. See `docs/ingestion-summaries.md`,
  `docs/ingestion-embeddings.md` and `docs/search.md`.

No test makes a real OpenRouter call.

To see a UI change rendered — signed in, as screenshots — see
`docs/run-for-screenshots.md`.

Administrators (restoring a deleted Chat Thread, `ADMIN_EMAILS`) use the
API with curl: see `docs/administration.md`.

The backend logs through one pino logger (`LOG_LEVEL`, `LOG_FORMAT`): see
`docs/logging.md`.

Hit something the environment fought you on — a gated Docker image, a
Testcontainers flake, a silent `ng build` failure? See
`docs/environment-gotchas.md` before debugging it.

## Checks

`pnpm run check` is the fast gate (no Docker, no network): migration numbering,
the repo scripts' own tests, formatting, theme tokens in component styles, the
icons templates name, both typechecks, then the OpenAPI contract, the UI copy
and the test titles against `GLOSSARY.md`'s `_Avoid_` lists. `pnpm run verify` adds the test suite. The pre-commit hook runs a subset; CI runs
everything, plus the frontend production build and its size budgets.

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
