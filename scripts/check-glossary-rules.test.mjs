import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findTerm, parseAvoidTerms, testTitles, UI_CONTEXTUAL } from './check-glossary-rules.mjs';

test('reads the titles of describe, it and test, however they are quoted', () => {
  const source = [
    "describe('the Search page', () => {",
    '  it("finds a Chunk", async () => {});',
    '  test(`keeps ${"a"} template literal`, () => {});',
    "  it.each([1, 2])('runs case %s', (n) => {});",
    "  describe.each(['x'])('a %s block', () => {});",
    "  it('handles an escaped \\'quote\\'', () => {});",
    '});',
  ].join('\n');

  assert.deepEqual(testTitles(source), [
    'the Search page',
    'finds a Chunk',
    'keeps ${"a"} template literal',
    'runs case %s',
    'a %s block',
    "handles an escaped 'quote'",
  ]);
});

test('reads skipped, focused and pending tests, and tagged-template tables', () => {
  const source = [
    "it.skip('skipped one', () => {});",
    "it.only('focused one', () => {});",
    "it.todo('pending one');",
    "describe.skip('skipped block', () => {});",
    'test.each`',
    '  a | b',
    "`('tabled %s', () => {});",
    "it.each([[f(g(1))]])('nested %s', () => {});",
  ].join('\n');

  assert.deepEqual(testTitles(source), [
    'skipped one',
    'focused one',
    'pending one',
    'skipped block',
    'tabled %s',
    'nested %s',
  ]);
});

test('ignores calls that are not test titles, and commented-out tests', () => {
  const source = [
    "submit('passage'); split('it'); expect(it).toBe('x');",
    "/passage/.test('passage'); pattern.test('passage'); vi.it('passage');",
    "// it('passage', () => {});",
    "  // describe('passage', () => {});",
  ].join('\n');

  assert.deepEqual(testTitles(source), []);
});

// NBK-101: test names are held to the glossary as UI copy is — same terms,
// same exclusions.
test("flags an avoided term in a title, and leaves the UI copy's exclusions alone", () => {
  const glossary = [
    '**Chunk**:',
    'A slice.',
    '_Avoid_: passage, segment.',
    '',
    '**Document**:',
    'An upload.',
    '_Avoid_: file.',
  ].join('\n');
  const checkable = [...parseAvoidTerms(glossary).keys()].filter((t) => !UI_CONTEXTUAL.has(t));

  assert.equal(findTerm('marks the passage at the cited chunk', checkable), 'passage');
  assert.equal(findTerm('uploads a file and lists it', checkable), undefined);
  assert.equal(findTerm('walks down a passageway', ['passage']), undefined);
  // A plural is the same word (review of NBK-101: "numbers the passages").
  assert.equal(findTerm('numbers the passages it may cite', ['passage']), 'passage');
  assert.equal(findTerm('shows no sources', ['source']), 'source');
  assert.equal(findTerm('three addresses', ['address']), 'address');
});
