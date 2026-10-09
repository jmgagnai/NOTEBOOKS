import { fireEvent, screen, waitFor } from '@testing-library/angular';
import {
  SUMMARIZED_DETAIL,
  VERSION_ID,
  activatedRoute,
  renderPage,
  versionDetail,
} from './document-detail-page.spec-helpers';

/**
 * A long Document opened at a Chunk deep inside it — a 200-page book is
 * about 5,000 Markdown blocks. Rendering every block before scrolling kept
 * the reader in front of a frozen page for seconds, so the cited part
 * renders first and the rest follows a slice at a time, with a progress bar
 * until it is all there. jsdom has no layout, so these say what is rendered
 * and when; that the cited Chunk stays in place on screen is measured in a
 * real browser (docs/run-for-screenshots.md, "Measure instead of eyeballing").
 */
describe('DocumentDetailPage — a long Document', () => {
  const PARAGRAPHS = 200;
  const LONG_MARKDOWN = Array.from({ length: PARAGRAPHS }, (_, i) => `Paragraph ${i}.`).join(
    '\n\n',
  );
  const CITED = 'Paragraph 150.';
  const FROM = LONG_MARKDOWN.indexOf(CITED);

  function client() {
    return {
      getDocument: vi.fn().mockResolvedValue(SUMMARIZED_DETAIL),
      getDocumentVersion: vi
        .fn()
        .mockResolvedValue(versionDetail(VERSION_ID, { metadata: { title: 'A Long Book' } })),
      getDocumentVersionContent: vi
        .fn()
        .mockResolvedValue({ versionId: VERSION_ID, markdown: LONG_MARKDOWN }),
    };
  }

  const rendered = () => screen.queryAllByText(/^Paragraph \d+\.$/).length;
  // jsdom builds and sanitises blocks far slower than a browser, so the
  // whole Document takes longer than `waitFor`'s default second to arrive.
  // Kept to 200 paragraphs: enough for several slices either side of the
  // cited one, little enough not to slow the test files running beside it.
  const ALL_RENDERED = { timeout: 5_000 };

  /** How many paragraphs exist the moment `ready()` first holds. */
  function countWhen(ready: () => boolean): Promise<number> {
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!ready()) return;
        observer.disconnect();
        resolve(rendered());
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  it('shows the cited Chunk before the rest of the Document is rendered', async () => {
    const atCited = countWhen(() => screen.queryByTestId('cited-passage') !== null);
    await renderPage(
      client(),
      activatedRoute({ version: VERSION_ID, from: String(FROM), to: String(FROM + CITED.length) }),
    );

    expect(await atCited).toBeLessThan(PARAGRAPHS / 2);
    expect(screen.getByTestId('cited-passage').textContent?.trim()).toBe(CITED);

    await waitFor(() => expect(rendered()).toBe(PARAGRAPHS), ALL_RENDERED);
    expect(screen.getByTestId('cited-passage').textContent?.trim()).toBe(CITED);
  });

  it('says the rest is still on its way, and stops saying so once it is all there', async () => {
    const whileRendering = countWhen(
      () => screen.queryByRole('progressbar', { name: 'Rendering the full Document' }) !== null,
    );
    await renderPage(
      client(),
      activatedRoute({ version: VERSION_ID, from: String(FROM), to: String(FROM + CITED.length) }),
    );

    expect(await whileRendering).toBeLessThan(PARAGRAPHS);
    await waitFor(() => expect(rendered()).toBe(PARAGRAPHS), ALL_RENDERED);
    await waitFor(() =>
      expect(screen.queryByRole('progressbar', { name: 'Rendering the full Document' })).toBeNull(),
    );
  });

  it('renders from the start, a slice at a time, when no Chunk is cited', async () => {
    const atFirst = countWhen(() => screen.queryByText('Paragraph 0.') !== null);
    await renderPage({
      getDocument: vi.fn().mockResolvedValue(SUMMARIZED_DETAIL),
      getDocumentVersionContent: vi
        .fn()
        .mockResolvedValue({ versionId: VERSION_ID, markdown: LONG_MARKDOWN }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Read the full Document' }));

    expect(await atFirst).toBeLessThan(PARAGRAPHS / 2);
    await waitFor(() => expect(rendered()).toBe(PARAGRAPHS), ALL_RENDERED);
  });
});
