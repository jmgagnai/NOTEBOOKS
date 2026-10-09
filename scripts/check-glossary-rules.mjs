/**
 * The rules `check-glossary.mjs` applies — which GLOSSARY.md terms to avoid,
 * where they are excluded, how a term is found in a text, and which test
 * titles are read — apart so they can be tested
 * (`check-glossary-rules.test.mjs`).
 */

/**
 * Avoid-terms that are real guidance for a human but produce false positives
 * for a machine. Excluded deliberately — keep a reason with each, and prefer
 * deleting an entry here over weakening the check.
 */
export const CONTEXTUAL = new Map([
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
export const UI_CONTEXTUAL = new Map([
  ['file', 'GLOSSARY itself reserves "file" for the raw upload, which the upload copy names'],
  ['content', 'GLOSSARY\'s Executive Summary entry says "the full converted content"'],
  ['message', 'a chat message is a domain thing; the avoid entry is about App Events'],
  ['session', 'signing in starts an auth session'],
  ['update', 'ordinary verb in copy'],
]);

/** The _Avoid_ terms of GLOSSARY.md, each mapped to the entry that forbids it. */
export function parseAvoidTerms(markdown) {
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

/** Whole words only, so "snapshot" doesn't fire inside "snapshotted". */
export function findTerm(text, terms) {
  return terms.find((term) =>
    new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text),
  );
}

// A test title: the first argument of `describe`, `it` or `test`, also in
// their `.each(table)(title, …)` form, quoted any of the three ways. The
// `\b` keeps `split('it')` and `submit('…')` out.
const TITLE =
  /\b(?:describe|it|test)(?:\.each\((?:[^()]|\([^()]*\))*\))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * The titles of the tests in one spec or test file (NBK-101): what a reader
 * of a test run sees, held to the glossary as UI copy is. A template
 * literal's `${…}` is kept as written; escaped characters are unescaped.
 */
export function testTitles(source) {
  return [...source.matchAll(TITLE)].map((m) => m[2].replace(/\\(.)/g, '$1'));
}
