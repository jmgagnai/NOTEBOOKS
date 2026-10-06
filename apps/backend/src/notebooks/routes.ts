import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthGuard } from '../auth/guard.js';
import { errorResponseSchema } from '../auth/schema.js';
import {
  createNotebook,
  listNotebooks,
  renameNotebook,
  restoreNotebook,
  softDeleteNotebook,
} from './repository.js';
import {
  createNotebookRequestSchema,
  listNotebooksResponseSchema,
  notebookIdParamsSchema,
  notebookSchema,
  renameNotebookRequestSchema,
} from './schema.js';

/**
 * Registers Notebook routes. Every route sits behind the auth guard (login
 * required) but, per ADR-0001 (shared Notebook access despite full
 * attribution), does NOT check ownership: any authenticated user may list,
 * create, rename, delete, or restore any Notebook, including ones they
 * didn't create.
 */
export function registerNotebookRoutes(app: FastifyInstance, pool: Pool): void {
  const authGuard = createAuthGuard(pool);

  app.withTypeProvider<ZodTypeProvider>().get(
    '/notebooks',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'listNotebooks',
        tags: ['notebooks'],
        summary: 'List all Notebooks',
        response: {
          200: listNotebooksResponseSchema,
        },
      },
    },
    async () => listNotebooks(pool),
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    '/notebooks',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'createNotebook',
        tags: ['notebooks'],
        summary: 'Create a Notebook',
        body: createNotebookRequestSchema,
        response: {
          201: notebookSchema,
        },
      },
    },
    async (request, reply) => {
      const notebook = await createNotebook(pool, request.body.title);
      await reply.status(201).send(notebook);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().patch(
    '/notebooks/:id',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'renameNotebook',
        tags: ['notebooks'],
        summary: 'Rename a Notebook',
        params: notebookIdParamsSchema,
        body: renameNotebookRequestSchema,
        response: {
          200: notebookSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const notebook = await renameNotebook(pool, request.params.id, request.body.title);
      if (!notebook) {
        await reply.status(404).send({ message: 'Notebook not found.' });
        return;
      }
      await reply.status(200).send(notebook);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().delete(
    '/notebooks/:id',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'deleteNotebook',
        tags: ['notebooks'],
        summary: 'Soft-delete a Notebook',
        params: notebookIdParamsSchema,
        response: {
          204: z.null().describe('No content'),
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const deleted = await softDeleteNotebook(pool, request.params.id);
      if (!deleted) {
        await reply.status(404).send({ message: 'Notebook not found.' });
        return;
      }
      await reply.status(204).send(null);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    '/notebooks/:id/restore',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'restoreNotebook',
        tags: ['notebooks'],
        summary: 'Restore a soft-deleted Notebook',
        params: notebookIdParamsSchema,
        response: {
          200: notebookSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const notebook = await restoreNotebook(pool, request.params.id);
      if (!notebook) {
        await reply.status(404).send({ message: 'Notebook not found.' });
        return;
      }
      await reply.status(200).send(notebook);
    },
  );
}
