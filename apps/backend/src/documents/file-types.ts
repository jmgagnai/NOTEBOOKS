/**
 * Upload accepts text, Markdown, DOCX, Excel (.xlsx), CSV, and PDF (NBK-5),
 * keyed by file extension rather than the client-supplied MIME type — browsers
 * and HTTP clients are inconsistent about what Content-Type they attach to a
 * given file, but the extension is unambiguous. The mapped value is the
 * canonical MIME type recorded against the stored Document Version.
 */
const ACCEPTED_EXTENSIONS: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
};

function extensionOf(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex === -1 ? "" : filename.slice(dotIndex).toLowerCase();
}

/**
 * Returns the canonical MIME type for an accepted filename, or `null` if its
 * extension isn't one of the accepted document types.
 */
export function resolveAcceptedMimeType(filename: string): string | null {
  return ACCEPTED_EXTENSIONS[extensionOf(filename)] ?? null;
}

/** Human-readable list of accepted types, for the 400 error message. */
export const ACCEPTED_TYPES_DESCRIPTION = "text, Markdown, DOCX, Excel (.xlsx), CSV, and PDF";
