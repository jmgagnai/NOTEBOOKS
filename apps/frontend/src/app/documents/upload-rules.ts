/**
 * What the browser checks before it sends a file (NBK-16): the one frontend
 * source of truth for the accepted extensions, the per-file size limit, the
 * per-batch file cap, and the wording of each skip reason. The picker's
 * `accept` attribute is derived from it; nothing else hand-maintains a copy.
 *
 * The extension list mirrors the backend's `ACCEPTED_EXTENSIONS` in
 * apps/backend/src/documents/file-types.ts, which is the real gate — this is
 * only there to tell a user before the request what the backend would
 * refuse after it.
 */
export const ACCEPTED_UPLOAD_EXTENSIONS = [
  '.txt',
  '.md',
  '.markdown',
  '.docx',
  '.xlsx',
  '.csv',
  '.pdf',
] as const;

/** The file picker's `accept` attribute. */
export const UPLOAD_ACCEPT = ACCEPTED_UPLOAD_EXTENSIONS.join(',');
