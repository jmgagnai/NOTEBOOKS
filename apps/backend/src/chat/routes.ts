import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthGuard } from '../auth/guard.js';
import { errorResponseSchema } from '../auth/schema.js';
import { notebookExists } from '../notebooks/repository.js';
import { streamAnswer, type ChatDeps, type GroundedAnswer } from './answer-question.js';
import {
  appendQuestionAndAnswer,
  createChatThread,
  deleteChatThread,
  findChatThread,
  isChatThreadDeleted,
  listChatMessages,
  listChatThreads,
  renameChatThread,
  restoreChatThread,
} from './repository.js';
import {
  chatThreadIdParamsSchema,
  chatThreadSchema,
  createChatThreadRequestSchema,
  listChatMessagesResponseSchema,
  listChatThreadsResponseSchema,
  notebookIdParamsSchema,
  renameChatThreadRequestSchema,
  sendChatMessageRequestSchema,
  sendChatMessageResponseSchema,
} from './schema.js';
import { createAnswerStream } from './streaming.js';

export interface RegisterChatRoutesOptions {
  pool: Pool;
  /**
   * The OpenRouter-backed answer path. Omitted — the shape a deployment with
   * no `OPENROUTER_API_KEY` has — Thread CRUD and reading a Thread's messages
   * still work, and asking a question reports 503 rather than recording a
   * question nothing will ever answer.
   */
  chat?: ChatDeps;
  /**
   * The Administrators' emails, lower-cased (GLOSSARY.md; `ADMIN_EMAILS`):
   * who may restore a deleted Chat Thread. Empty — the default — means no
   * one may.
   */
  administrators?: ReadonlySet<string>;
}

/**
 * Registers Chat Thread routes, nested under a Notebook. Every route sits
 * behind the auth guard — the asking user is what attribution is recorded
 * from — and, per ADR-0001, a Thread someone else started is as readable,
 * renameable and continuable as your own. The two exceptions are its
 * amendment's (NBK-95): only a Thread's author deletes it, and only an
 * Administrator restores it.
 */
export function registerChatRoutes(
  app: FastifyInstance,
  { pool, chat, administrators = new Set() }: RegisterChatRoutesOptions,
): void {
  const authGuard = createAuthGuard(pool);

  app.withTypeProvider<ZodTypeProvider>().get(
    '/notebooks/:notebookId/threads',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'listChatThreads',
        tags: ['chat'],
        summary: 'List every Chat Thread in a Notebook',
        params: notebookIdParamsSchema,
        response: {
          200: listChatThreadsResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await notebookExists(pool, request.params.notebookId))) {
        await reply.status(404).send({ message: 'Notebook not found.' });
        return;
      }
      await reply.status(200).send(await listChatThreads(pool, request.params.notebookId));
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    '/notebooks/:notebookId/threads',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'createChatThread',
        tags: ['chat'],
        summary: 'Start a Chat Thread in a Notebook',
        params: notebookIdParamsSchema,
        body: createChatThreadRequestSchema,
        response: {
          201: chatThreadSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await notebookExists(pool, request.params.notebookId))) {
        await reply.status(404).send({ message: 'Notebook not found.' });
        return;
      }
      const thread = await createChatThread(
        pool,
        request.params.notebookId,
        request.body.title,
        request.authUser!.id,
      );
      await reply.status(201).send(thread);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().patch(
    '/notebooks/:notebookId/threads/:threadId',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'renameChatThread',
        tags: ['chat'],
        summary: 'Rename a Chat Thread',
        params: chatThreadIdParamsSchema,
        body: renameChatThreadRequestSchema,
        response: {
          200: chatThreadSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // No author check, per ADR-0001 — the same shared-edit model as
      // renaming a Notebook (NBK-4).
      const thread = await renameChatThread(
        pool,
        request.params.notebookId,
        request.params.threadId,
        request.body.title,
      );
      if (!thread) {
        await reply.status(404).send({ message: 'Chat Thread not found.' });
        return;
      }
      await reply.status(200).send(thread);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().delete(
    '/notebooks/:notebookId/threads/:threadId',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'deleteChatThread',
        tags: ['chat'],
        summary: 'Delete a Chat Thread (its author only)',
        description:
          'Soft-deletes the Chat Thread: it leaves the list and every route answers 404 for it, ' +
          'but its messages and their Citations are kept, and an Administrator can restore it. ' +
          'Only the user who started the Thread may delete it (ADR-0001 amendment).',
        params: chatThreadIdParamsSchema,
        response: {
          204: z.null().describe('No content'),
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { notebookId, threadId } = request.params;
      const user = request.authUser!;
      const thread = await findChatThread(pool, notebookId, threadId);
      if (!thread) {
        await reply.status(404).send({ message: 'Chat Thread not found.' });
        return;
      }
      if (thread.author.id !== user.id) {
        await reply
          .status(403)
          .send({ message: 'Only the user who started a Chat Thread may delete it.' });
        return;
      }
      if (!(await deleteChatThread(pool, notebookId, threadId))) {
        await reply.status(404).send({ message: 'Chat Thread not found.' });
        return;
      }
      // There is no list of deleted Threads: this line is how an
      // Administrator finds one to restore (docs/administration.md).
      // eslint-disable-next-line no-console
      console.info(
        `Chat Thread deleted: id=${threadId} title=${JSON.stringify(thread.title)} ` +
          `notebook=${notebookId} author=${thread.author.email}`,
      );
      await reply.status(204).send(null);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    '/notebooks/:notebookId/threads/:threadId/restore',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'restoreChatThread',
        tags: ['chat'],
        summary: 'Restore a deleted Chat Thread (Administrator only)',
        description:
          'Brings a deleted Chat Thread back with its messages. Only an Administrator — a user ' +
          "whose email is in the backend's `ADMIN_EMAILS` — may call it; the app's UI never " +
          'does. See docs/administration.md.',
        params: chatThreadIdParamsSchema,
        response: {
          200: chatThreadSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!administrators.has(request.authUser!.email.toLowerCase())) {
        await reply
          .status(403)
          .send({ message: 'Only an Administrator may restore a Chat Thread.' });
        return;
      }
      const thread = await restoreChatThread(
        pool,
        request.params.notebookId,
        request.params.threadId,
      );
      if (!thread) {
        await reply.status(404).send({ message: 'No deleted Chat Thread by that id.' });
        return;
      }
      await reply.status(200).send(thread);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().get(
    '/notebooks/:notebookId/threads/:threadId/messages',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'listChatMessages',
        tags: ['chat'],
        summary: 'Read every message in a Chat Thread, in the order they were asked',
        params: chatThreadIdParamsSchema,
        response: {
          200: listChatMessagesResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Any authenticated user may read any Thread (ADR-0001), so the only
      // question is whether it exists in this Notebook.
      const thread = await findChatThread(pool, request.params.notebookId, request.params.threadId);
      if (!thread) {
        await reply.status(404).send({ message: 'Chat Thread not found.' });
        return;
      }
      await reply.status(200).send(await listChatMessages(pool, thread.id));
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    '/notebooks/:notebookId/threads/:threadId/messages',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'sendChatMessage',
        tags: ['chat'],
        summary: 'Ask a question in a Chat Thread and get one grounded answer',
        description:
          "Retrieves the closest Chunks from the Notebook's latest-version, `ready` Documents and " +
          'returns the complete recorded exchange. While the answer is being generated it is also ' +
          'published to the live `GET /events` stream as `chat-answer-chunk` events in ' +
          'paragraph/heading-sized pieces, followed by one `chat-answer-completed` event naming the ' +
          'persisted message and carrying its Citations — so a client can render the answer ' +
          'progressively and this response is the authoritative result. The answer message carries ' +
          'a Citation per source marker in its text, each pinned to the exact Document Version and ' +
          'chunk it was grounded in and persisted with the message.',
        params: chatThreadIdParamsSchema,
        body: sendChatMessageRequestSchema,
        response: {
          201: sendChatMessageResponseSchema,
          404: errorResponseSchema,
          502: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { notebookId, threadId } = request.params;
      const thread = await findChatThread(pool, notebookId, threadId);
      if (!thread) {
        // Someone who still had it open asks in a Thread its author deleted
        // (NBK-95): say so, rather than that it never existed.
        const deleted = await isChatThreadDeleted(pool, notebookId, threadId);
        await reply.status(404).send({
          message: deleted ? 'This Chat Thread was deleted.' : 'Chat Thread not found.',
        });
        return;
      }
      if (!chat) {
        await reply.status(503).send({
          message: 'Chat is not configured on this server: OPENROUTER_API_KEY is not set.',
        });
        return;
      }

      // Read before writing: the question being asked must not appear in its
      // own "Chat Thread so far".
      const history = await listChatMessages(pool, thread.id);

      // The answer is streamed onto the generic app-event channel as it is
      // written (NBK-11), and this response still carries the whole recorded
      // exchange. Both, not one or the other: the chunks let a reader start
      // reading early, and the response is the truth a client stores. That
      // is GLOSSARY.md's rule about an App Event applied literally — "they
      // carry what changed, and a client that missed one re-reads the truth
      // over the normal API" — and it is why no replay buffer exists here.
      // Everyone else with the Notebook open sees the same chunks, which is
      // the right behaviour for a Thread that is shared by definition.
      const stream = createAnswerStream(pool, {
        notebookId: thread.notebookId,
        threadId: thread.id,
      });

      let answer: GroundedAnswer;
      try {
        answer = await streamAnswer(
          pool,
          chat,
          { notebookId: thread.notebookId, question: request.body.content, history },
          (text) => stream.chunk(text),
        );
      } catch (err) {
        // Nothing is recorded, exactly as in NBK-10's synchronous path. A
        // question sitting unanswered in a shared Thread reads as one the
        // team ignored, and there is no retry mechanism here for the user to
        // lean on — asking again is the retry, and that works only if the
        // failed attempt left no trace.
        //
        // A half-streamed answer is the one new wrinkle: chunks a client
        // already rendered describe prose that will never be persisted, so
        // the failure is announced on the same channel and the preview is
        // dropped. Publishing is best-effort — the user's 502 matters more
        // than the notification, and the asking client learns of the failure
        // from it anyway.
        request.log.error({ err }, 'A chat answer could not be generated.');
        await stream
          .failed(err instanceof Error ? err.message : 'The answer could not be generated.')
          .catch((publishErr: unknown) => {
            request.log.warn({ err: publishErr }, 'Could not announce a failed chat answer.');
          });
        await reply.status(502).send({
          message: 'The answer could not be generated. Nothing was recorded; please ask again.',
        });
        return;
      }

      // A marker the model invented does not fail the request — the answer
      // is still worth having and the prose is recorded verbatim — but it is
      // worth seeing in the logs, because a model that routinely cites
      // sources it was not given is a prompt problem.
      if (answer.unresolvedMarkers.length > 0) {
        request.log.warn(
          { markers: answer.unresolvedMarkers, retrieved: answer.chunks.length },
          'A chat answer cited source markers that matched no retrieved Chunk; they were dropped.',
        );
      }

      // Question, answer and the answer's Citations in one transaction, so a
      // Thread never holds an answer whose sources are missing — and one
      // `chat_messages` row for the answer however many chunks it was
      // delivered in (NBK-11). The streaming is delivery; this is the record.
      const exchange = await appendQuestionAndAnswer(
        pool,
        thread.id,
        request.authUser!.id,
        request.body.content,
        answer.text,
        answer.citations,
      );
      if (!exchange) {
        // Deleted by its author while the answer was being written (NBK-95):
        // nothing is recorded, and the preview others saw stream is dropped
        // the way a failed answer's is.
        await stream.failed('This Chat Thread was deleted.').catch((err: unknown) => {
          request.log.warn({ err }, 'Could not announce a dropped chat answer.');
        });
        await reply.status(404).send({ message: 'This Chat Thread was deleted.' });
        return;
      }

      // Published only now that the row exists, so the event can name it:
      // this is what turns a client's chunk preview into the persisted
      // message, and the only event that can carry Citations, since they are
      // resolved from the complete text. Best-effort for the same reason as
      // above — the 201 below is the authoritative answer.
      await stream
        .completed({
          messageId: exchange.answer.id,
          questionId: exchange.question.id,
          citations: exchange.answer.citations,
        })
        .catch((err: unknown) => {
          request.log.warn({ err }, 'Could not announce a completed chat answer.');
        });

      await reply.status(201).send(exchange);
    },
  );
}
