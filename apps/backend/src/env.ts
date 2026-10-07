/**
 * Loads the repo-root `.env` into `process.env` before anything reads it.
 *
 * Import this first, ahead of every other import, in each entry point
 * (server, migrate): `auth/jwt.ts` reads `JWT_SECRET` at module evaluation,
 * so a loader that runs after the imports is already too late for it.
 *
 * Variables already in the environment win over the file, so CI and a
 * `DATABASE_URL=... pnpm backend:dev` override still work. A missing file is
 * fine: tests and CI never have one and every setting has a default except
 * `OPENROUTER_API_KEY`, whose absence the server reports at startup.
 */
import { existsSync } from 'node:fs';

// src/env.ts and dist/env.js sit at the same depth below the backend package,
// three levels under the repo root where `.env` lives.
const envFile = new URL('../../../.env', import.meta.url);

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
