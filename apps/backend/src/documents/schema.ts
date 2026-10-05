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

// A Document's status. There is no background ingestion pipeline yet (that's
// later tickets), so "uploaded" — raw bytes stored, nothing more — is the
// only status that exists. Don't add fake intermediate statuses ahead of the
// processing they'd describe.
export const documentStatusSchema = z.literal("uploaded");

// A Document as returned over the API. See GLOSSARY.md: "a source file
// uploaded into a Notebook, tracked through successive Document Versions."
// `latestVersion` is the only Version surfaced here because, per GLOSSARY.md,
// "only a Document's latest Version is searched in chat" — older Versions
// stay retrievable only through Citations (not part of this ticket).
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
