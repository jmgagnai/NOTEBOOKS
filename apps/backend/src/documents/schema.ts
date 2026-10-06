import { z } from "zod";

// A Document Version as returned over the API. See GLOSSARY.md: "a specific
// revision of a Document."
export const documentVersionSchema = z.object({
  id: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
});
export type DocumentVersion = z.infer<typeof documentVersionSchema>;

// Where a Document Version is in the ingestion pipeline (NBK-6). Stage 1 is
// Markdown conversion: an upload is enqueued ("queued"), a worker picks it up
// ("converting"), and it ends "converted" or "failed". Later stages add their
// own values to this progression rather than a parallel field.
export const documentStatusSchema = z.enum(["queued", "converting", "converted", "failed"]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

// A Document as returned over the API. See GLOSSARY.md: "a source file
// uploaded into a Notebook, tracked through successive Document Versions."
// `latestVersion` is the only Version surfaced here because, per GLOSSARY.md,
// "only a Document's latest Version is searched in chat" — older Versions
// stay retrievable only through Citations (not part of this ticket).
// `status` is the latest Version's ingestion status, mirrored onto the
// Document so the UI has one field to render a badge from. It is derived, not
// stored: `document_versions.ingestion_status` is the single source of truth.
export const documentSchema = z.object({
  id: z.string().uuid(),
  notebookId: z.string().uuid(),
  filename: z.string(),
  status: documentStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  latestVersion: documentVersionSchema,
});
export type Document = z.infer<typeof documentSchema>;

export const listDocumentsResponseSchema = z.array(documentSchema);

export const notebookIdParamsSchema = z.object({
  notebookId: z.string().uuid(),
});
export type NotebookIdParams = z.infer<typeof notebookIdParamsSchema>;

export const documentIdParamsSchema = z.object({
  notebookId: z.string().uuid(),
  documentId: z.string().uuid(),
});
export type DocumentIdParams = z.infer<typeof documentIdParamsSchema>;

export const documentVersionDownloadParamsSchema = z.object({
  notebookId: z.string().uuid(),
  documentId: z.string().uuid(),
  versionId: z.string().uuid(),
});
export type DocumentVersionDownloadParams = z.infer<typeof documentVersionDownloadParamsSchema>;
