/**
 * One header-delimited slice of a Converted Markdown document.
 *
 * `headingPath` is the chain of enclosing headings, outermost first — so a
 * section under `## Risks` inside `# Annual Report` carries
 * `["Annual Report", "Risks"]`. That path is what gives a section summary (and
 * later a Citation, per GLOSSARY.md) something to say about *where* in the
 * document it came from.
 */
export interface MarkdownSection {
  /** Enclosing headings, outermost first. Empty for text before any heading. */
  headingPath: string[];
  /** This section's own heading, or null for text before the first heading. */
  heading: string | null;
  /** Heading level 1-6, or 0 for text before the first heading. */
  level: number;
  /** The body text under this heading, excluding the heading line itself. */
  content: string;
}

const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Splits Converted Markdown on its heading structure — the
 * `MarkdownHeaderTextSplitter`-equivalent pass NBK-1 specifies, and the first
 * half of the two-pass split (headers, then `RecursiveCharacterTextSplitter`
 * within each section) that the embedding stage will finish.
 *
 * It exists because a Document can run past 200 pages, so nothing downstream
 * may assume the whole document fits in one prompt. Summarization maps over
 * these sections; chunking will subdivide them further.
 *
 * Only ATX headings (`# Heading`) are recognised, because that is what
 * Docling emits — Setext underlining (`Heading\n=======`) does not appear in
 * its Markdown output. Headings inside fenced code blocks are ignored: a
 * shell comment in a code sample is not a document section.
 *
 * A heading with no body still yields a section (with empty `content`): it
 * carries structure a summary of its children can use, and dropping it would
 * silently break the heading path of everything beneath it.
 */
export function splitMarkdownSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  // Index i holds the heading text currently open at level i+1.
  const openHeadings: (string | undefined)[] = [];
  let current: MarkdownSection = { headingPath: [], heading: null, level: 0, content: "" };
  let body: string[] = [];
  let openFence: string | null = null;

  const flush = (): void => {
    current.content = body.join("\n").trim();
    // The implicit preamble section is only real if it has text; a document
    // starting straight with `# Title` should not get an empty first section.
    if (current.level > 0 || current.content !== "") sections.push(current);
    body = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    const fence = FENCE.exec(line);
    if (fence) {
      // A fence of the same marker closes the block; a different one inside it
      // is just content.
      if (openFence === null) openFence = fence[1];
      else if (openFence === fence[1]) openFence = null;
      body.push(line);
      continue;
    }
    if (openFence !== null) {
      body.push(line);
      continue;
    }

    const heading = ATX_HEADING.exec(line);
    if (!heading) {
      body.push(line);
      continue;
    }

    flush();

    const level = heading[1].length;
    const text = heading[2].trim();
    openHeadings.length = level - 1;
    openHeadings[level - 1] = text;
    current = {
      // The path includes this heading itself, so a section can be named by
      // its path alone. `filter` drops gaps left by a document that skips a
      // level (an `###` directly under an `#`).
      headingPath: openHeadings.slice(0, level).filter((h): h is string => h !== undefined),
      heading: text,
      level,
      content: "",
    };
  }
  flush();

  return sections;
}
