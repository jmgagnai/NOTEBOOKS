import { screen, within } from '@testing-library/angular';
import { NOTEBOOK_ID, SUMMARIZED_DETAIL, renderPage } from './document-detail-page.spec-helpers';

/** The value listed under `label` in a definition list. */
function detail(container: HTMLElement, label: string): string | undefined {
  return within(container).getByText(label).nextElementSibling?.textContent?.trim();
}

/**
 * Spec 08 (NBK-85): the page reads as an article — the extracted title as
 * its headline, a byline instead of a metadata form, the rest behind
 * "Details", and ✕ in a header row instead of a text back link.
 */
describe('DocumentDetailPage — editorial reading view', () => {
  function renderWith(detail: object) {
    return renderPage({ getDocument: vi.fn().mockResolvedValue(detail) });
  }

  it('heads the page with the extracted title, and names the file under it', async () => {
    await renderWith(SUMMARIZED_DETAIL);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Quarterly Report 2025' }),
    ).toBeTruthy();
    expect(screen.getByTestId('document-filename').textContent).toContain('quarterly.pdf');
  });

  it('falls back to the filename as the headline, without repeating it', async () => {
    await renderWith({
      ...SUMMARIZED_DETAIL,
      metadata: { ...SUMMARIZED_DETAIL.metadata, title: null },
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'quarterly.pdf' })).toBeTruthy();
    expect(screen.queryByTestId('document-filename')).toBeNull();
  });

  it('sums the Document up in a byline, skipping what it does not state', async () => {
    await renderWith({
      ...SUMMARIZED_DETAIL,
      metadata: {
        title: 'Quarterly Report 2025',
        authors: ['A. Analyst', 'B. Writer'],
        publishedOn: '2025-03-31',
        documentType: 'report',
      },
    });

    const byline = await screen.findByTestId('byline');
    expect(
      within(byline).getByText('A. Analyst, B. Writer · 2025-03-31 · report · v2'),
    ).toBeTruthy();
    expect(within(byline).getByText('Summarized')).toBeTruthy();
  });

  it('keeps the byline clean when the Document states nothing', async () => {
    await renderWith({ ...SUMMARIZED_DETAIL, metadata: null });

    const byline = await screen.findByTestId('byline');
    expect(within(byline).getByText('v2')).toBeTruthy();
    expect(within(byline).getByText('Summarized')).toBeTruthy();
  });

  it('puts language, subject and keywords behind a closed "Details", not a form', async () => {
    await renderWith({
      ...SUMMARIZED_DETAIL,
      metadata: {
        ...SUMMARIZED_DETAIL.metadata,
        language: 'en',
        subject: 'Finance',
        keywords: ['revenue', 'risk'],
      },
    });

    const details = (await screen.findByText('Details')).closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(detail(details, 'Language')).toBe('en');
    expect(detail(details, 'Subject')).toBe('Finance');
    expect(detail(details, 'Keywords')).toBe('revenue, risk');
    // The labelled metadata grid is gone: what it held is in the byline now.
    expect(screen.queryByText('Document Type')).toBeNull();
    expect(screen.queryByText('Authors')).toBeNull();
  });

  it('closes back to the Notebook from a header naming the file, not a text link', async () => {
    await renderWith(SUMMARIZED_DETAIL);

    const header = await screen.findByTestId('document-pane-header');
    expect(within(header).getByText('quarterly.pdf')).toBeTruthy();
    const close = within(header).getByRole('link', { name: 'Back to the Notebook' });
    expect(close.getAttribute('href')).toBe(`/notebooks/${NOTEBOOK_ID}`);
    expect(screen.queryByText(/← Back to the Notebook/)).toBeNull();
  });

  it('offers no "Details" when there are none', async () => {
    await renderWith({
      ...SUMMARIZED_DETAIL,
      metadata: { ...SUMMARIZED_DETAIL.metadata, keywords: [] },
    });

    await screen.findByTestId('byline');
    expect(screen.queryByText('Details')).toBeNull();
  });
});
