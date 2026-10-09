import { describe, expect, it } from 'vitest';
import { capturedLogger } from './support/captured-logger.js';

/**
 * What the logger itself guarantees whoever logs through it (NBK-113): a
 * session cookie, an authorization header or a password never reaches a
 * log line, wherever a request's headers or a password field end up in it.
 */
describe('createLogger: redaction', () => {
  it('redacts cookies, authorization headers and passwords', () => {
    const { logger, lines } = capturedLogger();

    logger.info(
      {
        req: { headers: { cookie: 'session=abc123', authorization: 'Bearer t0ken' } },
        headers: { cookie: 'session=def456' },
        password: 'correct-horse',
        credentials: { password: 'battery-staple' },
      },
      'a request',
    );

    const written = JSON.stringify(lines);
    for (const secret of ['abc123', 't0ken', 'def456', 'correct-horse', 'battery-staple']) {
      expect(written, secret).not.toContain(secret);
    }
    expect(written).toContain('[redacted]');
  });
});
