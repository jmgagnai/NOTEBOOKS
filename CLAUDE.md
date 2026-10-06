## Local setup

`pnpm install` does not install everything. Ingestion stage 1 spawns a Python
subprocess running Docling, which has to be installed separately — see
`docs/ingestion-docling.md`. Tests stub that subprocess, so `pnpm test` is
green without it; running the backend is not.

## Agent skills

### Issue tracker

Issues live in Jira Cloud, project NBK (team-managed, Scrum), via the REST API
over curl. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
