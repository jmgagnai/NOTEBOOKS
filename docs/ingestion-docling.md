# Ingestion: Docling setup

Ingestion stage 1 (NBK-6) converts an uploaded Document to Markdown with
[Docling](https://github.com/docling-project/docling). Docling is a Python
library, and the backend has no Python runtime — so the convert-to-Markdown
job **spawns a one-shot Docker container per conversion**, bind-mounting the
input file in and an output directory out, and reads the Markdown back from a
file in that directory (never from stdout, which Python warnings pollute).

See `apps/backend/src/ingestion/docling.ts` for the invocation and
`docs/adr/0004-pg-boss-jobs-and-listen-notify-sse.md` for the reasoning.

## Setup

One image pull, from the repo root:

```bash
docker pull ghcr.io/docling-project/docling-serve-cpu:v1.1.0
```

That's the whole setup. No Python, no virtualenv, no `pip install`.

Verify it, with any document:

```bash
mkdir -p /tmp/docling-out
docker run --rm --network none \
  --volume "$PWD/README.md:/work/in/README.md:ro" \
  --volume /tmp/docling-out:/work/out \
  --entrypoint docling \
  ghcr.io/docling-project/docling-serve-cpu:v1.1.0 \
  --to md --output /work/out /work/in/README.md
cat /tmp/docling-out/README.md
```

### Why that image

There is no published CLI-only Docling image. Checked against both
registries' APIs: `ghcr.io/docling-project/docling` and
`.../docling-cli` do not exist, and `quay.io/docling-project/docling`
requires authentication — the same kind of gating that made this repo switch
from `minio/minio` to `bitnamilegacy/minio` (see `docker-compose.yml`).

What *is* pullable anonymously is `docling-serve-cpu`, which is packaged as
an HTTP service but contains the `docling` CLI and the full library. So its
entrypoint is overridden (`--entrypoint docling`) and it runs one-shot and
exits. That is preferable to a repo-built `python:slim + pip install docling`
image: no build step for anyone cloning the repo, no dependency resolution to
go stale, and the models are already baked in — which is also why the
container can run with `--network none`.

The `-cpu` variant is deliberate: the CUDA variant is much larger and buys
nothing without a GPU.

The tag is pinned, not `latest` or `main`. Conversion output feeds every
later Stage, so the converter must not change under the app without someone
deciding to change it.

## Configuration

| Variable             | Default                                            | Purpose                      |
| -------------------- | -------------------------------------------------- | ---------------------------- |
| `DOCLING_IMAGE`      | `ghcr.io/docling-project/docling-serve-cpu:v1.1.0` | Image to run                 |
| `DOCKER_BIN`         | `docker`                                           | The `docker` binary          |
| `DOCLING_TIMEOUT_MS` | `600000`                                           | Hard cap on one conversion   |

## Tests

`MarkdownConverter` (a `({ inputPath, outputPath }) => Promise<void>`
function) is the seam, and most tests stub it:

- `apps/backend/test/convert-to-markdown.job.test.ts` — seam-2: the job
  handler against real Postgres and real MinIO, conversion stubbed.
- `apps/backend/test/job-queue.test.ts` — pg_boss wiring, retry, restart.

One test does run the real container:

- `apps/backend/test/docling.converter.test.ts` — proves the `docker run`
  invocation and the output-file contract actually work.

It is skipped unless the image is already present locally, so `pnpm test`
is green on a machine that hasn't pulled it. Pull the image to include it.
