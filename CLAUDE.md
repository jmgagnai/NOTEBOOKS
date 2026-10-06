## Local setup

`pnpm install` does not install everything. Ingestion stage 1 converts
documents by spawning a one-shot Docling container, so its image has to be
pulled separately — see `docs/ingestion-docling.md`. Tests stub that
boundary, so `pnpm test` is green without the image; running the backend is
not.

## Agent skills

### Issue tracker

Issues live in Jira Cloud, project NBK (team-managed, Scrum), via the REST API
over curl. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
