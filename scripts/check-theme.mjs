#!/usr/bin/env node
/**
 * Fails when a component stylesheet hard-codes what docs/frontend-theme.md
 * says comes from a token: a colour, a corner radius, or a type size — or
 * sets an `--mdc-*` token, which Material no longer reads. The rule itself is
 * in check-theme-rules.mjs.
 *
 * Why a script and not review: every review of the Copilot UI series
 * (NBK-27..NBK-62) found the same slips by hand — a `#ddd` border, a `9px`
 * chip corner, an `11px` label — and each one is a fixed pattern. The tokens
 * themselves live in apps/frontend/src/styles.scss, which is not scanned.
 *
 * Allowed without a token: `0`/`inherit`-style keywords, and font sizes
 * relative to the inherited one (`em`, `%`), which scale with the type role
 * around them. A deliberate exception carries `theme-exempt: <why>` in a
 * comment on the line itself or the line above, so the reason sits with it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { problem } from './check-theme-rules.mjs';

const root = new URL('..', import.meta.url).pathname;
const APP = join(root, 'apps/frontend/src/app');

function* filesUnder(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'api') yield* filesUnder(path);
    } else {
      yield path;
    }
  }
}

/** Every component stylesheet: `.scss` files, and inline `styles` in `.ts`. */
function* stylesheets() {
  for (const path of filesUnder(APP)) {
    if (path.endsWith('.scss')) yield { path, css: readFileSync(path, 'utf8'), offset: 0 };
    if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) {
      const source = readFileSync(path, 'utf8');
      for (const m of source.matchAll(/styles:\s*\[?\s*`([\s\S]*?)`/g)) {
        const offset = source.slice(0, m.index + m[0].indexOf('`')).split('\n').length - 1;
        yield { path, css: m[1], offset };
      }
    }
  }
}

const violations = [];
for (const { path, css, offset } of stylesheets()) {
  const lines = css.split('\n');
  lines.forEach((line, i) => {
    if (/theme-exempt:/.test(line) || /theme-exempt:/.test(lines[i - 1] ?? '')) return;
    // Every declaration on the line, so a one-line rule (`:host { color: … }`)
    // is read too. A selector such as `&:hover` parses as a harmless pair.
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    for (const [, property, value] of code.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/gi)) {
      const why = problem(property.toLowerCase(), value.trim());
      if (why) {
        violations.push({ where: `${path.replace(root, '')}:${offset + i + 1}`, line: line.trim(), why });
      }
    }
  });
}

if (violations.length === 0) {
  console.log(
    'check-theme: ok — no colour, radius or type-size literals, nor --mdc-* tokens, in component styles.',
  );
  process.exit(0);
}

console.error(`check-theme: ${violations.length} problem(s) in component styles.\n`);
for (const v of violations) console.error(`  ${v.where}\n    ${v.line}\n    is ${v.why}\n`);
console.error(
  'Tokens and type roles are listed in docs/frontend-theme.md. A deliberate exception\n' +
    'takes a `theme-exempt: <why>` comment on the line or the line above.'
);
process.exit(1);
