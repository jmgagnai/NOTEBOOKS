# Running the app to see it

Every page can be rendered and screenshotted from an agent session; a UI
change should be looked at, not judged from its SCSS. `scripts/screenshot.mjs`
signs in through the API, hands the httpOnly session cookie to headless
Chrome, and writes one PNG per path. Open the PNGs with the Read tool to see
them.

## 1. Have the stack up

Check first: the user often has it running already, and those are their
servers, so reuse them and leave them up.

```bash
lsof -nP -iTCP:3000 -iTCP:4200 -sTCP:LISTEN   # backend, ng serve
docker ps                                      # notebooks-postgres-1, notebooks-minio-1
```

Otherwise, from the repo root: `pnpm run infra:up`, then `pnpm run
backend:dev` and `pnpm run frontend:dev`, each with `run_in_background`. A
backend that fails with `role "rag_notebook" does not exist` has reached a
local Postgres: see `docs/environment-gotchas.md`.

No `OPENROUTER_API_KEY` is needed to render pages. Without it, new Documents
stop at `converted` and asking a question reports 503; existing Documents,
Chat Threads and answers in the local database still show.

**From a worktree**, serve that worktree's frontend on its own port and point
the script at it: `pnpm --filter frontend start -- --port 4300`, then
`SCREENSHOT_APP=http://localhost:4300`. The backend accepts any origin, so
the user's backend on 3000 serves both.

**To compare against an older commit**, give it a worktree of its own
(`git worktree add <dir> <commit>`, `pnpm install` there) and serve it as
above. Checking the commit out in the main working copy instead swaps the
code under the user's running servers: both hot-reload what is checked out,
and on 2026-10-08 the backend reloaded onto old code and refused connections
until master was checked out again.

## 2. Shoot

```bash
node scripts/screenshot.mjs --register --out "$CLAUDE_JOB_DIR/tmp/shots" / /notebooks/<id>
```

- `--register` creates the throwaway `screenshots@example.com` account the
  first time (a 409 after that is fine). `SCREENSHOT_EMAIL` /
  `SCREENSHOT_PASSWORD` pick another.
- Notebooks are shared, so that account sees every Notebook in the local
  database. Find an id, or create a Notebook when there is none:

  ```bash
  C=$(curl -si -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
    -d '{"email":"screenshots@example.com","password":"screenshots-only"}' \
    | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p' | head -1)
  curl -s -H "Cookie: $C" localhost:3000/notebooks
  curl -s -H "Cookie: $C" -H 'Content-Type: application/json' \
    -d '{"title":"Screenshots"}' localhost:3000/notebooks
  ```

- `--width` / `--height` set the viewport (default 1440×900; try 800 wide
  for the narrow layouts), `--settle` the wait after load (default 2000 ms).
- States behind a click (a menu, a collapsed sidebar, the hidden Documents
  pane) are not reachable this way; the script captures what a path renders
  on arrival.

## 3. Use them

Look at each PNG before calling a UI change done. `gh` cannot upload images
into a PR body, so for PR evidence give the user the paths and say which
screenshot shows what; they drag them into the PR.
