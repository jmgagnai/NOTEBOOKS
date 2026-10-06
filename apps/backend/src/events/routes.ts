import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthGuard } from '../auth/guard.js';
import { errorResponseSchema } from '../auth/schema.js';
import type { AppEvent, AppEventSubscriber } from './bus.js';

/**
 * `topic` may be repeated (`?topic=a&topic=b`) to follow several topics on
 * one connection. Omitting it entirely follows everything — reasonable here
 * because, per ADR-0001, every authenticated user may see every Notebook, so
 * there is nothing a topic filter would be protecting.
 */
export const eventStreamQuerySchema = z.object({
  topic: z.union([z.string(), z.array(z.string())]).optional(),
});

/** Interval between keepalive comments, in ms. */
const KEEPALIVE_INTERVAL_MS = 25_000;

/** Serializes one app event as an SSE frame. */
function toSseFrame(event: AppEvent): string {
  // Deliberately no `event:` name, even though every event has a `type`. A
  // browser `EventSource` can only receive a *named* SSE event by registering
  // a listener for that exact name, so naming frames would force every client
  // to enumerate the event types it might see — the opposite of the generic
  // channel this endpoint is meant to be. Unnamed frames all arrive on the
  // single `message` listener, and the client dispatches on the `type` inside
  // the JSON.
  //
  // `id:` lets a client report Last-Event-ID on reconnect. This endpoint does
  // not honour it (NOTIFY has no replay), so a reconnecting client re-fetches
  // current state over the REST routes instead.
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * The headers earlier hooks put on the reply — crucially @fastify/cors's
 * Access-Control-Allow-Origin/-Credentials, without which a browser
 * EventSource can't connect to this different-origin backend at all.
 *
 * They have to be read off the reply and written to the raw socket by hand:
 * `reply.hijack()` skips the rest of the lifecycle, so nothing else would
 * ever send them, and `writeHead` replaces the whole header set. Fastify's
 * header bag allows `undefined` values, which `writeHead` does not, so they
 * are filtered out here.
 */
function inheritedHeaders(reply: FastifyReply): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) headers[name] = value;
  }
  return headers;
}

export interface RegisterEventRoutesOptions {
  pool: Pool;
  appEvents: AppEventSubscriber;
}

/**
 * Registers the single, generic server-sent-events endpoint (NBK-6).
 *
 * Deliberately not ingestion-specific: it forwards whatever app events the
 * LISTEN subscriber sees, whatever their `type`. Later features (chat answer
 * chunks, other background-task progress) publish onto the same bus and
 * arrive here without this file changing.
 *
 * SSE rather than WebSockets because every one of those flows is
 * server→client only, and SSE is plain HTTP: the session cookie, CORS, and
 * the auth guard all work unchanged, and browsers reconnect on their own.
 */
export function registerEventRoutes(
  app: FastifyInstance,
  { pool, appEvents }: RegisterEventRoutesOptions,
): void {
  const authGuard = createAuthGuard(pool);

  app.withTypeProvider<ZodTypeProvider>().get(
    '/events',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'streamEvents',
        tags: ['events'],
        summary:
          'Subscribe to live app events over server-sent events. Generic: every event type (ingestion progress, and later chat streaming) arrives on this one stream.',
        querystring: eventStreamQuerySchema,
        response: {
          // The 200 is an endless `text/event-stream`, not JSON. Declared as
          // `any` for the same reason the Document download route is (see
          // src/documents/routes.ts): there is no Zod shape for a stream, and
          // `reply.hijack()` below means Fastify never serializes anything.
          200: z.any(),
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const requested = request.query.topic;
      const topics =
        requested === undefined
          ? null
          : new Set(Array.isArray(requested) ? requested : [requested]);

      // Take the socket over from Fastify: this response has no end, so the
      // normal serialize-and-send lifecycle doesn't apply.
      reply.hijack();
      const { raw } = reply;
      raw.writeHead(200, {
        ...inheritedHeaders(reply),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Tells any intermediary proxy not to buffer the stream, which would
        // defeat the point of it.
        'X-Accel-Buffering': 'no',
      });
      // An initial comment flushes response headers immediately, so a client
      // knows it is connected before the first real event.
      raw.write(': connected\n\n');

      const unsubscribe = appEvents.subscribe((event) => {
        if (topics && !topics.has(event.topic)) return;
        raw.write(toSseFrame(event));
      });

      // Keeps idle connections alive through proxies and lets this process
      // notice a client that vanished without closing cleanly.
      const keepalive = setInterval(() => raw.write(': keepalive\n\n'), KEEPALIVE_INTERVAL_MS);

      const cleanup = (): void => {
        clearInterval(keepalive);
        unsubscribe();
      };
      request.raw.on('close', cleanup);
      raw.on('error', cleanup);
    },
  );
}
