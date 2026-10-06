#!/usr/bin/env node
/**
 * Guards the migration filenames that `src/db/migrate.ts` depends on.
 *
 * That runner applies `.sql` files in `.sort()` order and records each by
 * filename in `schema_migrations.name`. Two consequences shape this check:
 *
 *   - A duplicate number means two migrations whose relative order depends on
 *     the rest of the filename — the exact collision that parallel work invites,
 *     and the reason this check exists.
 *   - A filename is an applied migration's identity, so renaming one makes an
 *     already-applied migration look new and run twice. Nothing here ever asks
 *     for a rename.
 *
 * Gaps are allowed on purpose. A reserved-then-unused number (0008 is one) is
 * harmless, and closing it would mean a rename.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const MIGRATIONS_DIR = join(root, 'apps/backend/src/db/migrations');
const NAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const problems = [];
const byNumber = new Map();

for (const file of files) {
  const match = file.match(NAME);
  if (!match) {
    problems.push(
      `${file}: expected NNNN_lower_snake_case.sql (four digits, then words joined by underscores)`
    );
    continue;
  }
  const number = match[1];
  if (byNumber.has(number)) {
    problems.push(
      `${number} is used twice: ${byNumber.get(number)} and ${file}. ` +
        'Renumber the one not yet applied anywhere — never the applied one.'
    );
    continue;
  }
  byNumber.set(number, file);
}

if (problems.length > 0) {
  console.error(`check-migrations: ${problems.length} problem(s).\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nMigrations are applied in filename order and recorded by filename, so a\n' +
      'number must identify exactly one migration. See scripts/check-migrations.mjs.'
  );
  process.exit(1);
}

const numbers = [...byNumber.keys()].map(Number);
const highest = numbers.length > 0 ? Math.max(...numbers) : 0;
const gaps = [];
for (let n = 1; n < highest; n += 1) {
  if (!byNumber.has(String(n).padStart(4, '0'))) gaps.push(String(n).padStart(4, '0'));
}

console.log(
  `check-migrations: ok — ${files.length} migrations, numbers unique, next free is ` +
    `${String(highest + 1).padStart(4, '0')}${gaps.length > 0 ? ` (unused: ${gaps.join(', ')})` : ''}.`
);
