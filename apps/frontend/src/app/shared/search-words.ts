/**
 * The words a search matched, marked where a search result opens: inside the
 * cited Chunk of a Document, or the Exchange of a Chat Thread. The backend
 * says which words they are; they travel from the Search page in the
 * result's link (`&words=`), and are matched here as the search matches
 * them: whole words, accents and case ignored.
 */

/** A run of text, `match` when it is one of the words to mark. */
export interface MarkedRun {
  text: string;
  match: boolean;
}

/** Runs of letters and digits: what the search counts as words. */
const WORD = /[\p{L}\p{N}]+/gu;

/** A word as the search compares it: lowercased, accents removed. */
function folded(word: string): string {
  return word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** `text` split into runs, the words to mark flagged; one run when there are none. */
export function markRuns(text: string, words: readonly string[]): MarkedRun[] {
  if (words.length === 0) return [{ text, match: false }];
  const wanted = new Set(words.map(folded));
  const runs: MarkedRun[] = [];
  let at = 0;
  for (const m of text.matchAll(WORD)) {
    if (!wanted.has(folded(m[0]))) continue;
    if (m.index > at) runs.push({ text: text.slice(at, m.index), match: false });
    runs.push({ text: m[0], match: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) runs.push({ text: text.slice(at), match: false });
  return runs;
}

/**
 * Rendered HTML with the words to mark wrapped in `<mark class="search-hit">`,
 * in its text only — never inside a tag or an attribute.
 */
export function markHtml(html: string, words: readonly string[]): string {
  if (words.length === 0) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  for (const node of texts) {
    const runs = markRuns(node.data, words);
    if (!runs.some((run) => run.match)) continue;
    const fragment = document.createDocumentFragment();
    for (const run of runs) {
      if (!run.match) {
        fragment.append(run.text);
        continue;
      }
      const mark = document.createElement('mark');
      mark.className = 'search-hit';
      mark.textContent = run.text;
      fragment.append(mark);
    }
    node.replaceWith(fragment);
  }
  return template.innerHTML;
}
