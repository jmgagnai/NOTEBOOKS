import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Pool } from "pg";
import { listNotebooks } from "./repository.js";
import { listNotebooksResponseSchema } from "./schema.js";

export function registerNotebookRoutes(app: FastifyInstance, pool: Pool): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/notebooks",
    {
      schema: {
        operationId: "listNotebooks",
        tags: ["notebooks"],
        summary: "List all Notebooks",
        response: {
          200: listNotebooksResponseSchema,
        },
      },
    },
    async () => listNotebooks(pool),
  );
}
