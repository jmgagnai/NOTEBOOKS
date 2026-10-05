import { buildApp } from "./app.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";

const PORT = Number(process.env.PORT ?? 3000);
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://rag_notebook:rag_notebook@localhost:5432/rag_notebook";

async function main(): Promise<void> {
  const pool = createPool(DATABASE_URL);
  await runMigrations(pool);

  const app = await buildApp({ pool });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`Backend listening on :${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
