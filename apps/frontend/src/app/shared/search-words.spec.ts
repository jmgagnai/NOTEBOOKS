import { markHtml, markRuns } from './search-words';

// The marking rules on their own: the page specs cover where the marks go,
// these what counts as a match and that the HTML around a match survives.
describe('search words', () => {
  it('marks whole words, ignoring accents and case', () => {
    expect(markRuns('Étretat, etretat; ETRETATS and Étretat.', ['etretat'])).toEqual([
      { text: 'Étretat', match: true },
      { text: ', ', match: false },
      { text: 'etretat', match: true },
      { text: '; ETRETATS and ', match: false },
      { text: 'Étretat', match: true },
      { text: '.', match: false },
    ]);
  });

  it('leaves text whole when there are no words to mark', () => {
    expect(markRuns('Lupin', [])).toEqual([{ text: 'Lupin', match: false }]);
  });

  it('marks text only, never a tag, an attribute or an entity', () => {
    const html =
      '<p title="Lupin">Arsène <strong>Lupin</strong> &amp; <a href="/lupin">lupin</a></p>';

    expect(markHtml(html, ['lupin'])).toBe(
      '<p title="Lupin">Arsène <strong><mark class="search-hit">Lupin</mark></strong> &amp; ' +
        '<a href="/lupin"><mark class="search-hit">lupin</mark></a></p>',
    );
  });

  it('marks nothing in a word split across tags', () => {
    expect(markHtml('<p>Lu<em>pin</em></p>', ['lupin'])).toBe('<p>Lu<em>pin</em></p>');
  });
});
