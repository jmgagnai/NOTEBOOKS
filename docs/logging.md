# Backend logging

The backend logs through one [pino](https://getpino.io) logger
(`apps/backend/src/logging/logger.ts`, NBK-113). Fastify's `request.log` is
that logger, and every module logs through it or a child named after the
module (`jobs`, `docling`).

| Variable     | Values                                            | Default                                         |
| ------------ | ------------------------------------------------- | ----------------------------------------------- |
| `LOG_LEVEL`  | `fatal`, `error`, `warn`, `info`, `debug`, `trace` | `info`                                          |
| `LOG_FORMAT` | `json`, `pretty`                                  | `json` when `NODE_ENV=production`, else `pretty` |

- **Readable locally, JSON in production.** `pnpm run backend:dev` and the
  test suite print coloured lines for people. Production prints one JSON
  object per line for log tools to search by field. To read production JSON,
  pipe it through `npx pino-pretty`. `pino-pretty` is a dev dependency, so
  `LOG_FORMAT=pretty` needs it installed.
- **One line per request**, when it completes: method, URL, status and time,
  at `info`. The live event stream (`/events`), which every open page holds,
  is logged at `debug`.
- **Never logged:** the session cookie and `authorization` header (redacted),
  any `password` field, request and response bodies, and Converted Markdown.
- **The tests log at `info` too**, so a test run shows what the backend did. A
  test that checks what was logged builds the app with
  `test/support/captured-logger.ts`.
