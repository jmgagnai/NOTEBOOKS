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
  --artifacts-path /opt/app-root/src/.cache/docling/models \
  --no-ocr --to md --output /work/out /work/in/README.md
cat /tmp/docling-out/README.md
```

A Markdown file never loads a model, so to verify the PDF pipeline too, run
the same command on any small PDF. Without `--artifacts-path` that is the
run that fails (see below).

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

### The CLI has to be told where the models are

The image's models (layout, table structure, figure classifier, EasyOCR
weights) live at `/opt/app-root/src/.cache/docling/models`, and the image
advertises that directory only through `DOCLING_SERVE_ARTIFACTS_PATH` — an
env var the HTTP server reads and the `docling` CLI ignores. Run bare, the
CLI looks in Docling's default cache, finds nothing, and tries to download;
with the network off, every PDF then dies about ten seconds in with

```
urllib.error.URLError: <urlopen error [Errno -2] Name or service not known>
```

The converter therefore passes `--artifacts-path` with that directory on
every run (`DOCLING_ARTIFACTS_PATH` in `docling.ts`). The path is tied to the
image tag: bump one, re-check the other. Markdown, CSV and plain-text inputs
never load a model, which is why the original smoke test — a `.md` file —
passed while every PDF failed; the real-container test now converts a PDF
too.

### OCR is off, and scanned PDFs are refused

Docling's PDF pipeline turns OCR on by default and initialises EasyOCR
before looking at a single page, even when the PDF's text is already text.
That is a model load per conversion and, more to the point, memory: with
OCR on, a 543-page novel was killed at Docker Desktop's 8GB cap after 39
minutes (`oom` in `docker events`). The converter therefore runs every
document with `--no-ocr`, always.

A scanned PDF — pages that are pictures of text — then converts to nothing
but `<!-- image -->` placeholders. Rather than let that through as an empty
Document that stage 2 summarises and stage 3 indexes, the converter refuses
it (`looksScanned` in `docling.ts`): the Version fails with
`<file> has no text layer (a scanned PDF), and OCR is disabled`. The check
is a heuristic on the output, not a probe of the input, so it needs no PDF
library on the host, and its threshold is low so a sparse but genuine text
PDF is not refused.

Supporting scans is a feature, not a flag: it needs an OCR pass with its own
memory budget (per-page, or on a machine with more than 8GB for Docker),
and a decision about which engine. The EasyOCR weights are in the image if
that day comes.

The `-cpu` variant is deliberate: the CUDA variant is much larger and buys
nothing without a GPU.

The tag is pinned, not `latest` or `main`. Conversion output feeds every
later Stage, so the converter must not change under the app without someone
deciding to change it.

## What this image can and cannot convert

The upload route's accepted extensions (`src/documents/file-types.ts`) are
bounded by what this image can read, because an accepted upload that cannot be
converted is a Document stuck at `failed`, not a feature. Read out of the
pinned image (`docling.datamodel.base_models.FormatToExtensions`):

| Docling input format | Extensions                                   | Accepted on upload |
| -------------------- | -------------------------------------------- | ------------------ |
| `PDF`                | `pdf`                                        | yes                |
| `DOCX`               | `docx`, `dotx`, `docm`, `dotm`               | `.docx` only       |
| `XLSX`               | `xlsx`, `xlsm`                               | `.xlsx` only       |
| `MD`                 | `md`                                         | yes (`.markdown` too) |
| `CSV`                | `csv`                                        | yes                |
| `HTML`, `PPTX`, `ASCIIDOC`, `IMAGE`, `AUDIO`, `XML_*`, `JSON_DOCLING` | — | no — outside NBK-1's list |

Plain text has no Docling format of its own; a `.txt` falls through content
sniffing to `text/plain` and passes through essentially unchanged, which is
what NBK-1 anticipated for "plain text, Markdown, and CSV inputs".

### Legacy `.xls` is not supported, and why

NBK-1 lists "Excel" unqualified, so a `.xls` upload is a reasonable thing for
a user to try. It is rejected, with a message that says why rather than just
listing what is accepted.

The reason is the converter, verified by running a real OLE2/BIFF workbook
through the pinned image rather than inferred:

- `InputFormat.XLSX` maps to the `xlsx` and `xlsm` extensions only.
- The image ships `openpyxl` (which reads the modern zip-based format) but
  neither `xlrd` nor `olefile`, so nothing in it can parse a BIFF workbook.
- There is no `application/vnd.ms-excel` entry in its MIME-to-format table,
  and the `filetype` library it sniffs with returns `None` for the OLE2
  signature.

So format detection resolves a `.xls` to `None`, Docling logs

```
Input document report.xls with format None does not match any allowed format
```

writes no output file, **and exits 0** — which stage 1 catches as "exited 0 but
produced no Markdown" (that guard exists for exactly this class of input; see
`createDoclingConverter`). Accepting `.xls` would therefore trade an immediate,
actionable 400 at upload for a Document that sits in `converting` and then
`failed` several minutes later.

Note that Docling sniffs *content*, not only the extension: a CSV or an actual
`.xlsx` renamed to `.xls` converts fine. That is not a reason to accept the
extension — it means accepting it would succeed for the files that were never
really `.xls` and fail for the ones that were, which is the worst of both.

Supporting legacy `.xls` properly needs a pre-conversion step this pipeline
does not have — LibreOffice headless, or an `xlrd`-based shim, either of which
is a new external dependency and a new failure mode. That is a feature, not a
validation tweak.

## Configuration

| Variable             | Default                                            | Purpose                      |
| -------------------- | -------------------------------------------------- | ---------------------------- |
| `DOCLING_IMAGE`      | `ghcr.io/docling-project/docling-serve-cpu:v1.1.0` | Image to run                 |
| `DOCKER_BIN`         | `docker`                                           | The `docker` binary          |
| `DOCLING_TIMEOUT_MS` | `3600000`                                          | Hard cap on one conversion   |

The timeout is an hour because the layout model runs on every page on CPU:
a 540-page novel takes the pinned image well over ten minutes on a
four-core Docker Desktop, and conversions run one at a time. Expect a batch
of book-length PDFs to take hours; a Document is "converting" for as long
as its container runs, and the ones behind it are "queued".

The job queue's expiry follows this timeout (`jobExpirySeconds` in
`jobs/queue.ts`: the timeout plus five minutes, on every stage queue).
pg_boss expires a job still active after that and schedules a retry, and
its default of 15 minutes meant a book was converted again while its first
container was still running (NBK-22). Change the timeout through
`DOCLING_TIMEOUT_MS` and the expiry moves with it; never set one without
the other.

Expiry is not how a restart recovers, though. A backend stopped mid-job
leaves that job `active` in pg_boss with no process behind it, and pg_boss
cannot tell that from a busy worker. So a worker, on starting, takes back
every stage job still active — cancel and resume, through pg_boss — and
runs it again with its retry count intact (`reclaimActiveJobs` in
`jobs/queue.ts`, NBK-25); the backend logs each one it reclaimed. That
rests on the single worker process ADR-0004 describes. A deployment with
several worker processes passes `reclaimActiveJobs: false` and falls back
on expiry, because there an active job may belong to a live sibling.

## Tests

`MarkdownConverter` (a `({ inputPath, outputPath }) => Promise<void>`
function) is the seam, and most tests stub it:

- `apps/backend/test/convert-to-markdown.job.test.ts` — seam-2: the job
  handler against real Postgres and real MinIO, conversion stubbed.
- `apps/backend/test/job-queue.test.ts` — pg_boss wiring, retry, restart.

`apps/backend/test/docling.converter.test.ts` covers the converter itself,
in two halves:

- The OCR policy and the `docker run` argument list, against a fake `docker`
  script that records its arguments and writes a canned result. Always runs.
- The real container: a Markdown file, a hand-built one-page PDF (so the PDF
  pipeline and its model loading are exercised), and a corrupt PDF. Skipped
  unless the image is already present locally, so `pnpm test` is green on a
  machine that hasn't pulled it. Pull the image to include it.
