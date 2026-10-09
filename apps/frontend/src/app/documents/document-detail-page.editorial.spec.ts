import { fireEvent, screen, within } from '@testing-library/angular';
import {
  NOTEBOOK_ID,
  SUMMARIZED_DETAIL,
  VERSION_ID,
  renderPage,
} from './document-detail-page.spec-helpers';

/** The value listed under `label` in a definition list. */
function detail(container: HTMLElement, label: string): string | undefined {
  return within(container).getByText(label).nextElementSibling?.textContent?.trim();
}

/** Renders the page on `detail`, with any other generated client calls in `extra`. */
function renderDetail(detail: object, extra: object = {}) {
  return renderPage({ getDocument: vi.fn().mockResolvedValue(detail), ...extra });
}

/** The fixture Document with `executiveSummary` as its Executive Summary. */
const withSummary = (executiveSummary: string) => ({ ...SUMMARIZED_DETAIL, executiveSummary });

/**
 * Spec 08 (NBK-85): the page reads as an article — the extracted title as
 * its headline, a byline instead of a metadata form, the rest behind
 * "Details", and ✕ in a header row instead of a text back link.
 */
describe('DocumentDetailPage — editorial reading view', () => {
  it('heads the page with the extracted title, and names the file under it', async () => {
    await renderDetail(SUMMARIZED_DETAIL);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Quarterly Report 2025' }),
    ).toBeTruthy();
    expect(screen.getByTestId('document-filename').textContent).toContain('quarterly.pdf');
  });

  it('falls back to the filename as the headline, without repeating it', async () => {
    await renderDetail({
      ...SUMMARIZED_DETAIL,
      metadata: { ...SUMMARIZED_DETAIL.metadata, title: null },
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'quarterly.pdf' })).toBeTruthy();
    expect(screen.queryByTestId('document-filename')).toBeNull();
  });

  it('sums the Document up in a byline, skipping what it does not state', async () => {
    await renderDetail({
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
    await renderDetail({ ...SUMMARIZED_DETAIL, metadata: null });

    const byline = await screen.findByTestId('byline');
    expect(within(byline).getByText('v2')).toBeTruthy();
    expect(within(byline).getByText('Summarized')).toBeTruthy();
  });

  it('puts language, subject and keywords behind a closed "Details", not a form', async () => {
    await renderDetail({
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
    await renderDetail(SUMMARIZED_DETAIL);

    const header = await screen.findByTestId('document-pane-header');
    expect(await within(header).findByText('quarterly.pdf')).toBeTruthy();
    const close = within(header).getByRole('link', { name: 'Back to the Notebook' });
    expect(close.getAttribute('href')).toBe(`/notebooks/${NOTEBOOK_ID}`);
    expect(screen.queryByText(/← Back to the Notebook/)).toBeNull();
  });

  it('offers no "Details" when there are none', async () => {
    await renderDetail({
      ...SUMMARIZED_DETAIL,
      metadata: { ...SUMMARIZED_DETAIL.metadata, keywords: [] },
    });

    await screen.findByTestId('byline');
    expect(screen.queryByText('Details')).toBeNull();
  });
});

/**
 * NBK-89: the page heads the Executive Summary itself, and the generated
 * summary nearly always opens with a title of its own — 52 of 53 local
 * Documents, in the four shapes below. That title is left out; nothing else
 * in the summary, and nothing in the Converted Markdown, is.
 */
describe('DocumentDetailPage — the Executive Summary under its own heading', () => {
  const SECTION = '## Key points\n\n- Revenue grew 18% year on year.\n';

  /** The page's Executive Summary section: its own heading and what follows. */
  async function summarySection(): Promise<HTMLElement> {
    const heading = await screen.findByRole('heading', { level: 2, name: 'Executive Summary' });
    return heading.closest('section')!;
  }

  const occurrences = (element: HTMLElement, text: string) =>
    (element.textContent ?? '').split(text).length - 1;

  it.each([
    ['a level-1 heading', '# Executive Summary'],
    ['a level-2 heading', '## Executive Summary'],
    ['a bold line', '**Executive Summary**'],
    ['a heading naming the Document', '# Executive Summary: *Sandworms of Dune*'],
    ['a heading in bold', '# **Executive Summary**'],
  ])('leaves out a leading title given as %s', async (_shape, title) => {
    await renderDetail(withSummary(`${title}\n\n${SECTION}`));

    const section = await summarySection();
    await within(section).findByRole('heading', { name: 'Key points' });
    expect(occurrences(section, 'Executive Summary')).toBe(1);
    expect(section.textContent).not.toContain('Sandworms of Dune');
  });

  it('leaves out a title that is not on the first line, after blank lines', async () => {
    await renderDetail(withSummary(`\n\n# executive summary\n\n\n${SECTION}`));

    const section = await summarySection();
    await within(section).findByRole('heading', { name: 'Key points' });
    expect(occurrences(section, 'executive summary')).toBe(0);
  });

  // Four spaces in make it an indented code block, not a heading.
  it('keeps a title-like line indented as code', async () => {
    await renderDetail(withSummary(`    # Executive Summary\n\n${SECTION}`));

    const section = await summarySection();
    await within(section).findByRole('heading', { name: 'Key points' });
    expect(occurrences(section, 'Executive Summary')).toBe(2);
  });

  it('renders a summary that opens with a section of its own unchanged', async () => {
    await renderDetail(withSummary(`## Purpose\n\nWhy this report exists.\n\n${SECTION}`));

    const section = await summarySection();
    expect(await within(section).findByRole('heading', { name: 'Purpose' })).toBeTruthy();
    expect(within(section).getByRole('heading', { name: 'Key points' })).toBeTruthy();
  });

  it('keeps an "Executive Summary" heading that is not the first line, and the words in a paragraph', async () => {
    await renderDetail(
      withSummary(
        `## Purpose\n\nThis Executive Summary is short.\n\n## Executive Summary of the annex\n\nMore.\n`,
      ),
    );

    const section = await summarySection();
    expect(
      await within(section).findByRole('heading', { name: 'Executive Summary of the annex' }),
    ).toBeTruthy();
    expect(within(section).getByText('This Executive Summary is short.')).toBeTruthy();
  });

  it('renders the full Converted Markdown as it is, even when it opens with that heading', async () => {
    const getDocumentVersionContent = vi.fn().mockResolvedValue({
      versionId: VERSION_ID,
      markdown: '# Executive Summary\n\nThe report opens on its own summary.\n',
    });
    await renderDetail(withSummary(`# Executive Summary\n\n${SECTION}`), {
      getDocumentVersionContent,
    });
    await summarySection();

    fireEvent.click(screen.getByRole('button', { name: 'Read the full Document' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Executive Summary' }),
    ).toBeTruthy();
    expect(screen.getByText('The report opens on its own summary.')).toBeTruthy();
  });
});
