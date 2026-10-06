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
import { notebookExists } from "../notebooks/repository.js";
import { describeRejectedFileType, resolveAcceptedMimeType } from "./file-types.js";
import {
  createDocumentVersion,
  findDocumentContent,
  findDocumentDetail,
  findDocumentVersionDetail,
  findDownloadableVersion,
  listDocuments,
  restoreDocument,
  softDeleteDocument,
} from "./repository.js";
import {
  documentContentSchema,
  documentDetailSchema,
  documentIdParamsSchema,
  documentSchema,
  documentVersionContentParamsSchema,
  documentVersionDetailSchema,
  documentVersionDownloadParamsSchema,
  documentVersionParamsSchema,
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

  // Opening a Document (NBK-7): its Executive Summary, Abstract, Chat
  // Snippet and extracted metadata — everything but the full Converted
  // Markdown, which is a separate request because it can run past 200 pages.
  app.withTypeProvider<ZodTypeProvider>().get(
    "/notebooks/:notebookId/documents/:documentId",
    {
      preHandler: authGuard,
      schema: {
        operationId: "getDocument",
        tags: ["documents"],
        summary:
          "Get one Document with its latest Version's extracted metadata and generated summaries (Abstract, Executive Summary, Chat Snippet)",
        params: documentIdParamsSchema,
        response: {
          200: documentDetailSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const document = await findDocumentDetail(pool, request.params.notebookId, request.params.documentId);
      if (!document) {
        await reply.status(404).send({ message: "Document not found." });
        return;
      }
      await reply.status(200).send(document);
    },
  );

  // Opening one specific Document Version (NBK-12). The route a Citation
  // reads, because the route above cannot serve it: that one is always about
  // the Document's *latest* Version, and per GLOSSARY.md following a Citation
  // must open "that exact Version ... even after newer Versions exist" — with
  // that Version's own Executive Summary, metadata and version number, not
  // the current Version's wrapped around the old one's content.
  app.withTypeProvider<ZodTypeProvider>().get(
    "/notebooks/:notebookId/documents/:documentId/versions/:versionId",
    {
      preHandler: authGuard,
      schema: {
        operationId: "getDocumentVersion",
        tags: ["documents"],
        summary:
          "Get one Document Version with its own extracted metadata and generated summaries (Abstract, Executive Summary, Chat Snippet)",
        description:
          "Every field describes the Version named in the path, not the Document's latest Version — this is " +
          "what following a Citation reads, so an answer recorded against a superseded Version stays " +
          "checkable against what that Version actually said. `isLatestVersion` and `latestVersionNumber` " +
          "say where that Version stands. Succeeds for a Version whose Document has since been " +
          "soft-deleted, and 404s once its Notebook is.",
        params: documentVersionParamsSchema,
        response: {
          200: documentVersionDetailSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const version = await findDocumentVersionDetail(
        pool,
        request.params.notebookId,
        request.params.documentId,
        request.params.versionId,
      );
      if (!version) {
        await reply.status(404).send({ message: "Document Version not found." });
        return;
      }
      await reply.status(200).send(version);
    },
  );

  // Expanding past the Executive Summary (NBK-7). Markdown, not rendered
  // HTML: the client renders the structure (headings, tables) itself, so the
  // structure has to reach it intact.
  app.withTypeProvider<ZodTypeProvider>().get(
    "/notebooks/:notebookId/documents/:documentId/versions/:versionId/content",
    {
      preHandler: authGuard,
      schema: {
        operationId: "getDocumentVersionContent",
        tags: ["documents"],
        summary: "Get the Converted Markdown of a Document Version",
        params: documentVersionContentParamsSchema,
        response: {
          200: documentContentSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const content = await findDocumentContent(
        pool,
        request.params.notebookId,
        request.params.documentId,
        request.params.versionId,
      );
      if (!content) {
        await reply.status(404).send({ message: "Document Version not found." });
        return;
      }
      await reply.status(200).send(content);
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
        // Some extensions get a reason rather than the bare accepted-types
        // list — notably legacy `.xls`, which the spec's unqualified "Excel"
        // invites and the converter cannot read. See file-types.ts.
        await reply.status(400).send({ message: describeRejectedFileType(file.filename) });
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
        description:
          "Reports 409 if the Notebook has since acquired another Document under the same filename — " +
          "a re-upload after the delete created one, and only one non-deleted Document per filename can " +
          "exist in a Notebook.",
        params: documentIdParamsSchema,
        response: {
          200: documentSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await restoreDocument(pool, request.params.notebookId, request.params.documentId);
      if (result.outcome === "not-found") {
        await reply.status(404).send({ message: "Document not found." });
        return;
      }
      if (result.outcome === "filename-taken") {
        // A conflict, not a server error: the Notebook's current contents are
        // what make the restore impossible, and the user can resolve it.
        await reply.status(409).send({
          message:
            `A Document named "${result.filename}" already exists in this Notebook, so the deleted one ` +
            "cannot be restored under that name. Delete the current one first, then restore this one.",
        });
        return;
      }
      await reply.status(200).send(result.document);
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
