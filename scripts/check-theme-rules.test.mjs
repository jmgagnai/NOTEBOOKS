import assert from 'node:assert/strict';
import { test } from 'node:test';
import { problem } from './check-theme-rules.mjs';

test('flags a colour, a corner radius or a type size written as a literal', () => {
  assert.match(problem('color', '#ddd'), /colour literal/);
  assert.match(problem('background', 'rgba(0, 0, 0, 0.1)'), /colour literal/);
  assert.match(problem('border-radius', '9px'), /corner radius/);
  assert.match(problem('font-size', '11px'), /type size/);
});

test('lets tokens, keywords and relative type sizes through', () => {
  assert.equal(problem('color', 'var(--mat-sys-primary)'), null);
  assert.equal(problem('border-radius', '0'), null);
  assert.equal(problem('font-size', '0.9em'), null);
  assert.equal(problem('--mat-progress-bar-track-color', 'transparent'), null);
});

// Retro of 2026-10-08: Material 22 reads `--mat-*` tokens, so an `--mdc-*`
// one set in a component does nothing — the composer's answering bar kept
// its grey track for weeks behind `--mdc-linear-progress-track-color`.
test('flags an --mdc-* custom property, which Material no longer reads', () => {
  assert.match(
    problem('--mdc-linear-progress-track-color', 'transparent'),
    /--mdc-\* token.*mat\..*-overrides/,
  );
});
