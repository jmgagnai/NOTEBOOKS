import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Pool } from "pg";
import { createAuthGuard } from "../auth/guard.js";
import { errorResponseSchema } from "../auth/schema.js";
import { notebookExists } from "../documents/repository.js";
import { answerQuestion, type ChatDeps, type GroundedAnswer } from "./answer-question.js";
import {
  appendQuestionAndAnswer,
  createChatThread,
  findChatThread,
  listChatMessages,
  listChatThreads,
  renameChatThread,
} from "./repository.js";
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
} from "./schema.js";

export interface RegisterChatRoutesOptions {
  pool: Pool;
  /**
   * The OpenRouter-backed answer path. Omitted — the shape a deployment with
   * no `OPENROUTER_API_KEY` has — Thread CRUD and reading a conversation
   * still work, and asking a question reports 503 rather than recording a
   * question nothing will ever answer.
   */
  chat?: ChatDeps;
}

/**
 * Registers Chat Thread routes, nested under a Notebook. Every route sits
 * behind the auth guard — the asking user is what attribution is recorded
 * from — but, per ADR-0001, no route checks who authored anything: listing
 * is unfiltered, and a Thread someone else started is as readable and
 * continuable as your own.
 */
export function registerChatRoutes(app: FastifyInstance, { pool, chat }: RegisterChatRoutesOptions): void {
  const authGuard = createAuthGuard(pool);

  app.withTypeProvider<ZodTypeProvider>().get(
    "/notebooks/:notebookId/threads",
    {
      preHandler: authGuard,
      schema: {
        operationId: "listChatThreads",
        tags: ["chat"],
        summary: "List every Chat Thread in a Notebook",
        params: notebookIdParamsSchema,
        response: {
          200: listChatThreadsResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await notebookExists(pool, request.params.notebookId))) {
        await reply.status(404).send({ message: "Notebook not found." });
        return;
      }
      await reply.status(200).send(await listChatThreads(pool, request.params.notebookId));
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    "/notebooks/:notebookId/threads",
    {
      preHandler: authGuard,
      schema: {
        operationId: "createChatThread",
        tags: ["chat"],
        summary: "Start a Chat Thread in a Notebook",
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
        await reply.status(404).send({ message: "Notebook not found." });
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
    "/notebooks/:notebookId/threads/:threadId",
    {
      preHandler: authGuard,
      schema: {
        operationId: "renameChatThread",
        tags: ["chat"],
        summary: "Rename a Chat Thread",
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
        await reply.status(404).send({ message: "Chat Thread not found." });
        return;
      }
      await reply.status(200).send(thread);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().get(
    "/notebooks/:notebookId/threads/:threadId/messages",
    {
      preHandler: authGuard,
      schema: {
        operationId: "listChatMessages",
        tags: ["chat"],
        summary: "Read a Chat Thread's conversation",
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
        await reply.status(404).send({ message: "Chat Thread not found." });
        return;
      }
      await reply.status(200).send(await listChatMessages(pool, thread.id));
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    "/notebooks/:notebookId/threads/:threadId/messages",
    {
      preHandler: authGuard,
      schema: {
        operationId: "sendChatMessage",
        tags: ["chat"],
        summary: "Ask a question in a Chat Thread and get one grounded answer",
        description:
          "Retrieves the closest Chunks from the Notebook's latest-version, `ready` Documents and " +
          "returns one complete answer. The answer is not streamed. The answer message carries a " +
          "Citation per source marker in its text, each pinned to the exact Document Version and " +
          "chunk it was grounded in and persisted with the message.",
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
      const thread = await findChatThread(pool, request.params.notebookId, request.params.threadId);
      if (!thread) {
        await reply.status(404).send({ message: "Chat Thread not found." });
        return;
      }
      if (!chat) {
        await reply.status(503).send({
          message: "Chat is not configured on this server: OPENROUTER_API_KEY is not set.",
        });
        return;
      }

      // Read before writing: the question being asked must not appear in its
      // own "conversation so far".
      const history = await listChatMessages(pool, thread.id);

      let answer: GroundedAnswer;
      try {
        answer = await answerQuestion(pool, chat, {
          notebookId: thread.notebookId,
          question: request.body.content,
          history,
        });
      } catch (err) {
        // Nothing is recorded. A question sitting unanswered in a shared
        // Thread reads as one the team ignored, and there is no retry
        // mechanism here for the user to lean on — asking again is the
        // retry, and that works only if the failed attempt left no trace.
        request.log.error({ err }, "A chat answer could not be generated.");
        await reply.status(502).send({
          message: "The answer could not be generated. Nothing was recorded; please ask again.",
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
          "A chat answer cited source markers that matched no retrieved Chunk; they were dropped.",
        );
      }

      // Question, answer and the answer's Citations in one transaction, so a
      // Thread never holds an answer whose sources are missing.
      const exchange = await appendQuestionAndAnswer(
        pool,
        thread.id,
        request.authUser!.id,
        request.body.content,
        answer.text,
        answer.citations,
      );
      await reply.status(201).send(exchange);
    },
  );
}
