# Ingestion: Docling install

Ingestion stage 1 (NBK-6) converts an uploaded Document to Markdown with
[Docling](https://github.com/docling-project/docling), a Python library. The
backend does not embed a Python runtime and does not talk to a Docling
service: the convert-to-Markdown job **spawns a Python subprocess**, one per
conversion, passing an input path and an output path. See
`apps/backend/src/ingestion/docling.ts` for the reasoning, and
`apps/backend/scripts/docling_convert.py` for the script it spawns.

So Docling has to be installed separately from `pnpm install`.

## Install

From the repo root:

```bash
python3 -m venv .venv-docling
./.venv-docling/bin/pip install --upgrade pip setuptools wheel
./.venv-docling/bin/pip install docling
```

`.venv-docling/` is git-ignored. The backend looks for the interpreter at
`<repo root>/.venv-docling/bin/python` by default, so nothing else needs
configuring if you use that path.

Verify it:

```bash
./.venv-docling/bin/python apps/backend/scripts/docling_convert.py \
  --input README.md --output /tmp/converted.md
```

Docling downloads its models on first use, so the first conversion is slow
and needs network access.

## Configuration

| Variable            | Default                                 | Purpose                                      |
| ------------------- | --------------------------------------- | -------------------------------------------- |
| `DOCLING_PYTHON`    | `<repo root>/.venv-docling/bin/python`  | Interpreter to run the entry script with     |
| `DOCLING_SCRIPT`    | `apps/backend/scripts/docling_convert.py` | The entry script                           |
| `DOCLING_TIMEOUT_MS`| `600000`                                 | Hard cap on one conversion                   |

Point `DOCLING_PYTHON` at any interpreter that can `import docling` — a
conda env, a `uv`-managed venv, or a system Python with Docling installed
globally.

## Platform note (macOS on Intel)

Docling depends on `docling-parse`, which stopped publishing macOS
**x86_64** wheels after `4.7.2`; newer versions ship arm64 macOS, Linux and
Windows wheels only, and building from source needs a full C++ toolchain. On
an Intel Mac, pin that one dependency:

```bash
./.venv-docling/bin/pip install "docling-parse==4.7.2" docling
```

Linux, Windows and Apple Silicon are unaffected — plain `pip install docling`
works there.

## Tests don't need Docling

`MarkdownConverter` (a `({ inputPath, outputPath }) => Promise<void>`
function) is the seam, and the tests stub it:

- `apps/backend/test/convert-to-markdown.job.test.ts` — seam-2: the job
  handler against real Postgres and real MinIO, with the subprocess stubbed.
- `apps/backend/test/job-queue.test.ts` — pg_boss wiring, retry, restart.

So `pnpm test` is green without Docling installed. Only actually running the
backend (`pnpm backend:dev`) needs it.
