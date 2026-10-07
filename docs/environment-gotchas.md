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

lint-staged 17, which the hook runs, requires git ≥ 2.32, and macOS 13 ships
2.17. On such a machine every commit fails in the hook with a version
complaint, not a lint failure. `brew install git` (and a shell that picks up
Homebrew's `git` first) fixes it for good.

Until then, run what the hook would have run by hand —
`pnpm run check:format:fix` and `pnpm run check` — and commit past the hook
with `git -c core.hooksPath=/dev/null commit ...`. CI runs the full set
regardless, so nothing is skipped for the branch, only for the local commit.

## Reaching `.env` from a git worktree

`.env` is gitignored, so a fresh worktree does not have it, and anything calling
Jira or OpenRouter needs it. Copy it in rather than re-deriving credentials, and
do not commit it — `.gitignore` already covers it at any depth.
