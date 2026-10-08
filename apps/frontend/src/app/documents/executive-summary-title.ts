/**
 * A generated Executive Summary without the title the model gave it.
 *
 * The Document page heads the Executive Summary itself, and Stage 2 used to
 * leave titling to the model, which nearly always added one (NBK-89: 52 of
 * 53 local Documents) — so the page showed "Executive Summary" twice. New
 * summaries are asked not to; stored ones are not rewritten, so the title
 * is dropped here, on display. Only a title that opens the summary goes:
 * the same words later on, or another opening heading, are the summary's
 * own. Setext headings (a line underlined with `===`) are not recognised;
 * none has been seen.
 */
export function withoutExecutiveSummaryTitle(markdown: string): string {
  const lines = markdown.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1 || !isTitle(lines[first])) return markdown;
  let rest = first + 1;
  while (rest < lines.length && lines[rest].trim() === '') rest++;
  return lines.slice(rest).join('\n');
}

// Up to three spaces in: four make the line an indented code block.
const HEADING = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const BOLD_LINE = /^ {0,3}(?:\*\*(.+)\*\*|__(.+)__)\s*$/;
const TITLE_TEXT = /^executive summary\s*(?::.*)?$/i;

function isTitle(line: string): boolean {
  const text = HEADING.exec(line)?.[1] ?? BOLD_LINE.exec(line)?.slice(1).find(Boolean);
  return text !== undefined && TITLE_TEXT.test(text.replace(/^[*_]+|[*_]+$/g, '').trim());
}
