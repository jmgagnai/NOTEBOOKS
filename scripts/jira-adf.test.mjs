// Run by `pnpm run check:scripts` (part of `pnpm run check`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToMarkdown, markdownToAdf } from './jira-adf.mjs';

const blocks = (md) => markdownToAdf(md).content;
const text = (node) =>
  node.text ?? (node.content ?? []).map(text).join(node.type === 'paragraph' ? '' : '');

test('a hard-wrapped bullet stays one item (NBK-77: it split into a bullet and a paragraph)', () => {
  const [list, ...rest] = blocks(
    '- **A left sidebar** replaces the top bar: the\n  brand and the avatar.\n- Second item\n',
  );
  assert.equal(list.type, 'bulletList');
  assert.equal(list.content.length, 2);
  assert.equal(
    text(list.content[0]),
    'A left sidebar replaces the top bar: the brand and the avatar.',
  );
  assert.deepEqual(rest, []);
});

test('hard-wrapped ordered and task items stay one item each', () => {
  const [ordered, tasks] = blocks(
    '1. one\n   wrapped\n2. two\n\n- [ ] check\n  wrapped\n- [x] done\n',
  );
  assert.deepEqual(ordered.content.map(text), ['one wrapped', 'two']);
  assert.equal(tasks.type, 'taskList');
  assert.deepEqual(tasks.content.map(text), ['check wrapped', 'done']);
  assert.deepEqual(
    tasks.content.map((t) => t.attrs.state),
    ['TODO', 'DONE'],
  );
});

test('blank lines between items keep one list; a task item ends a bullet list', () => {
  const [bullets, tasks] = blocks('- a\n\n- b\n- [ ] c\n');
  assert.deepEqual(bullets.content.map(text), ['a', 'b']);
  assert.equal(tasks.type, 'taskList');
});

test('a wrapped paragraph joins its lines and stops at the next block', () => {
  const [p, list] = blocks('one\ntwo\n- item\n');
  assert.equal(text(p), 'one two');
  assert.equal(list.type, 'bulletList');
});

test('a fenced code block is verbatim, with its language', () => {
  const [code, after] = blocks('```diff\n+ **not bold**\n  indented\n```\nafter\n');
  assert.equal(code.type, 'codeBlock');
  assert.equal(code.attrs.language, 'diff');
  assert.equal(code.content[0].text, '+ **not bold**\n  indented');
  assert.equal(text(after), 'after');
});

test('a table becomes header and body rows', () => {
  const [table] = blocks('| Token | Value |\n|---|---|\n| Primary | `#0F6CBD` |\n');
  assert.equal(table.type, 'table');
  assert.deepEqual(
    table.content.map((row) => row.content.map((cell) => cell.type)),
    [
      ['tableHeader', 'tableHeader'],
      ['tableCell', 'tableCell'],
    ],
  );
  assert.equal(text(table.content[1].content[1]), '#0F6CBD');
});

test('quotes and rules', () => {
  const [quote, rule] = blocks('> **Superseded** — see\n> spec 07.\n\n---\n');
  assert.equal(quote.type, 'blockquote');
  assert.equal(text(quote.content[0]), 'Superseded — see spec 07.');
  assert.equal(rule.type, 'rule');
});

test('a table and a code block read back as Markdown', () => {
  const md = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```text\nx\n```';
  assert.equal(adfToMarkdown(markdownToAdf(md)), md);
});
