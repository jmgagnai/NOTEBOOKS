import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';
import { createPool } from '../db/pool.js';
import { createS3Client } from '../storage/s3-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', '..', 'openapi.json');

/**
 * Publishes the OpenAPI v3 document for the current set of Zod-defined
 * routes. Doesn't execute any route handler, so it doesn't need a reachable
 * Postgres or MinIO — the pool and S3 client are only ever constructed,
 * never queried, but must still be passed in so Document routes (NBK-5) are
 * registered and included in the document. `appEvents` is a no-op stub for
 * the same reason: `GET /events` (NBK-6) should appear in the document, and
 * nothing here ever subscribes.
 */
async function main(): Promise<void> {
  const pool = createPool(
    process.env.DATABASE_URL ?? 'postgres://unused:unused@localhost:5432/unused',
  );
  const s3 = createS3Client({
    endpoint: 'http://unused:9000',
    accessKeyId: 'unused',
    secretAccessKey: 'unused',
  });
  const app = await buildApp({
    pool,
    s3,
    documentsBucket: 'unused',
    appEvents: { subscribe: () => () => undefined, close: async () => undefined },
  });
  await app.ready();

  const document = app.swagger();
  await writeFile(OUTPUT_PATH, JSON.stringify(document, null, 2));

  await app.close();
  await pool.end();

  // eslint-disable-next-line no-console
  console.log(`OpenAPI document written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
