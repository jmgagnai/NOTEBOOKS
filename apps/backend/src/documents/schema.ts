import { z } from 'zod';

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

// Where a Document Version is in the ingestion pipeline. Stage 1 is Markdown
// conversion (NBK-6): an upload is enqueued ("queued"), a worker picks it up
// ("converting"), and it reaches "converted". Stage 2 is metadata extraction
// and the three Generated document artifacts (NBK-7), chained off stage 1:
// it picks a converted Version up ("summarizing") and leaves it
// "summarized". Stage 3 is chunking and embeddings (NBK-8), chained off
// stage 2: it picks a summarized Version up ("indexing" — GLOSSARY.md
// reserves that word "for the embedding/retrieval stage specifically") and
// leaves it "ready", which is terminal for the pipeline and what tells a
// user the Document is safe to rely on for chat. "failed" is terminal for
// whichever stage exhausted its retries; `ingestion_error` says which and
// why. Later stages add their own values to this progression rather than a
// parallel field.
export const documentStatusSchema = z.enum([
  'queued',
  'converting',
  'converted',
  'summarizing',
  'summarized',
  'indexing',
  'ready',
  'failed',
]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

// Why a `failed` Document Version failed, in terms a user can act on (NBK-63).
// A closed set, decided by the Stage where it fails rather than read off the
// error text afterwards, so rewording a developer-facing message can never
// change what a user is told. The full error stays in `ingestion_error` and
// never reaches a response. `unexpected` is the honest fallback, and what a
// failure recorded before this column existed reports. Declared in full here
// so the published contract lists every value; a new one is an additive
// change. Mirrored by the check constraint in migration 0012.
export const failureReasonSchema = z.enum([
  'no-text-layer',
  'unreadable',
  'timed-out',
  'service-unavailable',
  'unexpected',
]);
export type FailureReason = z.infer<typeof failureReasonSchema>;

// The status a Document Version was in when its Stage gave up: the existing
// in-progress status names, so no second vocabulary for "stage" appears.
export const failedAtSchema = z.enum(['converting', 'summarizing', 'indexing']);
export type FailedAt = z.infer<typeof failedAtSchema>;

// `failedAt` is null only for a failure recorded before NBK-64, when nobody
// noted where it happened.
export const documentFailureSchema = z.object({
  reason: failureReasonSchema,
  failedAt: failedAtSchema.nullable(),
});
export type DocumentFailure = z.infer<typeof documentFailureSchema>;

// A Document as returned over the API. See GLOSSARY.md: "a source file
// uploaded into a Notebook, tracked through successive Document Versions."
// `latestVersion` is the only Version surfaced here because, per GLOSSARY.md,
// "only a Document's latest Version is searched in chat" — older Versions
// stay retrievable only through Citations (not part of this ticket).
// `status` is the latest Version's ingestion status, mirrored onto the
// Document so the UI has one field to render a badge from. It is derived, not
// stored: `document_versions.ingestion_status` is the single source of truth.
// `abstract` is the latest Version's Abstract — 50-100 words, per
// GLOSSARY.md "used in search results, search-result previews, and document
// cards". It is on the list payload precisely because that is where cards
// are rendered. Null until ingestion stage 2 has run. The Executive Summary
// and the Converted Markdown deliberately are NOT here: a Notebook's list
// must not carry 1-2 pages (let alone 200) per Document.
export const documentSchema = z.object({
  id: z.string().uuid(),
  notebookId: z.string().uuid(),
  filename: z.string(),
  status: documentStatusSchema,
  // Null unless `status` is `failed` (NBK-63).
  failure: documentFailureSchema.nullable(),
  abstract: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  latestVersion: documentVersionSchema,
});
export type Document = z.infer<typeof documentSchema>;

export const listDocumentsResponseSchema = z.array(documentSchema);

// Metadata extracted from a Document Version by ingestion stage 2 (NBK-7).
// Open-ended on purpose: what an extractor finds varies by document kind, so
// this mirrors the JSONB column it comes out of rather than freezing a field
// list the API would have to version.
export const documentMetadataResponseSchema = z.record(z.unknown()).nullable();

// A Document opened on its own. Carries what a reader needs *before* they ask
// for the full content: per GLOSSARY.md the Executive Summary is "shown first
// when a user opens a document, before they choose to view the full converted
// content (which may run past 200 pages)". That content comes from
// `GET .../versions/:versionId/content` instead, on expand.
//
// `chatSnippet` is included for completeness and operability — it is the
// model-facing artifact, and being able to see what chat will be grounded in
// is worth more than hiding it.
export const documentDetailSchema = documentSchema.extend({
  metadata: documentMetadataResponseSchema,
  chatSnippet: z.string().nullable(),
  executiveSummary: z.string().nullable(),
});
export type DocumentDetail = z.infer<typeof documentDetailSchema>;

// One *named* Document Version, opened on its own — what following a Citation
// reads. Deliberately a different shape from `documentDetailSchema` rather
// than the same one with a different Version in it, because the two answer
// different questions and a reader of either has to know which they have:
// `DocumentDetail` is "this Document as it stands now" and always carries its
// `latestVersion`, while this is "this Version, as it was", and per
// GLOSSARY.md a Citation "opens that exact Version ... even after newer
// Versions exist". So the Version here is `version`, not `latestVersion`, and
// every artifact beside it — metadata, Abstract, Chat Snippet, Executive
// Summary — belongs to that Version and not to the Document's current one.
// `status` likewise is this Version's own ingestion status: a superseded
// Version that reached `ready` stays `ready` while its successor converts.
//
// `isLatestVersion` and `latestVersionNumber` are the only facts here about
// any other Version, and they are what lets a UI say "you are reading v1 of
// 3" without a second request. A number rather than a Version object, so
// nothing in this payload can be mistaken for the pinned Version's own data.
//
// `markdown` is absent for the same reason it is absent from every other
// list-or-detail payload: it can run past 200 pages and has its own endpoint.
export const documentVersionDetailSchema = z.object({
  documentId: z.string().uuid(),
  notebookId: z.string().uuid(),
  filename: z.string(),
  documentCreatedAt: z.string().datetime({ offset: true }),
  version: documentVersionSchema,
  status: documentStatusSchema,
  abstract: z.string().nullable(),
  chatSnippet: z.string().nullable(),
  executiveSummary: z.string().nullable(),
  metadata: documentMetadataResponseSchema,
  isLatestVersion: z.boolean(),
  latestVersionNumber: z.number().int().positive(),
});
export type DocumentVersionDetail = z.infer<typeof documentVersionDetailSchema>;

// The Converted Markdown of one Version. Markdown, not rendered HTML: per
// NBK-1 the client renders "the full Document content ... with its original
// structure (headings, tables, etc.)", so the structure has to reach it
// intact. Null if stage 1 hasn't run yet.
export const documentContentSchema = z.object({
  versionId: z.string().uuid(),
  markdown: z.string().nullable(),
});
export type DocumentContent = z.infer<typeof documentContentSchema>;

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

// Same shape as the download params; named separately so the operations read
// independently in the generated OpenAPI document and client.
export const documentVersionContentParamsSchema = documentVersionDownloadParamsSchema;
export type DocumentVersionContentParams = z.infer<typeof documentVersionContentParamsSchema>;

export const documentVersionParamsSchema = documentVersionDownloadParamsSchema;
export type DocumentVersionParams = z.infer<typeof documentVersionParamsSchema>;
