import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMinio, type StartedMinio } from './support/minio-container.js';

const BACKEND_DIR = fileURLToPath(new URL('..', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

/** How long a failed boot may take to exit before the test calls it a hang. */
const EXIT_DEADLINE_MS = 30_000;

interface BootResult {
  /** `null` when the process was still running at the deadline and was killed. */
  exitCode: number | null;
  output: string;
}

/** Runs the real `src/server.ts` and waits for it to exit, or kills it at the deadline. */
function boot(env: Record<string, string>): Promise<BootResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, ['src/server.ts'], {
      cwd: BACKEND_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));

    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      child.kill('SIGKILL');
    }, EXIT_DEADLINE_MS);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: hung ? null : code, output });
    });
  });
}

/**
 * NBK-73: a startup failure has to end the process. The trap is a rejection
 * that lands after `main()` has opened its LISTEN connection and started
 * pg-boss: those handles keep the event loop alive, so a catch that only sets
 * `process.exitCode` logs the error and then hangs, neither serving nor
 * exiting. A taken port is the realistic way to fail that late — `app.listen`
 * is the last thing `main()` does.
 */
describe('backend startup (real process)', () => {
  let postgres: StartedPostgreSqlContainer;
  let minio: StartedMinio;
  let occupied: Server;
  let occupiedPort: number;

  beforeAll(async () => {
    [postgres, minio] = await Promise.all([
      new PostgreSqlContainer('pgvector/pgvector:pg16').start(),
      startMinio(),
    ]);
    occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
    const address = occupied.address();
    if (address === null || typeof address === 'string') throw new Error('no port bound');
    occupiedPort = address.port;
  }, 180_000);

  afterAll(async () => {
    await new Promise((resolve) => occupied.close(resolve));
    await Promise.all([postgres.stop(), minio.container.stop()]);
  });

  it(
    'exits with code 1 when it fails after opening its connections',
    async () => {
      const { exitCode, output } = await boot({
        DATABASE_URL: postgres.getConnectionUri(),
        MINIO_ENDPOINT: minio.endpoint,
        MINIO_ACCESS_KEY: minio.accessKeyId,
        MINIO_SECRET_KEY: minio.secretAccessKey,
        PORT: String(occupiedPort),
        // Empty, not unset: the repo-root `.env` must not fill it in and
        // wire real OpenRouter clients into a test.
        OPENROUTER_API_KEY: '',
      });

      expect(output).toContain('EADDRINUSE');
      expect(exitCode).toBe(1);
    },
    EXIT_DEADLINE_MS + 30_000,
  );
});
