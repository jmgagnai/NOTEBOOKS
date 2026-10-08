/**
 * Markdown ↔ Atlassian Document Format, for `scripts/jira.mjs`.
 *
 * Its own module so it can be tested without `.env` or a network: the CLI
 * loads credentials on import. Specs and tickets are written as hard-wrapped
 * Markdown (the design docs wrap at ~78 columns), so every block keeps
 * reading continuation lines until a blank line or the start of another
 * block — a wrapped bullet that became two paragraphs in Jira is the bug this
 * module was split out to fix (NBK-77 retro).
 *
 * Markdown supported: #–#### headings, paragraphs, - / * bullets, 1. ordered
 * lists, - [ ] task lists, ``` fenced code, | tables |, > quotes, --- rules,
 * and inline **bold**, `code`, [text](url). Nested lists flatten to one level.
 */
import { randomUUID } from 'node:crypto';

// --- Markdown → ADF ---------------------------------------------------------

/** Inline marks: **bold**, `code`, [text](url). */
function inline(text) {
  const nodes = [];
  const pattern = /\*\*(.+?)\*\*|`(.+?)`|\[(.+?)\]\((.+?)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) nodes.push({ type: 'text', text: text.slice(last, match.index) });
    const [, bold, code, linkText, href] = match;
    if (bold !== undefined) {
      nodes.push({ type: 'text', text: bold, marks: [{ type: 'strong' }] });
    } else if (code !== undefined) {
      nodes.push({ type: 'text', text: code, marks: [{ type: 'code' }] });
    } else {
      nodes.push({ type: 'text', text: linkText, marks: [{ type: 'link', attrs: { href } }] });
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes.length > 0 ? nodes : [{ type: 'text', text: text || ' ' }];
}

const paragraph = (text) => ({ type: 'paragraph', content: inline(text) });

const HEADING = /^(#{1,4})\s+(.*)$/;
const TASK = /^[-*]\s+\[([ xX])\]\s+/;
const BULLET = /^[-*]\s+/;
const ORDERED = /^\d+\.\s+/;
const FENCE = /^```/;
const TABLE = /^\|/;
const QUOTE = /^>\s?/;
const RULE = /^(-{3,}|\*{3,})$/;

/** A line that opens a new block, so it ends any paragraph or item before it. */
const isBlockStart = (line) =>
  [HEADING, BULLET, ORDERED, FENCE, TABLE, QUOTE, RULE].some((re) => re.test(line));

/** The cells of a `| a | b |` row. */
const cells = (line) =>
  line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

export function markdownToAdf(markdown) {
  const lines = markdown.split('\n');
  const content = [];
  let i = 0;
  const at = (n) => (lines[n] ?? '').trim();

  /** Joins the lines that continue the current block, from `i` on. */
  const continuation = (first) => {
    const buffer = [first];
    while (i < lines.length && at(i) !== '' && !isBlockStart(at(i))) {
      buffer.push(at(i));
      i += 1;
    }
    return buffer.join(' ');
  };

  /**
   * Items of one list, each with its wrapped lines. Blank lines between
   * items do not end the list; anything but another item of the same kind
   * does.
   */
  const listItems = (marker) => {
    // `- [ ]` is also a `-` line: a task item ends a bullet list.
    const sameKind = (l) => marker.test(l) && (marker !== BULLET || !TASK.test(l));
    const items = [];
    while (i < lines.length && sameKind(at(i))) {
      const line = at(i);
      i += 1;
      items.push({ line, text: continuation(line.replace(marker, '')) });
      let next = i;
      while (next < lines.length && at(next) === '') next += 1;
      if (next < lines.length && sameKind(at(next))) i = next;
    }
    return items;
  };

  while (i < lines.length) {
    const line = at(i);
    if (line === '') {
      i += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      // A document's own H1 becomes H2: Jira renders the issue summary as the title.
      content.push({
        type: 'heading',
        attrs: { level: Math.min(heading[1].length + 1, 6) },
        content: inline(heading[2]),
      });
      i += 1;
      continue;
    }

    if (FENCE.test(line)) {
      // Verbatim: no inline marks, original indentation kept.
      const language = line.replace(FENCE, '').trim();
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE.test(at(i))) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // the closing fence
      const text = body.join('\n');
      content.push({
        type: 'codeBlock',
        ...(language ? { attrs: { language } } : {}),
        content: text ? [{ type: 'text', text }] : [],
      });
      continue;
    }

    if (TABLE.test(line)) {
      const rows = [];
      while (i < lines.length && TABLE.test(at(i))) {
        rows.push(at(i));
        i += 1;
      }
      // The `|---|` line under the first row makes that row the header.
      const hasHeader = rows.length > 1 && /^\|?[\s:|-]+\|?$/.test(rows[1]);
      const body = hasHeader ? [rows[0], ...rows.slice(2)] : rows;
      content.push({
        type: 'table',
        attrs: { isNumberColumnEnabled: false, layout: 'default' },
        content: body.map((row, r) => ({
          type: 'tableRow',
          content: cells(row).map((cell) => ({
            type: hasHeader && r === 0 ? 'tableHeader' : 'tableCell',
            attrs: {},
            content: [paragraph(cell)],
          })),
        })),
      });
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE.test(at(i))) {
        quoted.push(at(i).replace(QUOTE, ''));
        i += 1;
      }
      content.push({ type: 'blockquote', content: markdownToAdf(quoted.join('\n')).content });
      continue;
    }

    if (RULE.test(line)) {
      content.push({ type: 'rule' });
      i += 1;
      continue;
    }

    // Task list before plain bullets: `- [ ]` is also a `-` line.
    if (TASK.test(line)) {
      content.push({
        type: 'taskList',
        attrs: { localId: randomUUID() },
        content: listItems(TASK).map(({ line: first, text }) => ({
          type: 'taskItem',
          attrs: { localId: randomUUID(), state: /\[[xX]\]/.test(first) ? 'DONE' : 'TODO' },
          content: inline(text),
        })),
      });
      continue;
    }

    if (ORDERED.test(line) || BULLET.test(line)) {
      const ordered = ORDERED.test(line);
      content.push({
        type: ordered ? 'orderedList' : 'bulletList',
        content: listItems(ordered ? ORDERED : BULLET).map(({ text }) => ({
          type: 'listItem',
          content: [paragraph(text)],
        })),
      });
      continue;
    }

    i += 1;
    content.push(paragraph(continuation(line)));
  }

  return { type: 'doc', version: 1, content };
}

// --- ADF → Markdown ---------------------------------------------------------

/** Inline nodes back to the same Markdown `inline()` reads. */
function inlineToMarkdown(nodes = []) {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text': {
          let text = node.text;
          for (const mark of node.marks ?? []) {
            if (mark.type === 'strong') text = `**${text}**`;
            else if (mark.type === 'em') text = `_${text}_`;
            else if (mark.type === 'code') text = `\`${text}\``;
            else if (mark.type === 'link') text = `[${text}](${mark.attrs.href})`;
          }
          return text;
        }
        case 'hardBreak':
          return '\n';
        case 'mention':
          return `@${node.attrs?.text ?? ''}`;
        case 'emoji':
          return node.attrs?.text ?? '';
        case 'inlineCard':
          return node.attrs?.url ?? '';
        default:
          return inlineToMarkdown(node.content);
      }
    })
    .join('');
}

/** Block nodes to Markdown; `indent` prefixes nested lists. */
function blocksToMarkdown(nodes = [], indent = '') {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'paragraph':
          return indent + inlineToMarkdown(node.content);
        case 'heading':
          return `${'#'.repeat(node.attrs?.level ?? 1)} ${inlineToMarkdown(node.content)}`;
        case 'bulletList':
          return node.content.map((item) => listItemToMarkdown(item, '- ', indent)).join('\n');
        case 'orderedList':
          return node.content
            .map((item, i) => listItemToMarkdown(item, `${i + 1}. `, indent))
            .join('\n');
        case 'taskList':
          return node.content
            .map(
              (item) =>
                `${indent}- [${item.attrs?.state === 'DONE' ? 'x' : ' '}] ${inlineToMarkdown(item.content)}`,
            )
            .join('\n');
        case 'codeBlock':
          return `${indent}\`\`\`${node.attrs?.language ?? ''}\n${inlineToMarkdown(node.content)}\n${indent}\`\`\``;
        case 'table':
          return tableToMarkdown(node, indent);
        case 'blockquote':
          return blocksToMarkdown(node.content, indent)
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n');
        case 'rule':
          return `${indent}---`;
        default:
          return node.content ? blocksToMarkdown(node.content, indent) : '';
      }
    })
    .filter((block) => block !== '')
    .join('\n\n');
}

function listItemToMarkdown(item, marker, indent) {
  const [first, ...rest] = item.content ?? [];
  const head = `${indent}${marker}${first ? inlineToMarkdown(first.content) : ''}`;
  if (rest.length === 0) return head;
  return `${head}\n${blocksToMarkdown(rest, `${indent}  `)}`;
}

function tableToMarkdown(table, indent) {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).map((cell) => blocksToMarkdown(cell.content).replace(/\n+/g, ' ')),
  );
  if (rows.length === 0) return '';
  const line = (row) => `${indent}| ${row.join(' | ')} |`;
  const headed = table.content[0].content?.every((cell) => cell.type === 'tableHeader');
  const out = rows.map(line);
  if (headed) out.splice(1, 0, line(rows[0].map(() => '---')));
  return out.join('\n');
}

export function adfToMarkdown(doc) {
  return doc ? blocksToMarkdown(doc.content) : '';
}
