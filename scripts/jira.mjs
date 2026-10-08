#!/usr/bin/env node
/**
 * Jira CLI for this repo, so publishing a spec or resolving a ticket is one
 * command instead of a throwaway script.
 *
 * It exists for one reason: Jira's v3 API takes Atlassian Document Format, not
 * Markdown. Every skill that writes to Jira (/to-spec, /to-tickets, /implement)
 * otherwise re-implements that conversion, and a one-paragraph fallback throws
 * away the headings, lists and checkboxes a spec or ticket is made of.
 *
 * Credentials come from .env (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN,
 * JIRA_PROJECT_KEY). It is gitignored; the token is never printed.
 *
 *   node scripts/jira.mjs get NBK-1 [--comments] [--json]   # Markdown by default
 *   node scripts/jira.mjs search "status != Done" [--links] [--json]
 *   node scripts/jira.mjs comment NBK-1 body.md         # - reads stdin
 *   node scripts/jira.mjs create --summary "..." --body body.md \
 *        [--type Task] [--parent NBK-1] [--label ready-for-agent]
 *   node scripts/jira.mjs transition NBK-5 Done
 *   node scripts/jira.mjs link NBK-6 blocked-by NBK-5
 *   node scripts/jira.mjs link NBK-15 relates-to NBK-14
 *
 * Markdown supported: #/##/### headings, paragraphs, - bullets, 1. ordered
 * lists, - [ ] task lists, and inline **bold**, `code`, [text](url).
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

/**
 * `.env` is gitignored, so a worktree has none. The main checkout's copy is
 * one `git rev-parse` away: the common git dir is `<main checkout>/.git`.
 */
function envFile() {
  const local = join(root, '.env');
  if (existsSync(local)) return local;
  try {
    // Printed relative to `cwd` by older gits, absolute by newer ones.
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    return join(dirname(resolve(root, commonDir)), '.env');
  } catch {
    return local;
  }
}

function loadEnv() {
  const env = {};
  for (const line of readFileSync(envFile(), 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    env[key] = rest.join('=');
  }
  for (const required of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) {
    if (!env[required]) throw new Error(`.env is missing ${required}`);
  }
  return env;
}

const env = loadEnv();
const auth = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');

async function api(method, path, body) {
  const response = await fetch(`${env.JIRA_BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    // Never echo the request body: a create/comment carries no secret, but the
    // headers do, and a stack trace that quotes them would leak the token.
    throw new Error(
      `Jira ${method} ${path} → ${response.status}\n${JSON.stringify(payload, null, 2)}`,
    );
  }
  return payload;
}

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

export function markdownToAdf(markdown) {
  const lines = markdown.split('\n');
  const content = [];
  let i = 0;

  const listItem = (text) => ({ type: 'listItem', content: [paragraph(text)] });

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === '') {
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
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

    // Task list before plain bullets: `- [ ]` is also a `-` line.
    if (/^-\s+\[[ xX]\]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^-\s+\[[ xX]\]\s+/.test(lines[i].trim())) {
        const item = lines[i].trim();
        const done = /^-\s+\[[xX]\]/.test(item);
        items.push({
          type: 'taskItem',
          attrs: { localId: randomUUID(), state: done ? 'DONE' : 'TODO' },
          content: inline(item.replace(/^-\s+\[[ xX]\]\s+/, '')),
        });
        i += 1;
      }
      content.push({ type: 'taskList', attrs: { localId: randomUUID() }, content: items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(listItem(lines[i].trim().replace(/^\d+\.\s+/, '')));
        i += 1;
      }
      content.push({ type: 'orderedList', content: items });
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (
        i < lines.length &&
        /^[-*]\s+/.test(lines[i].trim()) &&
        !/^-\s+\[[ xX]\]/.test(lines[i].trim())
      ) {
        items.push(listItem(lines[i].trim().replace(/^[-*]\s+/, '')));
        i += 1;
      }
      content.push({ type: 'bulletList', content: items });
      continue;
    }

    // Paragraph: join wrapped lines until a blank line or the next block.
    const buffer = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,4})\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim())
    ) {
      buffer.push(lines[i].trim());
      i += 1;
    }
    content.push(paragraph(buffer.join(' ')));
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

export function adfToMarkdown(doc) {
  return doc ? blocksToMarkdown(doc.content) : '';
}

// --- Commands ---------------------------------------------------------------

function readBody(pathOrDash) {
  if (!pathOrDash) throw new Error('expected a Markdown file path, or - for stdin');
  return markdownToAdf(readFileSync(pathOrDash === '-' ? 0 : pathOrDash, 'utf8'));
}

function flags(argv) {
  const out = { labels: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key === 'label') out.labels.push(value);
    else if (key) out[key] = value;
  }
  return out;
}

const [command, ...rest] = process.argv.slice(2);

const commands = {
  /**
   * Prints the issue as Markdown — the ADF a `get` returns is several times the
   * size of the text it carries, and every "fetch the relevant ticket" step
   * pays that. `--json` keeps the raw document for anything the renderer
   * doesn't cover.
   */
  async get([key, ...opts]) {
    const withComments = opts.includes('--comments');
    const fields = `summary,description,status,labels,parent,issuetype,issuelinks${withComments ? ',comment' : ''}`;
    const issue = await api('GET', `/rest/api/3/issue/${key}?fields=${fields}`);
    if (opts.includes('--json')) {
      console.log(JSON.stringify(issue, null, 2));
      return;
    }
    const f = issue.fields;
    const links = (f.issuelinks ?? []).map((l) =>
      l.outwardIssue
        ? `${l.type.outward} ${l.outwardIssue.key}`
        : `${l.type.inward} ${l.inwardIssue.key}`,
    );
    const lines = [
      `# ${issue.key}: ${f.summary}`,
      '',
      `${f.issuetype.name} · ${f.status.name}` +
        (f.labels.length > 0 ? ` · labels: ${f.labels.join(', ')}` : '') +
        (f.parent ? ` · parent: ${f.parent.key}` : ''),
    ];
    if (links.length > 0) lines.push(`Links: ${links.join('; ')}`);
    lines.push('', adfToMarkdown(f.description));
    if (withComments) {
      const comments = f.comment?.comments ?? [];
      lines.push('', `## Comments (${comments.length})`);
      for (const c of comments) {
        lines.push(
          '',
          `### ${c.author?.displayName ?? '?'} — ${c.created}`,
          '',
          adfToMarkdown(c.body),
        );
      }
    }
    console.log(lines.join('\n'));
  },

  /**
   * One line per matching issue: key, status, labels, summary. JQL without a
   * `project` clause is scoped to this repo's project, so the everyday query
   * is just the condition. `--links` adds each issue's open blockers, which is
   * what a frontier check needs; `--json` prints the raw issues.
   */
  async search([jql, ...opts]) {
    if (!jql) throw new Error('expected a JQL condition, e.g. "status != Done"');
    const scoped = /\bproject\b/i.test(jql)
      ? jql
      : `project = ${env.JIRA_PROJECT_KEY} AND (${jql.replace(/\s+ORDER BY[\s\S]*$/i, '')})` +
        (jql.match(/\s+ORDER BY[\s\S]*$/i)?.[0] ?? ' ORDER BY key ASC');
    const issues = [];
    let nextPageToken;
    do {
      const page = await api('POST', '/rest/api/3/search/jql', {
        jql: scoped,
        fields: ['summary', 'status', 'labels', 'issuelinks'],
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      issues.push(...(page.issues ?? []));
      nextPageToken = page.nextPageToken;
    } while (nextPageToken);

    if (opts.includes('--json')) {
      console.log(JSON.stringify(issues, null, 2));
      return;
    }
    if (issues.length === 0) {
      console.log(`No issues match: ${scoped}`);
      return;
    }
    for (const { key, fields: f } of issues) {
      let line = `${key} | ${f.status.name} | ${f.labels.join(', ') || '-'} | ${f.summary}`;
      if (opts.includes('--links')) {
        // "is blocked by" sits on the inward side of a Blocks link.
        const blockers = (f.issuelinks ?? [])
          .filter((l) => l.type.name === 'Blocks' && l.inwardIssue)
          .filter((l) => l.inwardIssue.fields?.status?.name !== 'Done')
          .map((l) => l.inwardIssue.key);
        line += ` | blocked by: ${blockers.join(', ') || 'none open'}`;
      }
      console.log(line);
    }
  },

  async comment([key, body]) {
    const result = await api('POST', `/rest/api/3/issue/${key}/comment`, { body: readBody(body) });
    console.log(`${key}: commented (${result.id})`);
  },

  async create(argv) {
    const o = flags(argv);
    if (!o.summary) throw new Error('--summary is required');
    const fields = {
      project: { key: o.project ?? env.JIRA_PROJECT_KEY },
      summary: o.summary,
      issuetype: { name: o.type ?? 'Task' },
    };
    if (o.body) fields.description = readBody(o.body);
    if (o.parent) {
      // Jira only lets an Epic parent a Task (a Task can parent Subtasks). A
      // spec published as a Task therefore can't take its tickets as
      // children; link them with `relates-to` instead. Checked here so the
      // refusal comes before anything is created, not as a 400 mid-batch.
      const parent = await api('GET', `/rest/api/3/issue/${o.parent}?fields=issuetype`);
      const parentType = parent.fields.issuetype.name;
      if (parentType !== 'Epic' && (o.type ?? 'Task') !== 'Subtask') {
        throw new Error(
          `${o.parent} is a ${parentType}, and only an Epic can be the parent of a ${o.type ?? 'Task'}. ` +
            `Create without --parent, then \`link <new> relates-to ${o.parent}\`.`,
        );
      }
      fields.parent = { key: o.parent };
    }
    if (o.labels.length > 0) fields.labels = o.labels;
    const result = await api('POST', '/rest/api/3/issue', { fields });
    console.log(result.key);
  },

  async transition([key, target]) {
    const { transitions } = await api('GET', `/rest/api/3/issue/${key}/transitions`);
    const match = transitions.find((t) => t.to.name.toLowerCase() === target?.toLowerCase());
    if (!match) {
      throw new Error(
        `${key}: no transition to "${target}". Available: ${transitions.map((t) => t.to.name).join(', ')}`,
      );
    }
    await api('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: match.id } });
    console.log(`${key}: → ${match.to.name}`);
  },

  /**
   * `link NBK-6 blocked-by NBK-5` reads as the sentence it asserts;
   * `link NBK-15 relates-to NBK-14` ties a ticket to the spec it came from.
   *
   * Jira's issueLink body is the reverse of how it reads: for a "Blocks"
   * link the *inward* issue is the blocker (it "blocks") and the *outward*
   * issue is the blocked one (it "is blocked by"). Verified against the
   * API on NBK-29..33: posting inward=A, outward=B shows "A blocks B" on A
   * and "B is blocked by A" on B. So the sentence's subject (the blocked
   * ticket) goes in `outwardIssue`. "Relates" is symmetric, so the order
   * does not matter there.
   */
  async link([subject, relation, object]) {
    const relations = {
      'blocked-by': { type: 'Blocks', sentence: 'is blocked by' },
      'relates-to': { type: 'Relates', sentence: 'relates to' },
    };
    const link = relations[relation];
    if (!link)
      throw new Error(`unknown relation "${relation}"; use ${Object.keys(relations).join(' or ')}`);
    await api('POST', '/rest/api/3/issueLink', {
      type: { name: link.type },
      inwardIssue: { key: object },
      outwardIssue: { key: subject },
    });
    console.log(`${subject} ${link.sentence} ${object}`);
  },
};

const USAGE = `Usage: node scripts/jira.mjs <command>

  get NBK-1 [--comments] [--json]       (Markdown by default)
  search "status != Done" [--links] [--json]
                                        (JQL; scoped to the project unless it names one)
  comment NBK-1 body.md                 (- reads stdin)
  create --summary "..." [--body body.md] [--type Task] [--parent NBK-1] [--label ready-for-agent]
  transition NBK-5 Done
  link NBK-6 blocked-by NBK-5
  link NBK-15 relates-to NBK-14

--parent takes an Epic only (a Task can't parent a Task); tickets of a spec
published as a Task are linked to it with relates-to instead.

Markdown bodies are converted to Atlassian Document Format: #/##/### headings,
paragraphs, bullets, 1. ordered lists, - [ ] task lists, **bold**, \`code\`, links.`;

if (!commands[command]) {
  console.error(USAGE);
  process.exit(1);
}

commands[command](rest).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
