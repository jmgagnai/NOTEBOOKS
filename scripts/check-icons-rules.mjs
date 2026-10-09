/**
 * The rules `check-icons.mjs` applies, apart so they can be tested
 * (`check-icons-rules.test.mjs`).
 */

/**
 * The icon names a template asks for: `svgIcon="name"`, and the string
 * literals of a `[svgIcon]="…"` binding (`cond ? 'a' : 'b'`). A name computed
 * in TypeScript (`kind(document).icon`) is not visible here; give it the
 * `FluentIconName` type and the compiler checks it instead.
 */
export function iconNames(template) {
  const html = template.replace(/<!--[\s\S]*?-->/g, ' ');
  const names = [];
  for (const m of html.matchAll(/(\[?)svgIcon\]?="([^"]*)"/g)) {
    if (m[1]) names.push(...[...m[2].matchAll(/'([^']*)'/g)].map((l) => l[1]));
    else names.push(m[2]);
  }
  return names;
}

/** The names the generated icon set registers: the keys of `FLUENT_ICONS`. */
export function registeredIcons(generated) {
  const body = generated.slice(generated.indexOf('FLUENT_ICONS = {'));
  return new Set([...body.matchAll(/^\s+'?([a-z0-9-]+)'?:/gm)].map((m) => m[1]));
}
