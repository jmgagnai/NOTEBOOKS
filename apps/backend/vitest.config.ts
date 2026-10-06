import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Testcontainers has to pull/start real Postgres and (for documents.route
    // test.ts) MinIO images on first run, which comfortably exceeds vitest's
    // default 5s hook/test timeouts.
    hookTimeout: 180_000,
    testTimeout: 180_000,
    // One test file at a time. Almost every file here boots its own Postgres
    // and MinIO container, and the Docling test (NBK-6) runs a 4.5GB image on
    // top of that — running them in parallel overloads Docker and surfaces as
    // unrelated-looking failures (a login timing out because its Postgres is
    // starved, say). Sequential is slower but honest; the containers, not the
    // JavaScript, dominate the runtime either way.
    fileParallelism: false,
  },
});
