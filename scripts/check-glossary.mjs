#!/usr/bin/env node
/**
 * Fails when a term GLOSSARY.md tells us to avoid appears in text a user or
 * an API consumer reads: the published OpenAPI contract's human-readable text,
 * and the frontend's UI copy (template text and the labels assistive
 * technology reads out).
 *
 * The contract because it is published: it flows into apps/frontend/src/app/api/,
 * so a wrong word there reaches every consumer of the generated client. UI copy
 * because CODING_STANDARDS.md holds it to the same glossary, and every review of
 * the Copilot UI series (NBK-27..NBK-62) caught the same slips by hand — "Source
 * N" for a Citation, "conversation" for a Chat Thread. Prompt text is covered by
 * assertions in the chat tests, and source comments are left to review.
 *
 * GLOSSARY.md stays the single source of truth: the avoid lists are parsed from
 * it, never restated here. CONTEXTUAL below subtracts the terms that cannot be
 * checked mechanically, each with its reason.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const GLOSSARY = join(root, 'GLOSSARY.md');
const OPENAPI = join(root, 'apps/backend/openapi.json');
const FRONTEND_APP = join(root, 'apps/frontend/src/app');

/**
 * Avoid-terms that are real guidance for a human but produce false positives
 * for a machine. Excluded deliberately — keep a reason with each, and prefer
 * deleting an entry here over weakening the check.
 */
const CONTEXTUAL = new Map([
  ['file', 'GLOSSARY itself reserves "file" for the raw upload'],
  ['source', '"source file", and chat prompts legitimately say "sources"'],
  ['reference', 'ordinary English, and $ref-adjacent wording'],
  ['session', 'an auth session is a separate, legitimate concept here'],
  ['content', 'Content-Type, and request/response body fields'],
  ['message', 'chat_messages is a domain table; also error messages'],
  ['update', 'ordinary verb: "update a Notebook"'],
  ['import', 'a TypeScript keyword'],
  ['project', 'pnpm workspace project, Jira project'],
  ['workspace', 'pnpm workspace'],
  ['span', 'HTML <span>, and character spans'],
  ['segment', 'the frontend renders answer segments'],
  ['revision', "quoted inside GLOSSARY's own definition of Document Version"],
  ['notification', 'GLOSSARY reserves it for something addressed to a user'],
  ['processing', 'ordinary English in operational text'],
  ['indexing', "GLOSSARY assigns it to the embedding Stage's status"],
]);

/**
 * The contract's exclusions are mostly about API vocabulary (Content-Type,
 * $ref, table names). UI copy is read by users, so it is held to more of the
 * glossary: only these avoid-terms are excluded there, each with its reason.
 * "source", "conversation", "reference", "workspace" and the rest stay checked.
 */
const UI_CONTEXTUAL = new Map([
  ['file', 'GLOSSARY itself reserves "file" for the raw upload, which the upload copy names'],
  ['content', 'GLOSSARY\'s Executive Summary entry says "the full converted content"'],
  ['message', 'a chat message is a domain thing; the avoid entry is about App Events'],
  ['session', 'signing in starts an auth session'],
  ['update', 'ordinary verb in copy'],
]);

function parseAvoidTerms(markdown) {
  const terms = new Map(); // term -> the glossary entry that forbids it
  const lines = markdown.split('\n');
  let currentTerm = null;
  for (const line of lines) {
    const heading = line.match(/^\*\*(.+?)\*\*:/);
    if (heading) {
      currentTerm = heading[1];
      continue;
    }
    if (!line.startsWith('_Avoid_:') || !currentTerm) continue;
    // Strip parenthetical qualifications and any trailing prose sentence.
    const body = line.slice('_Avoid_:'.length).replace(/\([^)]*\)/g, '').split('.')[0];
    for (const raw of body.split(',')) {
      const term = raw.trim().replace(/^"|"$/g, '').toLowerCase();
      if (term) terms.set(term, currentTerm);
    }
  }
  return terms;
}

/** Every human-readable string in the OpenAPI document, with its JSON path. */
function* proseFields(node, path = '$') {
  if (Array.isArray(node)) {
    for (const [i, value] of node.entries()) yield* proseFields(value, `${path}[${i}]`);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    const here = `${path}.${key}`;
    if (typeof value === 'string' && ['summary', 'description', 'title'].includes(key)) {
      yield { path: here, text: value };
    } else {
      yield* proseFields(value, here);
    }
  }
}

/** Whole words only, so "snapshot" doesn't fire inside "snapshotted". */
function findTerm(text, terms) {
  return terms.find((term) =>
    new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text),
  );
}

function* filesUnder(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    // The generated client is checked through the contract it comes from.
    if (statSync(path).isDirectory()) {
      if (name !== 'api') yield* filesUnder(path);
    } else {
      yield path;
    }
  }
}

/**
 * The words a user can see or hear in one template: text between tags, the
 * label-like attributes (static or bound), and the string literals inside
 * interpolations and bindings — `'Source ' + n` is copy even though it sits in
 * an expression. Angular control flow (`@for (x of xs)`) and comments are not.
 */
function uiCopy(template) {
  const html = template.replace(/<!--[\s\S]*?-->/g, ' ');
  const literals = (expression) => [...expression.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const copy = [];
  const LABELS = 'aria-label|title|placeholder|matTooltip|alt|label';
  for (const m of html.matchAll(new RegExp(`\\s(${LABELS})="([^"]*)"`, 'g'))) copy.push(m[2]);
  for (const m of html.matchAll(new RegExp(`\\[(?:attr\\.)?(${LABELS})\\]="([^"]*)"`, 'g'))) {
    copy.push(...literals(m[2]));
  }
  for (const m of html.matchAll(/>([^<>]+)</g)) {
    const text = m[1];
    for (const expr of text.matchAll(/\{\{[\s\S]*?\}\}/g)) copy.push(...literals(expr[0]));
    copy.push(
      text
        .replace(/\{\{[\s\S]*?\}\}/g, ' ')
        .replace(/@(for|if|else if|switch|case|defer|placeholder|loading|let)\b[^{]*\{/g, ' ')
        .replace(/@else\s*\{/g, ' ')
        .replace(/[{}]/g, ' '),
    );
  }
  return copy.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Every component template: `.html` files, and inline `template:` strings. */
function* templates() {
  for (const path of filesUnder(FRONTEND_APP)) {
    if (path.endsWith('.html')) yield { path, template: readFileSync(path, 'utf8') };
    if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) {
      for (const m of readFileSync(path, 'utf8').matchAll(/template:\s*`([\s\S]*?)`/g)) {
        yield { path, template: m[1] };
      }
    }
  }
}

if (!existsSync(OPENAPI)) {
  console.error(
    `check-glossary: ${OPENAPI} is missing.\n` +
      'Run `pnpm run backend:openapi:generate` first (the `check` script does).'
  );
  process.exit(1);
}

const avoidTerms = parseAvoidTerms(readFileSync(GLOSSARY, 'utf8'));
const checkable = [...avoidTerms.keys()].filter((t) => !CONTEXTUAL.has(t));
const uiCheckable = [...avoidTerms.keys()].filter((t) => !UI_CONTEXTUAL.has(t));
const openapi = JSON.parse(readFileSync(OPENAPI, 'utf8'));

const violations = [];
for (const { path, text } of proseFields(openapi)) {
  const term = findTerm(text, checkable);
  if (term) violations.push({ where: path, term, text, fix: 'contract' });
}
for (const { path, template } of templates()) {
  for (const text of uiCopy(template)) {
    const term = findTerm(text, uiCheckable);
    if (term) violations.push({ where: path.replace(root, ''), term, text, fix: 'ui' });
  }
}

if (violations.length === 0) {
  console.log(
    `check-glossary: ok — ${checkable.length} terms checked across the OpenAPI contract ` +
      `(${CONTEXTUAL.size} excluded as contextual), ${uiCheckable.length} across the UI copy ` +
      `(${UI_CONTEXTUAL.size} excluded).`
  );
  process.exit(0);
}

console.error(`check-glossary: ${violations.length} glossary violation(s).\n`);
for (const v of violations) {
  console.error(`  ${v.where}`);
  console.error(`    uses "${v.term}", which GLOSSARY.md tells us to avoid for ${avoidTerms.get(v.term)}`);
  console.error(`    text: ${JSON.stringify(v.text)}\n`);
}
if (violations.some((v) => v.fix === 'contract')) {
  console.error(
    'Contract: fix the wording in the backend route/schema that produces it, then re-run\n' +
      '`pnpm run openapi:generate`. Never hand-edit the generated client.'
  );
}
if (violations.some((v) => v.fix === 'ui')) {
  console.error('UI copy: reword the template text or label using the GLOSSARY.md term.');
}
process.exit(1);
