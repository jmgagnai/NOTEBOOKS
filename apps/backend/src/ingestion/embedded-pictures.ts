/**
 * A picture Docling embedded in Converted Markdown (NBK-108):
 * `![Image](data:image/png;base64,…)`. The pinned Docling CLI's image export
 * mode is `embedded` by default, and it is kept so the Document page shows
 * the pictures; everything that reads the Markdown as *text* — chunking,
 * stage 2's prompts, the scanned-PDF check — reads around them, through
 * this one definition so the three cannot disagree on what a picture is.
 *
 * Docling writes each one on a single line, alt text `Image`, no title, the
 * data base64 — which has no `)` and no whitespace, so the first `)` closes
 * the picture. A hand-written data URI outside that shape is not matched,
 * and reads as text.
 */
const EMBEDDED_PICTURE = /!\[[^\]\n]*\]\(data:[^)\s]*\)/g;

/**
 * The stretches of `markdown` between its embedded pictures, in order, each
 * a verbatim slice of it — what keeps a Chunk "a verbatim, contiguous slice
 * of the Converted Markdown" (GLOSSARY.md) while no Chunk holds a picture.
 */
export function textBetweenPictures(markdown: string): string[] {
  return markdown.split(EMBEDDED_PICTURE);
}

export function withoutEmbeddedPictures(markdown: string): string {
  return markdown.replace(EMBEDDED_PICTURE, '');
}
