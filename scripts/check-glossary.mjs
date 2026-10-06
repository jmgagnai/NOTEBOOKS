#!/usr/bin/env node
/**
 * Fails when a term GLOSSARY.md tells us to avoid appears in the published
 * OpenAPI contract's human-readable text.
 *
 * Why only the OpenAPI document: that text is published. It flows into
 * apps/frontend/src/app/api/, so a wrong word there reaches every consumer of
 * the generated client and is the hardest place to walk back. Prompt text is
 * covered by assertions in the chat tests instead, and ordinary source comments
 * are left to review.
 *
 * GLOSSARY.md stays the single source of truth: the avoid lists are parsed from
 * it, never restated here. CONTEXTUAL below subtracts the terms that cannot be
 * checked mechanically, each with its reason.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const GLOSSARY = join(root, 'GLOSSARY.md');
const OPENAPI = join(root, 'apps/backend/openapi.json');

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

if (!existsSync(OPENAPI)) {
  console.error(
    `check-glossary: ${OPENAPI} is missing.\n` +
      'Run `pnpm run backend:openapi:generate` first (the `check` script does).'
  );
  process.exit(1);
}

const avoidTerms = parseAvoidTerms(readFileSync(GLOSSARY, 'utf8'));
const checkable = [...avoidTerms.keys()].filter((t) => !CONTEXTUAL.has(t));
const openapi = JSON.parse(readFileSync(OPENAPI, 'utf8'));

const violations = [];
for (const { path, text } of proseFields(openapi)) {
  for (const term of checkable) {
    // Whole words only, so "snapshot" doesn't fire inside "snapshotted".
    const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const match = text.match(pattern);
    if (match) violations.push({ path, term, forbiddenBy: avoidTerms.get(term), text });
  }
}

if (violations.length === 0) {
  console.log(
    `check-glossary: ok — ${checkable.length} terms checked across the OpenAPI contract ` +
      `(${CONTEXTUAL.size} excluded as contextual).`
  );
  process.exit(0);
}

console.error(
  `check-glossary: ${violations.length} glossary violation(s) in the published OpenAPI contract.\n`
);
for (const v of violations) {
  console.error(`  ${v.path}`);
  console.error(`    uses "${v.term}", which GLOSSARY.md tells us to avoid for ${v.forbiddenBy}`);
  console.error(`    text: ${JSON.stringify(v.text)}\n`);
}
console.error(
  'Fix the wording in the backend route/schema that produces it, then re-run\n' +
    '`pnpm run openapi:generate`. Never hand-edit the generated client.'
);
process.exit(1);
