import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import { createAuthGuard } from '../auth/guard.js';
import { errorResponseSchema } from '../auth/schema.js';
import { notebookExists } from '../notebooks/repository.js';
import type { Embedder } from '../llm/embeddings.js';
import { searchExchanges } from './exchanges.js';
import { searchNotebook } from './repository.js';
import {
  searchNotebookParamsSchema,
  searchNotebookQuerySchema,
  searchNotebookResponseSchema,
  searchThreadsQuerySchema,
  searchThreadsResponseSchema,
} from './schema.js';

export interface RegisterSearchRoutesOptions {
  pool: Pool;
  /**
   * The OpenRouter embeddings boundary — the same `Embedder` ingestion stage
   * 3 writes chunks with, because a query has to be embedded by the same
   * model as the chunks it is compared against (ADR-0002, and the width of
   * `chunks.embedding`). Optional for the same reason the server warns
   * rather than refusing to start without a key: the route is still
   * registered and answers 503, so the contract doesn't change shape
   * depending on configuration.
   */
  embed?: Embedder;
}

/**
 * Registers the Notebook search route (NBK-9). Behind the auth guard but,
 * per ADR-0001, with no ownership check — the same shared-access model as
 * Notebooks and Documents.
 */
export function registerSearchRoutes(
  app: FastifyInstance,
  { pool, embed }: RegisterSearchRoutesOptions,
): void {
  const authGuard = createAuthGuard(pool);

  app.withTypeProvider<ZodTypeProvider>().get(
    '/notebooks/:notebookId/search',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'searchNotebook',
        tags: ['search'],
        summary:
          "Search a Notebook's Documents semantically. Matches Chunks by vector similarity, rolls them up to their parent Document, and returns each matched Document with its Abstract.",
        params: searchNotebookParamsSchema,
        querystring: searchNotebookQuerySchema,
        response: {
          200: searchNotebookResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!embed) {
        await reply.status(503).send({
          message:
            'Search is unavailable: no embedding model is configured. Set OPENROUTER_API_KEY.',
        });
        return;
      }

      // Checked before OpenRouter is called: a mistyped Notebook id should
      // cost nothing, and an empty result set would otherwise be
      // indistinguishable from a Notebook that doesn't exist.
      if (!(await notebookExists(pool, request.params.notebookId))) {
        await reply.status(404).send({ message: 'Notebook not found.' });
        return;
      }

      // The query goes through the same `Embedder` that embedded the Chunks,
      // because a vector comparison between two different models' output is
      // meaningless. `Embedder` takes an array; a search is one text, so it
      // comes back as one vector.
      const [queryEmbedding] = await embed([request.query.q]);

      await reply
        .status(200)
        .send(
          await searchNotebook(
            pool,
            request.params.notebookId,
            queryEmbedding,
            request.query.limit,
          ),
        );
    },
  );

  app.withTypeProvider<ZodTypeProvider>().get(
    '/notebooks/:notebookId/search/threads',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'searchChatThreads',
        tags: ['search'],
        summary:
          "Search a Notebook's Chat Threads by keyword. Returns each matching Exchange — a question and the answer it produced — with its matches marked; up to 20, best first.",
        description:
          'Full-text search over questions and answers (no embedding, so it needs no OpenRouter ' +
          'key). Deleted Chat Threads are left out. Per ADR-0001 there is no ownership check.',
        params: searchNotebookParamsSchema,
        querystring: searchThreadsQuerySchema,
        response: {
          200: searchThreadsResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await notebookExists(pool, request.params.notebookId))) {
        await reply.status(404).send({ message: 'Notebook not found.' });
        return;
      }
      await reply
        .status(200)
        .send(await searchExchanges(pool, request.params.notebookId, request.query.q));
    },
  );
}
