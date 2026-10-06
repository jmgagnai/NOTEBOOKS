import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Pool } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { createAuthGuard } from "../auth/guard.js";
import type { JobQueue } from "../jobs/queue.js";
import { errorResponseSchema } from "../auth/schema.js";
import { getObject, putObject } from "../storage/s3-client.js";
import { ACCEPTED_TYPES_DESCRIPTION, resolveAcceptedMimeType } from "./file-types.js";
import {
  createDocumentVersion,
  findDownloadableVersion,
  listDocuments,
  notebookExists,
  restoreDocument,
  softDeleteDocument,
} from "./repository.js";
import {
  documentIdParamsSchema,
  documentSchema,
  documentVersionDownloadParamsSchema,
  listDocumentsResponseSchema,
  notebookIdParamsSchema,
} from "./schema.js";

export interface RegisterDocumentRoutesOptions {
  pool: Pool;
  s3: S3Client;
  documentsBucket: string;
  /**
   * Ingestion (NBK-6). Given, a successful upload enqueues stage 1 —
   * conversion to Markdown — which is what moves the new Version off
   * "queued". Omitted, the upload still succeeds and the Version stays
   * "queued" until something works it, so the route is testable without
   * standing up pg_boss.
   */
  jobs?: JobQueue;
}

/**
 * Registers Document routes, nested under a Notebook. Every route sits
 * behind the auth guard but, per ADR-0001, does NOT check ownership — the
 * same shared-access model as Notebooks (NBK-4).
 */
export function registerDocumentRoutes(
  app: FastifyInstance,
  { pool, s3, documentsBucket, jobs }: RegisterDocumentRoutesOptions,
): void {
  const authGuard = createAuthGuard(pool);

  app.withTypeProvider<ZodTypeProvider>().get(
    "/notebooks/:notebookId/documents",
    {
      preHandler: authGuard,
      schema: {
        operationId: "listDocuments",
        tags: ["documents"],
        summary: "List all Documents in a Notebook",
        params: notebookIdParamsSchema,
        response: {
          200: listDocumentsResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await notebookExists(pool, request.params.notebookId))) {
        await reply.status(404).send({ message: "Notebook not found." });
        return;
      }
      await reply.status(200).send(await listDocuments(pool, request.params.notebookId));
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    "/notebooks/:notebookId/documents",
    {
      preHandler: authGuard,
      schema: {
        operationId: "uploadDocument",
        tags: ["documents"],
        summary:
          "Upload a Document. Re-uploading an existing, undeleted filename within the same Notebook adds a new Version to that Document instead of creating a new one.",
        consumes: ["multipart/form-data"],
        params: notebookIdParamsSchema,
        response: {
          201: documentSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!(await notebookExists(pool, request.params.notebookId))) {
        await reply.status(404).send({ message: "Notebook not found." });
        return;
      }

      const file = await request.file();
      if (!file) {
        await reply.status(400).send({ message: "No file was uploaded." });
        return;
      }

      const mimeType = resolveAcceptedMimeType(file.filename);
      if (!mimeType) {
        await reply.status(400).send({
          message: `Unsupported file type for "${file.filename}". Accepted types: ${ACCEPTED_TYPES_DESCRIPTION}.`,
        });
        return;
      }

      const buffer = await file.toBuffer();
      const storageKey = `notebooks/${request.params.notebookId}/${randomUUID()}-${file.filename}`;
      await putObject(s3, documentsBucket, storageKey, buffer, mimeType);

      const document = await createDocumentVersion(
        pool,
        request.params.notebookId,
        file.filename,
        mimeType,
        buffer.length,
        storageKey,
      );

      // Enqueued after the row is committed, never before: a job that
      // out-ran its own Document Version would find nothing to convert.
      // Enqueueing failures must not fail an upload whose bytes are already
      // stored — the Version stays "queued" and is the record of work still
      // owed.
      if (jobs) {
        try {
          await jobs.enqueueConvertToMarkdown({
            documentId: document.id,
            versionId: document.latestVersion.id,
          });
        } catch (err) {
          request.log.error({ err }, "Could not enqueue Markdown conversion for the uploaded Document Version.");
        }
      }

      await reply.status(201).send(document);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().delete(
    "/notebooks/:notebookId/documents/:documentId",
    {
      preHandler: authGuard,
      schema: {
        operationId: "deleteDocument",
        tags: ["documents"],
        summary: "Soft-delete a Document",
        params: documentIdParamsSchema,
        response: {
          204: z.null().describe("No content"),
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const deleted = await softDeleteDocument(pool, request.params.notebookId, request.params.documentId);
      if (!deleted) {
        await reply.status(404).send({ message: "Document not found." });
        return;
      }
      await reply.status(204).send(null);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    "/notebooks/:notebookId/documents/:documentId/restore",
    {
      preHandler: authGuard,
      schema: {
        operationId: "restoreDocument",
        tags: ["documents"],
        summary: "Restore a soft-deleted Document",
        params: documentIdParamsSchema,
        response: {
          200: documentSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const document = await restoreDocument(pool, request.params.notebookId, request.params.documentId);
      if (!document) {
        await reply.status(404).send({ message: "Document not found." });
        return;
      }
      await reply.status(200).send(document);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().get(
    "/notebooks/:notebookId/documents/:documentId/versions/:versionId/download",
    {
      preHandler: authGuard,
      schema: {
        operationId: "downloadDocumentVersion",
        tags: ["documents"],
        summary: "Download the exact original bytes uploaded for a Document Version",
        params: documentVersionDownloadParamsSchema,
        response: {
          // The 200 response is the raw file stream, not JSON — there's no
          // meaningful Zod shape for "whatever bytes were stored". Fastify
          // detects a stream payload (`typeof payload.pipe === 'function'`)
          // and pipes it directly, bypassing serialization entirely before
          // this schema would ever be consulted (see reply.send's early
          // stream check in Fastify's lib/reply.js) — it's declared only so
          // TypeScript accepts `reply.status(200).send(stream)` below.
          200: z.any(),
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const version = await findDownloadableVersion(
        pool,
        request.params.notebookId,
        request.params.documentId,
        request.params.versionId,
      );
      if (!version) {
        await reply.status(404).send({ message: "Document Version not found." });
        return;
      }

      const stored = await getObject(s3, documentsBucket, version.storageKey);
      reply.header("Content-Type", version.mimeType);
      reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(version.filename)}"`);
      if (stored.contentLength !== undefined) {
        reply.header("Content-Length", stored.contentLength);
      }
      await reply.status(200).send(stored.body);
    },
  );
}
