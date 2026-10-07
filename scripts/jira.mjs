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
 *   node scripts/jira.mjs get NBK-1 [--comments]
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
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const root = new URL('..', import.meta.url).pathname;

function loadEnv() {
  const env = {};
  for (const line of readFileSync(`${root}.env`, 'utf8').split('\n')) {
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
    throw new Error(`Jira ${method} ${path} → ${response.status}\n${JSON.stringify(payload, null, 2)}`);
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
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim()) && !/^-\s+\[[ xX]\]/.test(lines[i].trim())) {
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
  async get([key, ...opts]) {
    const fields = opts.includes('--comments')
      ? 'summary,description,status,labels,parent,comment,issuelinks'
      : 'summary,description,status,labels,parent,issuelinks';
    console.log(JSON.stringify(await api('GET', `/rest/api/3/issue/${key}?fields=${fields}`), null, 2));
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
      throw new Error(`${key}: no transition to "${target}". Available: ${transitions.map((t) => t.to.name).join(', ')}`);
    }
    await api('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: match.id } });
    console.log(`${key}: → ${match.to.name}`);
  },

  /**
   * `link NBK-6 blocked-by NBK-5` reads as the sentence it asserts;
   * `link NBK-15 relates-to NBK-14` ties a ticket to the spec it came from.
   */
  async link([inward, relation, outward]) {
    const relations = {
      'blocked-by': { type: 'Blocks', sentence: 'is blocked by' },
      'relates-to': { type: 'Relates', sentence: 'relates to' },
    };
    const link = relations[relation];
    if (!link) throw new Error(`unknown relation "${relation}"; use ${Object.keys(relations).join(' or ')}`);
    await api('POST', '/rest/api/3/issueLink', {
      type: { name: link.type },
      inwardIssue: { key: inward },
      outwardIssue: { key: outward },
    });
    console.log(`${inward} ${link.sentence} ${outward}`);
  },
};

const USAGE = `Usage: node scripts/jira.mjs <command>

  get NBK-1 [--comments]
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
