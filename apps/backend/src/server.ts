import { buildApp } from "./app.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { createAppEventSubscriber } from "./events/bus.js";
import { createDoclingConverter } from "./ingestion/docling.js";
import { startJobQueue } from "./jobs/queue.js";
import { resolveEmbeddingModel, resolveTaskModels } from "./llm/models.js";
import { createOpenRouterEmbedder } from "./llm/embeddings.js";
import { createOpenRouterCompleter } from "./llm/openrouter.js";
import { createS3Client, ensureBucket } from "./storage/s3-client.js";

const PORT = Number(process.env.PORT ?? 3000);
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://rag_notebook:rag_notebook@localhost:5432/rag_notebook";

// Defaults match the MinIO service in the root docker-compose.yml (NBK-2).
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://localhost:9000";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "rag_notebook";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "rag_notebook_secret";
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET ?? "rag-notebook-documents";

// Ingestion stage 2 (NBK-7) calls OpenRouter for metadata extraction and the
// three generated summaries, stage 3 (NBK-8) calls it for chunk embeddings,
// and chat (NBK-10) calls it twice per question — once to embed the question
// for retrieval, once to generate the answer. Which model runs which task is
// server-side configuration only (see llm/models.ts) — never user-selectable,
// per NBK-1.
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

async function main(): Promise<void> {
  const pool = createPool(DATABASE_URL);
  await runMigrations(pool);

  const s3 = createS3Client({
    endpoint: MINIO_ENDPOINT,
    accessKeyId: MINIO_ACCESS_KEY,
    secretAccessKey: MINIO_SECRET_KEY,
  });
  await ensureBucket(s3, DOCUMENTS_BUCKET);

  // Live updates (NBK-6). The subscriber holds its own dedicated connection
  // (LISTEN is per-connection, see events/bus.ts) and fans events out to
  // whatever SSE clients this process is serving.
  const appEvents = await createAppEventSubscriber(DATABASE_URL);

  // This single process both serves HTTP and works jobs, which is the right
  // shape for a dev/small deployment; splitting them later means starting
  // one process without `worker` and one without `app.listen`.
  // Without a key, stage 1 still runs and stages 2 and 3 simply have no
  // workers: an upload is converted and then waits at "converted". Said out
  // loud at startup, because a silently half-run pipeline is a trap.
  if (!OPENROUTER_API_KEY) {
    // eslint-disable-next-line no-console
    console.warn(
      "OPENROUTER_API_KEY is not set: ingestion stage 2 (metadata + summaries) and stage 3 " +
        "(chunking + embeddings) will not run, Documents will stop at the \"converted\" " +
        "status instead of reaching \"ready\", and asking a question in a Chat Thread will " +
        "report 503.",
    );
  }

  // The chat answer path (NBK-10). It shares the embedder with ingestion
  // stage 3 deliberately: a question has to be embedded by the same model
  // that embedded the Chunks, or the two vectors live in different spaces
  // and similarity is meaningless.
  const chat = OPENROUTER_API_KEY
    ? {
        complete: createOpenRouterCompleter({ apiKey: OPENROUTER_API_KEY }),
        embed: createOpenRouterEmbedder({
          apiKey: OPENROUTER_API_KEY,
          model: resolveEmbeddingModel(),
        }),
        model: resolveTaskModels().chatAnswer,
      }
    : undefined;

  const jobs = await startJobQueue({
    connectionString: DATABASE_URL,
    worker: {
      pool,
      s3,
      documentsBucket: DOCUMENTS_BUCKET,
      convertToMarkdown: createDoclingConverter(),
      ...(OPENROUTER_API_KEY
        ? {
            complete: createOpenRouterCompleter({ apiKey: OPENROUTER_API_KEY }),
            models: resolveTaskModels(),
            embed: createOpenRouterEmbedder({
              apiKey: OPENROUTER_API_KEY,
              model: resolveEmbeddingModel(),
            }),
          }
        : {}),
    },
  });

  const app = await buildApp({ pool, s3, documentsBucket: DOCUMENTS_BUCKET, jobs, appEvents, chat });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`Backend listening on :${PORT}`);

  // Jobs in flight get a chance to finish, and the LISTEN connection is
  // closed, instead of both being severed with the process.
  const shutdown = async (): Promise<void> => {
    await app.close();
    await jobs.stop();
    await appEvents.close();
    await pool.end();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
