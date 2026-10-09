import { createRequire } from 'node:module';
import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

export type LogFormat = 'json' | 'pretty';

export interface LoggerOptions {
  /** `LOG_LEVEL`, else `info`. */
  level?: string;
  /** `LOG_FORMAT`, else `json` in production (`NODE_ENV=production`) and `pretty` elsewhere. */
  format?: LogFormat;
  /** Where lines go. Defaults to stdout; tests pass a stream that keeps them. */
  destination?: DestinationStream;
}

/**
 * The backend's one logger (NBK-113): pino, which Fastify is built on, so
 * `request.log` is the same logger, and every module logs through it or a
 * child named after the module (`logger.child({ module: 'jobs' })`).
 *
 * JSON lines in production, for log tools to search by field; readable,
 * coloured lines locally — `backend:dev` and the tests — for people. The
 * same JSON reads the same way piped through `pino-pretty`.
 *
 * What is never logged: the session cookie and `authorization` header
 * (redacted wherever a request's headers are), any `password` field, and
 * bodies — no route logs a request or response body, and nothing logs
 * Converted Markdown.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const format = options.format ?? resolveFormat();
  const settings = {
    level,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'headers.cookie',
        'headers.authorization',
        'password',
        '*.password',
      ],
      censor: '[redacted]',
    },
  };
  if (format === 'json' || options.destination) {
    return options.destination ? pino(settings, options.destination) : pino(settings);
  }
  return pino(settings, prettyStream());
}

function resolveFormat(): LogFormat {
  const configured = process.env.LOG_FORMAT;
  if (configured === 'json' || configured === 'pretty') return configured;
  return process.env.NODE_ENV === 'production' ? 'json' : 'pretty';
}

/**
 * `pino-pretty` as a synchronous stream in this thread rather than a worker
 * transport, so a line is written before the process — or a test — moves
 * on. A dev dependency: a production build logs JSON and never loads it.
 */
function prettyStream(): DestinationStream {
  const pretty = createRequire(import.meta.url)('pino-pretty') as (
    options: Record<string, unknown>,
  ) => DestinationStream;
  return pretty({ colorize: true, sync: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' });
}

/** The process's root logger, from the environment; what every module defaults to. */
export const logger: Logger = createLogger();
