import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Testcontainers has to pull/start a real Postgres image on first run,
    // which comfortably exceeds vitest's default 5s hook/test timeouts.
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
