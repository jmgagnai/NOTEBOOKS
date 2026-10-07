# RAG Notebook

A multi-user application for uploading documents into **Notebooks** and chatting
with an LLM grounded in those documents. Every answer carries **Citations** that
open the exact Document Version and chunk it came from.

Uploaded documents go through a three-stage background **Ingestion** pipeline:

1. **Convert** the file to Markdown with Docling (run as a one-shot Docker container).
2. **Summarize**: extract metadata and generate a Chat Snippet, an Executive Summary and an Abstract.
3. **Index**: chunk the Markdown and embed each chunk for retrieval.

A Document is usable in chat once it reaches the `ready` status. The domain
vocabulary is defined in [GLOSSARY.md](./GLOSSARY.md).

## Stack

| Part       | Technology                                                       |
| ---------- | ---------------------------------------------------------------- |
| Backend    | Node.js, Fastify, Zod route schemas, raw SQL, pg-boss job queues |
| Frontend   | Angular, with an API client generated from the backend's OpenAPI |
| Database   | PostgreSQL 16 with pgvector                                      |
| Storage    | MinIO (S3-compatible) for uploaded files                         |
| Conversion | Docling (`docling-serve-cpu` image)                              |
| LLM        | OpenRouter, for summaries, embeddings and chat                   |

## Getting started

### Prerequisites

- Node.js ≥ 20 and pnpm (the repo pins `pnpm@12.9.1`)
- Docker, running
- An [OpenRouter](https://openrouter.ai) API key

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start Postgres and MinIO

```bash
pnpm infra:up        # docker compose up -d
```

This starts Postgres 16 with pgvector on `:5432` and MinIO on `:9000` (console
on `:9001`). The backend's built-in defaults already match these credentials,
so you don't need to set `DATABASE_URL` or the `MINIO_*` variables.

### 3. Pull the Docling image (one time)

```bash
docker pull ghcr.io/docling-project/docling-serve-cpu:v1.1.0
```

Without it, uploaded Documents fail at ingestion stage 1 (conversion to
Markdown). See [docs/ingestion-docling.md](./docs/ingestion-docling.md).

### 4. Configure `.env`

Create a `.env` file at the repo root (it is gitignored) with at least:

```bash
OPENROUTER_API_KEY=sk-or-...
```

### 5. Start the backend (port 3000)

```bash
pnpm backend:dev     # tsx watch src/server.ts
```

The backend reads the repo-root `.env` at startup (variables already in your
environment take precedence). On startup it also runs the database migrations
and creates the `rag-notebook-documents` bucket itself, so you don't need to
run `backend:migrate`.

Without `OPENROUTER_API_KEY`, the backend still starts and says so, but
Documents stop at `converted` instead of reaching `ready`, and chat and search
return 503.

### 6. Start the frontend (in a second terminal)

```bash
pnpm frontend:dev    # ng serve → http://localhost:4200
```

The dev build calls `http://localhost:3000` directly
(`apps/frontend/src/environments/environment.ts`), so you don't need a proxy.

Open <http://localhost:4200>.

### Stopping

```bash
pnpm infra:down      # your data stays in Docker volumes
```

### Optional settings

| Variable             | Default                                            | Purpose                                         |
| -------------------- | -------------------------------------------------- | ----------------------------------------------- |
| `PORT`               | `3000`                                             | Backend port                                    |
| `JWT_SECRET`         | an insecure development value                      | Session token signing; set it outside local dev |
| `DATABASE_URL`       | `postgres://rag_notebook:rag_notebook@localhost:5432/rag_notebook` | Postgres connection         |
| `MINIO_ENDPOINT`     | `http://localhost:9000`                            | S3 endpoint                                     |
| `DOCUMENTS_BUCKET`   | `rag-notebook-documents`                           | Bucket for uploaded files                       |
| `DOCLING_IMAGE`      | `ghcr.io/docling-project/docling-serve-cpu:v1.1.0` | Conversion image                                |
| `DOCLING_TIMEOUT_MS` | `600000`                                           | Hard cap on one conversion                      |
| `DOCKER_BIN`         | `docker`                                           | The `docker` binary                             |

If something in the environment fights you (a gated Docker image, a
Testcontainers flake, a silent `ng build` failure), check
[docs/environment-gotchas.md](./docs/environment-gotchas.md).

## Checks and tests

```bash
pnpm run check    # fast gate, no Docker or network: migration numbering,
                  # formatting, typechecks, OpenAPI contract vs GLOSSARY.md
pnpm test         # backend (Testcontainers, needs Docker) + frontend tests
pnpm run verify   # check + test
```

Tests stub Docling and OpenRouter, so `pnpm test` passes without the Docling
image or an API key. No test makes a real OpenRouter call. A pre-commit hook
runs a subset of the checks, and CI runs everything.

## Generated code

`apps/frontend/src/app/api/` is generated by ng-openapi-gen from the backend's
Zod route schemas via `apps/backend/openapi.json`. After changing a route or a
schema, regenerate it:

```bash
pnpm run openapi:generate
```

Never hand-edit it, and resolve merge conflicts in it by regenerating.

## Repository layout

```
apps/
  backend/     Fastify API, ingestion jobs, migrations (src/), tests (test/)
  frontend/    Angular app
docs/
  adr/         Architecture decision records
  *.md         Ingestion, search, versioning and environment notes
infra/         Postgres init scripts
scripts/       Check scripts used by `pnpm run check`
GLOSSARY.md    Domain vocabulary
```

## Further reading

- [GLOSSARY.md](./GLOSSARY.md): domain terms and the ones to avoid
- [docs/adr/](./docs/adr/): architecture decisions
- [docs/ingestion-docling.md](./docs/ingestion-docling.md), [docs/ingestion-summaries.md](./docs/ingestion-summaries.md), [docs/ingestion-embeddings.md](./docs/ingestion-embeddings.md): the ingestion stages
- [docs/search.md](./docs/search.md), [docs/versioning.md](./docs/versioning.md)
