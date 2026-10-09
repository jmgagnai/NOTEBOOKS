#!/usr/bin/env node
/**
 * Fails when a template names an icon the app does not register. Material
 * only logs an unknown `svgIcon` and renders nothing, so the mistake ships
 * silently: the Search page's Chat Thread rows asked for "chat" from NBK-97
 * on, showed an empty icon, and the tests only printed an error to stderr.
 * Names come from the generated set (apps/frontend/scripts/
 * generate-fluent-icons.mjs); add one there and run `icons:generate`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { iconNames, registeredIcons } from './check-icons-rules.mjs';

const root = new URL('..', import.meta.url).pathname;
const APP = join(root, 'apps/frontend/src/app');
const GENERATED = join(APP, 'shared/fluent-icons.generated.ts');

function* filesUnder(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* filesUnder(path);
    else yield path;
  }
}

/** Every component template: `.html` files, and inline `template:` strings. */
function* templates() {
  for (const path of filesUnder(APP)) {
    if (path.endsWith('.html')) yield { path, template: readFileSync(path, 'utf8') };
    if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) {
      for (const m of readFileSync(path, 'utf8').matchAll(/template:\s*`([\s\S]*?)`/g)) {
        yield { path, template: m[1] };
      }
    }
  }
}

const registered = registeredIcons(readFileSync(GENERATED, 'utf8'));
const unknown = [];
for (const { path, template } of templates()) {
  for (const name of iconNames(template)) {
    if (!registered.has(name)) unknown.push({ path: path.replace(root, ''), name });
  }
}

if (unknown.length === 0) {
  console.log(`check-icons: ok — every icon a template names is one of the ${registered.size} registered.`);
  process.exit(0);
}
console.error(`check-icons: ${unknown.length} unregistered icon(s).\n`);
for (const { path, name } of unknown) console.error(`  ${path}: svgIcon "${name}"`);
console.error(
  '\nAdd the name to apps/frontend/scripts/generate-fluent-icons.mjs, then run\n' +
    '`pnpm --filter frontend icons:generate`.',
);
process.exit(1);
