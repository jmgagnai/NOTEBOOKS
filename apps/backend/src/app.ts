import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import type { S3Client } from "@aws-sdk/client-s3";
import Fastify, { type FastifyInstance } from "fastify";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Pool } from "pg";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerDocumentRoutes } from "./documents/routes.js";
import { registerNotebookRoutes } from "./notebooks/routes.js";

export interface BuildAppOptions {
  pool: Pool;
  // Document upload (NBK-5) stores raw bytes in MinIO via the S3 API. `s3`
  // and `documentsBucket` are dependencies for the same reason `pool` is:
  // tests hand in a Testcontainers-backed client instead of a real
  // deployment's. Optional so existing callers/tests that don't touch
  // Document routes (e.g. notebooks.route.test.ts) don't need to change.
  s3?: S3Client;
  documentsBucket?: string;
}

/**
 * Builds (but does not start listening on) the Fastify app. Takes its
 * Postgres pool as a dependency so tests can hand it a Testcontainers-backed
 * pool instead of a real deployment's.
 */
export async function buildApp({ pool, s3, documentsBucket }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(multipart);
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
  if (s3 && documentsBucket) {
    registerDocumentRoutes(app, { pool, s3, documentsBucket });
  }

  return app;
}
