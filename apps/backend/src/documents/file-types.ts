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

/**
 * Extensions a user has a specific reason to expect, with the reason they are
 * nonetheless refused.
 *
 * NBK-1 lists the accepted formats as "text, Markdown, DOCX, Excel, CSV, and
 * PDF", unqualified — so someone with a `.xls` on disk has read the spec
 * correctly and is entitled to better than a generic list that happens not to
 * mention their file. Rejecting it is right; rejecting it silently is not.
 *
 * **Why `.xls` is not accepted.** Every upload is converted by stage 1's
 * Docling container, and the pinned image
 * (`ghcr.io/docling-project/docling-serve-cpu:v1.1.0`) has no backend that
 * can read one: its `InputFormat.XLSX` is mapped to the `xlsx` and `xlsm`
 * extensions only, it ships `openpyxl` but neither `xlrd` nor `olefile`, and
 * there is no `application/vnd.ms-excel` entry in its MIME-to-format table.
 * Checked by running a real OLE2/BIFF workbook through the container, not
 * assumed: format detection resolves it to `None`, the CLI logs "does not
 * match any allowed format", writes no output file, and exits 0.
 *
 * So accepting `.xls` would not make it work. It would store the bytes, enqueue
 * a conversion that cannot succeed, and leave the Document at `failed` after
 * exhausting its retries — trading an immediate, actionable 400 for a
 * confusing dead end several minutes later. Converting legacy `.xls` would
 * need a pre-conversion step (LibreOffice headless, or an `xlrd`-based
 * shim) that nothing in this pipeline has today; that is a feature, not a
 * validation tweak. See `docs/ingestion-docling.md`.
 */
const EXPLAINED_REJECTIONS: Record<string, string> = {
  ".xls":
    "Legacy Excel (.xls) workbooks are not supported: the Docling converter this app runs can only read " +
    "the modern .xlsx/.xlsm format, so an .xls upload could be stored but never converted. Re-save it as " +
    ".xlsx (Excel: File › Save As › Excel Workbook) and upload that.",
};

/**
 * The 400 message for a filename that cannot be accepted — the specific
 * reason where there is one, and the accepted-types list otherwise.
 */
export function describeRejectedFileType(filename: string): string {
  const explained = EXPLAINED_REJECTIONS[extensionOf(filename)];
  if (explained) {
    return `Unsupported file type for "${filename}". ${explained}`;
  }
  return `Unsupported file type for "${filename}". Accepted types: ${ACCEPTED_TYPES_DESCRIPTION}.`;
}
