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

/** Human-readable list of accepted types, matching the backend's 400 wording. */
const ACCEPTED_TYPES_DESCRIPTION = 'text, Markdown, DOCX, Excel (.xlsx), CSV, and PDF';

/**
 * The per-file limit. Must agree with the backend's multipart limit
 * (NBK-15), which is what actually refuses a larger file with 413; this
 * check only spares the user the wait.
 */
export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Extensions a user has a specific reason to expect, with the reason they are
 * nonetheless refused — the same explanation the backend gives for `.xls`
 * (see apps/backend/src/documents/file-types.ts for why the converter cannot
 * read legacy Excel).
 */
const EXPLAINED_REJECTIONS: Record<string, string> = {
  '.xls':
    'Legacy Excel (.xls) workbooks are not supported: the Docling converter this app runs can only read ' +
    'the modern .xlsx/.xlsm format, so an .xls upload could be stored but never converted. Re-save it as ' +
    '.xlsx (Excel: File › Save As › Excel Workbook) and upload that.',
};

function extensionOf(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  return dotIndex === -1 ? '' : filename.slice(dotIndex).toLowerCase();
}

/**
 * Why `file` cannot be sent, or null if it can. `earlierNames` are the names
 * already taken by files before it in the same selection — a repeat is
 * skipped so a sibling file never silently becomes a Version of the first.
 * Checked in this order: type, size, duplicate.
 */
export function uploadSkipReason(file: File, earlierNames: ReadonlySet<string>): string | null {
  const extension = extensionOf(file.name);
  if (!(ACCEPTED_UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) {
    const explained = EXPLAINED_REJECTIONS[extension];
    return explained
      ? `Unsupported file type. ${explained}`
      : `Unsupported file type. Accepted types: ${ACCEPTED_TYPES_DESCRIPTION}.`;
  }
  if (file.size > MAX_UPLOAD_FILE_BYTES) {
    return `Too large: files over ${MAX_UPLOAD_FILE_BYTES / (1024 * 1024)} MiB cannot be uploaded.`;
  }
  if (earlierNames.has(file.name)) {
    return 'Duplicate of an earlier file in this upload; only the first is sent.';
  }
  return null;
}
