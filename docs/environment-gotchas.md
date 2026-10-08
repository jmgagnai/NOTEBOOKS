# Environment gotchas

Things that cost time once and should not cost it twice. Each was hit during the
NBK-2..NBK-13 build, in several cases by more than one person independently.

## Verify a Docker image is anonymously pullable before depending on it

This bit twice, from different registries:

- **`minio/minio`** on Docker Hub now requires a login. The compose file uses
  `bitnamilegacy/minio` instead, a drop-in that pulls without auth.
- **`quay.io/docling-project/docling`** requires auth, and neither
  `ghcr.io/docling-project/docling` nor `docling-cli` exists at all. Conversion
  uses `ghcr.io/docling-project/docling-serve-cpu` with its entrypoint
  overridden for one-shot CLI use — see [ingestion-docling.md](./ingestion-docling.md).

So: `docker pull` a candidate image in a clean context before writing it into
compose or a test. A tag that resolves in a warm local cache can still be gated
for everyone else and for CI.

## Testcontainers starts one container per test file

The backend suite runs with `fileParallelism: false` in
`apps/backend/vitest.config.ts`. That is deliberate. With it on, seven suites
each starting Postgres and MinIO — plus the Docling test's large image — produced
a dozen unrelated-looking failures (logins timing out) that each passed in
isolation. Sequential takes ~150s.

Even sequentially, Testcontainers' Reaper sidecar occasionally fails to connect
under Docker pressure. It is a flake, not a failure: re-run the file.

## The Docling CLI does not find the models the image ships

Every PDF failing about ten seconds in with `Name or service not known`,
while Markdown converts fine, is the `docling` CLI trying to download EasyOCR
weights that are already in the image. The image points at them with
`DOCLING_SERVE_ARTIFACTS_PATH`, which only docling-serve reads. The converter
passes `--artifacts-path` for it; see
[ingestion-docling.md](./ingestion-docling.md#the-cli-has-to-be-told-where-the-models-are).
If you run the image by hand, pass it too.

A related symptom, now fixed, hid that one for a while: a stage's failure
message carrying a whole Python traceback was too big for the app-event bus,
the refusal rolled back the transaction recording the failure, and the
Version sat at "converting" with no error anywhere but the pg_boss job table.
Events now carry no error text at all, only the failure reason (NBK-67); the
full text is on `ingestion_error`.

## Local Docling conversion is not an option on macOS x86_64

`docling-parse` stopped publishing macOS x86_64 wheels after 4.7.2, and building
from source needs a C++ toolchain. The container is the only practical route on
this hardware, which is why the decision is recorded in
[ADR-0004](./adr/0004-pg-boss-jobs-and-listen-notify-sse.md) rather than left as
a preference.

## macOS below 14 cannot run Angular's default Sass compiler

`sass-embedded` ships a Dart VM binary requiring macOS 14+; on 13 it fails
silently and takes `ng build`/`ng test` with it. The frontend's `build`, `start`,
`watch` and `test` scripts set `NG_BUILD_SASS_EMBEDDED=false`, forcing Angular's
pure-JS Sass fallback. Same output, different backend. Harmless on newer macOS,
Linux and CI; it uses POSIX inline-env syntax, so it assumes a POSIX shell.

## The pre-commit hook needs git 2.32 or newer

lint-staged 17, which the hook runs, requires git ≥ 2.32. macOS ships a new
enough one at `/usr/bin/git` (2.39 on macOS 13), but a package manager's git
earlier on `PATH` shadows it — MacPorts' `/opt/local/bin/git` is 2.17 — and
then every commit fails in the hook with a version complaint, not a lint
failure. `which -a git` shows the order.

The hook detects this and runs with `/usr/bin/git` when the first git on
`PATH` is too old, so commits work. Everything else that shells out to `git`
(Claude Code sessions, scripts) still gets the old one and trips on newer
flags such as `git branch --show-current`. To fix that for good, put `/usr/bin`
before `/opt/local/bin` in your shell's `PATH`, or `sudo port deactivate git`.

Should the hook still refuse (no system git new enough), run what it would
have run by hand — `pnpm run check:format:fix` and `pnpm run check` — and
commit past it with `git -c core.hooksPath=/dev/null commit ...`. CI runs the
full set regardless, so nothing is skipped for the branch, only for the local
commit.

## Parallel test runs time out on an overloaded machine

Five-second timeouts that land on the first test of a file, and move to a
different file on every run, are load, not code. Several `ng test` runs at
once (parallel implementer agents, each running the frontend suite) pushed
the load average on an 8-core machine past 390, and the suite failed with 2 to
19 such timeouts per run while every file passed on its own.

`uptime` confirms it. Run the spec file you changed on its own while working
(`--include='**/<name>.spec.ts'`), the full suite once at the end, and re-run
a red full suite alone before believing it. A merge is verified only by a run
on a quiet machine.

## A local Postgres on 5432 shadows the Docker one

`pnpm infra:up` publishes the compose Postgres on `*:5432`. A Homebrew or
MacPorts Postgres service binds `127.0.0.1:5432`, and for `localhost` the
specific binding wins, so the backend connects to the local server and fails
with `role "rag_notebook" does not exist` — an error that names neither
server. `lsof -nP -iTCP:5432 -sTCP:LISTEN` shows both.

The backend logs which server it reached at startup (`Connected to PostgreSQL
16.x` is compose; 14 or 15 is a local install) and, on a failed connection,
says where it tried. Fix either by stopping the local service for the session
(`brew services stop postgresql@14`) or by moving the compose port to 5433 and
setting `DATABASE_URL` in `.env` to match.

## Reaching `.env` from a git worktree

`.env` is gitignored, so a fresh worktree does not have it. `scripts/jira.mjs`
finds the main checkout's copy on its own (through `git rev-parse
--git-common-dir`), so Jira works from any worktree. The backend reads the
`.env` beside its own package, so running it from a worktree needs a copy
there — copy rather than re-derive credentials, and do not commit it;
`.gitignore` already covers it at any depth. Tests need neither.
