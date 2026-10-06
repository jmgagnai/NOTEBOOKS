## Local setup

`pnpm install` does not install everything. Two external boundaries have to
be set up separately, and tests stub both — so `pnpm test` is green without
either, while running the backend is not:

- **Ingestion stage 1** converts documents by spawning a one-shot Docling
  container, so its image has to be pulled. See `docs/ingestion-docling.md`.
- **Ingestion stages 2 and 3** call OpenRouter — stage 2 for metadata and the
  three summaries, stage 3 for chunk embeddings — so `OPENROUTER_API_KEY`
  must be in `.env`. Without it the backend starts and says so, but Documents
  stop at the `converted` status instead of reaching `ready`. See
  `docs/ingestion-summaries.md` and `docs/ingestion-embeddings.md`.

No test makes a real OpenRouter call.

## Agent skills

### Issue tracker

Issues live in Jira Cloud, project NBK (team-managed, Scrum), via the REST API
over curl. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
