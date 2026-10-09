import assert from 'node:assert/strict';
import { test } from 'node:test';
import { iconNames, registeredIcons } from './check-icons-rules.mjs';

test('reads the icons a template names, static and as literals in a binding', () => {
  const template = [
    '<mat-icon svgIcon="add" />',
    '<mat-icon class="x" svgIcon="chat" aria-hidden="true" />',
    `<mat-icon [svgIcon]="collapsed() ? 'panel-left-expand' : 'panel-left-contract'" />`,
    '<mat-icon [svgIcon]="kind(document).icon" />',
    '<!-- <mat-icon svgIcon="commented-out" /> -->',
  ].join('\n');

  assert.deepEqual(iconNames(template), ['add', 'chat', 'panel-left-expand', 'panel-left-contract']);
});

test('reads the registered names from the generated icon set', () => {
  const generated = [
    'export const FLUENT_ICONS = {',
    `  'add': "<svg/>",`,
    `  'arrow-left': "<svg/>",`,
    '} as const;',
  ].join('\n');

  assert.deepEqual([...registeredIcons(generated)], ['add', 'arrow-left']);
});
