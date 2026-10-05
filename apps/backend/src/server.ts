import { buildApp } from "./app.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { createS3Client, ensureBucket } from "./storage/s3-client.js";

const PORT = Number(process.env.PORT ?? 3000);
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://rag_notebook:rag_notebook@localhost:5432/rag_notebook";

// Defaults match the MinIO service in the root docker-compose.yml (NBK-2).
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://localhost:9000";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "rag_notebook";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "rag_notebook_secret";
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET ?? "rag-notebook-documents";

async function main(): Promise<void> {
  const pool = createPool(DATABASE_URL);
  await runMigrations(pool);

  const s3 = createS3Client({
    endpoint: MINIO_ENDPOINT,
    accessKeyId: MINIO_ACCESS_KEY,
    secretAccessKey: MINIO_SECRET_KEY,
  });
  await ensureBucket(s3, DOCUMENTS_BUCKET);

  const app = await buildApp({ pool, s3, documentsBucket: DOCUMENTS_BUCKET });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`Backend listening on :${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
