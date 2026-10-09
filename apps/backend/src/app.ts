import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { S3Client } from '@aws-sdk/client-s3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createJsonSchemaTransformObject,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import { registerAuthRoutes } from './auth/routes.js';
import type { ChatDeps } from './chat/answer-question.js';
import { registerChatRoutes } from './chat/routes.js';
import { registerDocumentRoutes } from './documents/routes.js';
import { documentFailureSchema } from './documents/schema.js';
import { MAX_UPLOAD_FILE_BYTES } from './documents/upload-limit.js';
import type { AppEventSubscriber } from './events/bus.js';
import { registerEventRoutes } from './events/routes.js';
import type { JobQueue } from './jobs/queue.js';
import type { Embedder } from './llm/embeddings.js';
import { registerNotebookRoutes } from './notebooks/routes.js';
import { registerSearchRoutes } from './search/routes.js';

export interface BuildAppOptions {
  pool: Pool;
  // Document upload (NBK-5) stores raw bytes in MinIO via the S3 API. `s3`
  // and `documentsBucket` are dependencies for the same reason `pool` is:
  // tests hand in a Testcontainers-backed client instead of a real
  // deployment's. Optional so existing callers/tests that don't touch
  // Document routes (e.g. notebooks.route.test.ts) don't need to change.
  s3?: S3Client;
  documentsBucket?: string;
  // Background jobs (NBK-6). Given, an upload enqueues ingestion stage 1;
  // omitted, uploads just land and stay "queued" — which is what the
  // Document route tests want, since they assert on the route, not the
  // pipeline.
  jobs?: JobQueue;
  // The LISTEN subscriber the generic SSE endpoint forwards from (NBK-6).
  // Omitted, `GET /events` isn't registered at all; a process that serves
  // live updates always supplies it.
  appEvents?: AppEventSubscriber;
  // The chat answer path (NBK-10): the OpenRouter completer, the embedder
  // used to embed a question for retrieval, and the fixed server-side chat
  // model. Optional for the same reason the ingestion deps are — a
  // deployment without an OpenRouter key still serves Thread CRUD, and
  // asking a question reports 503 instead of recording an unanswerable one.
  chat?: ChatDeps;
  // The Administrators' emails (GLOSSARY.md), as `ADMIN_EMAILS` lists them:
  // who may restore a deleted Chat Thread (NBK-95). Matched without regard
  // to case or surrounding spaces. Omitted, there is no Administrator.
  administrators?: readonly string[];
}

/**
 * Builds (but does not start listening on) the Fastify app. Takes its
 * Postgres pool as a dependency so tests can hand it a Testcontainers-backed
 * pool instead of a real deployment's.
 */
export async function buildApp({
  pool,
  s3,
  documentsBucket,
  jobs,
  appEvents,
  chat,
  administrators = [],
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  // Which setting governs a multipart upload's size (NBK-15): only the
  // plugin's `limits.fileSize`. Fastify's `bodyLimit` is enforced in its
  // content-type parser's `rawBody()`, which runs solely for parsers
  // registered with `parseAs: 'string' | 'buffer'`; @fastify/multipart
  // registers a stream parser (no `parseAs`), so Fastify hands it the raw
  // request and never counts its bytes. The plugin only *defaults*
  // `limits.fileSize` to `fastify.initialConfig.bodyLimit` (1 MiB) when none
  // is given — which is what refused every real PDF before this. Setting
  // `limits.fileSize` is therefore sufficient, and `bodyLimit` stays at its
  // default for the JSON routes it does govern. Past the limit busboy
  // truncates the stream and `file.toBuffer()` throws the plugin's
  // `RequestFileTooLargeError` (statusCode 413), which the upload route maps
  // to a message naming the limit.
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_FILE_BYTES } });
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'RAG Notebook API',
        version: '0.0.1',
      },
    },
    transform: jsonSchemaTransform,
    // Published as a named component only because ng-openapi-gen drops the
    // `| null` from an inline object that already mentions `null` inside it
    // (here `failedAt`), which would type a nullable `failure` as always
    // present. Behind a `$ref` the generator gets it right (NBK-64).
    transformObject: createJsonSchemaTransformObject({
      schemas: { DocumentFailure: documentFailureSchema },
    }),
  });
  // The same document `openapi:generate` writes to openapi.json, served
  // live with an interactive page (NBK-23): `/documentation` for the UI,
  // `/documentation/json` for the contract. The UI's own routes are hidden
  // from the document, so the published contract — and the glossary check
  // that runs on it — are unchanged by this.
  await app.register(swaggerUi, { routePrefix: '/documentation' });

  registerAuthRoutes(app, pool);
  registerNotebookRoutes(app, pool);
  registerChatRoutes(app, {
    pool,
    chat,
    administrators: new Set(
      administrators.map((email) => email.trim().toLowerCase()).filter((email) => email !== ''),
    ),
  });
  registerSearchRoutes(app, { pool });
  if (s3 && documentsBucket) {
    registerDocumentRoutes(app, { pool, s3, documentsBucket, jobs });
  }
  if (appEvents) {
    registerEventRoutes(app, { pool, appEvents });
  }

  return app;
}
