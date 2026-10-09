import { createLogger } from '../../src/logging/logger.js';

/**
 * A logger that keeps what it writes, as parsed JSON lines, so a test can
 * read back what the backend logged (NBK-113). Debug and up, so a test can
 * see the levels the backend chose.
 */
export function capturedLogger() {
  const lines: Array<Record<string, unknown> & { level: number; msg?: string }> = [];
  const logger = createLogger({
    level: 'debug',
    format: 'json',
    destination: { write: (line: string) => void lines.push(JSON.parse(line)) },
  });
  return { logger, lines };
}

/** pino's numeric levels, by name. */
export const LEVEL = { debug: 20, info: 30, warn: 40, error: 50 } as const;
