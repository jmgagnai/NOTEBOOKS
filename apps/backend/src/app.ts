import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import Fastify, { type FastifyInstance } from "fastify";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Pool } from "pg";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerNotebookRoutes } from "./notebooks/routes.js";

export interface BuildAppOptions {
  pool: Pool;
}

/**
 * Builds (but does not start listening on) the Fastify app. Takes its
 * Postgres pool as a dependency so tests can hand it a Testcontainers-backed
 * pool instead of a real deployment's.
 */
export async function buildApp({ pool }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "RAG Notebook API",
        version: "0.0.1",
      },
    },
    transform: jsonSchemaTransform,
  });

  registerAuthRoutes(app, pool);
  registerNotebookRoutes(app, pool);

  return app;
}
