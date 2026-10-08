/**
 * The rule `check-theme.mjs` applies to each declaration of a component
 * stylesheet, apart so it can be tested (`check-theme-rules.test.mjs`).
 */

const KEYWORD = /^(0|inherit|initial|unset|revert|none)$/;

/** The reason a declaration breaks the theme rule, or null. */
export function problem(property, value) {
  // Material 22 reads `--mat-*` tokens; an `--mdc-*` one set in a component
  // does nothing, silently (retro of 2026-10-08: the composer's answering bar
  // kept its grey track behind `--mdc-linear-progress-track-color`).
  if (property.startsWith('--mdc-')) {
    return 'an --mdc-* token, which Material no longer reads (use the component\'s mat.<component>-overrides() mixin)';
  }
  if (/#[0-9a-f]{3,8}\b/i.test(value) || /\b(rgba?|hsla?)\(/i.test(value)) {
    return 'a colour literal (use a --mat-sys-* or --app-* colour token)';
  }
  if (value.includes('var(') || KEYWORD.test(value)) return null;
  if (/radius$/.test(property) && /\d/.test(value)) {
    return 'a literal corner radius (use a --mat-sys-corner-* or --app-corner-* token)';
  }
  if (property === 'font-size' && /\d/.test(value) && !/^[\d.]+(em|%)$/.test(value)) {
    return 'a literal type size (use a --mat-sys-* type-role token, or a relative em/% size)';
  }
  return null;
}
