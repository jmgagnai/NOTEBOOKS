import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Testcontainers has to pull/start real Postgres and (for documents.route
    // test.ts) MinIO images on first run, which comfortably exceeds vitest's
    // default 5s hook/test timeouts.
    hookTimeout: 180_000,
    testTimeout: 180_000,
  },
});
