/**
 * A generated Executive Summary without the title the model gave it.
 *
 * The Document page heads the Executive Summary itself, and Stage 2 used to
 * leave titling to the model, which nearly always added one (NBK-89: 52 of
 * 53 local Documents) — so the page showed "Executive Summary" twice. New
 * summaries are asked not to; stored ones are not rewritten, so this drops
 * that title on display: the first non-blank line, when it is a Markdown
 * heading of any level or a wholly bold line reading "Executive Summary"
 * (any case), optionally with a colon and more after it, plus the blank
 * lines that follow it. Anything else — another opening heading, a later
 * "Executive Summary" heading, the words in a paragraph — is left alone.
 */
export function withoutExecutiveSummaryTitle(markdown: string): string {
  const lines = markdown.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1 || !isTitle(lines[first].trim())) return markdown;
  let rest = first + 1;
  while (rest < lines.length && lines[rest].trim() === '') rest++;
  return lines.slice(rest).join('\n');
}

const HEADING = /^#{1,6}\s+(.*?)(?:\s+#+)?$/;
const BOLD_LINE = /^(?:\*\*(.+)\*\*|__(.+)__)$/;
const TITLE_TEXT = /^executive summary\s*(?::.*)?$/i;

function isTitle(line: string): boolean {
  const text = HEADING.exec(line)?.[1] ?? BOLD_LINE.exec(line)?.slice(1).find(Boolean);
  return text !== undefined && TITLE_TEXT.test(text.replace(/[*_]+$/, '').trim());
}
