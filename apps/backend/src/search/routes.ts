import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import { createAuthGuard } from '../auth/guard.js';
import { errorResponseSchema } from '../auth/schema.js';
import { notebookExists } from '../notebooks/repository.js';
import { EXCHANGE_RESULT_LIMIT, searchExchanges } from './exchanges.js';
import { correct, searchedWords } from './correction.js';
import type { Found } from './keywords.js';
import { DOCUMENT_RESULT_LIMIT, searchChunks } from './repository.js';
import {
  searchNotebookParamsSchema,
  searchNotebookQuerySchema,
  searchNotebookResponseSchema,
  searchThreadsQuerySchema,
  searchThreadsResponseSchema,
} from './schema.js';

export interface RegisterSearchRoutesOptions {
  pool: Pool;
}

/**
 * Registers the Notebook search routes: Documents (NBK-9, by keyword since
 * NBK-104) and Chat Threads (NBK-97). Behind the auth guard but, per
 * ADR-0001, with no ownership check — the same shared-access model as
 * Notebooks and Documents. Neither embeds anything, so neither needs an
 * OpenRouter key.
 */
export function registerSearchRoutes(
  app: FastifyInstance,
  { pool }: RegisterSearchRoutesOptions,
): void {
  const authGuard = createAuthGuard(pool);

  app.withTypeProvider<ZodTypeProvider>().get(
    '/notebooks/:notebookId/search',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'searchNotebook',
        tags: ['search'],
        summary: `Search a Notebook's Documents by keyword. Returns each matching Chunk as an Excerpt with its matches marked; up to ${DOCUMENT_RESULT_LIMIT}, best first.`,
        description:
          "Full-text search over the Chunks of each Document's latest ready Version, accents " +
          'and case ignored (no embedding, so it needs no OpenRouter key). A Document appears ' +
          'once per matching Chunk. A misspelt word is corrected to the closest word the ' +
          'Notebook holds unless exact=true; correctedQuery says what was searched. Per ' +
          'ADR-0001 there is no ownership check.',
        params: searchNotebookParamsSchema,
        querystring: searchNotebookQuerySchema,
        response: {
          200: searchNotebookResponseSchema,
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
        .send(
          await search(pool, request.params.notebookId, request.query, (query, typed) =>
            searchChunks(pool, request.params.notebookId, query, typed),
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
        summary: `Search a Notebook's Chat Threads by keyword. Returns each matching Exchange — a question and the answer it produced — with its matches marked; up to ${EXCHANGE_RESULT_LIMIT}, best first.`,
        description:
          'Full-text search over questions and answers, accents and case ignored (no embedding, ' +
          'so it needs no OpenRouter key). A misspelt word is corrected as for Documents. ' +
          'Deleted Chat Threads are left out. Per ADR-0001 there is no ownership check.',
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
        .send(
          await search(pool, request.params.notebookId, request.query, (query, typed) =>
            searchExchanges(pool, request.params.notebookId, query, typed),
          ),
        );
    },
  );
}

/**
 * One search, either kind: the query corrected first (NBK-105) unless asked
 * for exactly, then searched, and the correction reported beside the
 * results so the page can say what it searched for — and the words, so it
 * can mark them where a result opens.
 */
async function search<T>(
  pool: Pool,
  notebookId: string,
  { q, exact }: { q: string; exact: 'true' | 'false' },
  find: (query: string, typed: string) => Promise<Found<T>>,
): Promise<{ correctedQuery: string | null; words: string[]; total: number; results: T[] }> {
  const { searched, correctedQuery } =
    exact === 'true' ? { searched: q, correctedQuery: null } : await correct(pool, notebookId, q);
  const { results, total } = await find(searched, q);
  return { correctedQuery, words: searchedWords(searched), total, results };
}
