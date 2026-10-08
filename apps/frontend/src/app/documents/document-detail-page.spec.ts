import { fireEvent, screen, waitFor } from '@testing-library/angular';
import { APP_NAME } from '../shared/brand';
import {
  NOTEBOOK_ID,
  DOCUMENT_ID,
  VERSION_ID,
  SUMMARIZED_DETAIL,
  FULL_MARKDOWN,
  renderPage,
} from './document-detail-page.spec-helpers';

/**
 * Seam-3 tests (per NBK-1's testing decisions, and explicitly called for by
 * NBK-7's acceptance criteria): render the real page + SignalStore, mocking
 * only the generated ng-openapi-gen client interface (`DocumentsService`) —
 * never the store or any Angular service internals.
 *
 * What's under test is the division of labour GLOSSARY.md sets up: the
 * Executive Summary is "shown first when a user opens a document, before they
 * choose to view the full converted content (which may run past 200 pages)".
 * So the full content must not be fetched until it is asked for, and when it
 * is, it has to arrive as real structure — headings and tables — rather than
 * a wall of text.
 */
describe('DocumentDetailPage', () => {
  it('shows the Executive Summary first and does not fetch the full content', async () => {
    const getDocument = vi.fn().mockResolvedValue(SUMMARIZED_DETAIL);
    const getDocumentVersionContent = vi
      .fn()
      .mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN });

    await renderPage({ getDocument, getDocumentVersionContent });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Quarterly Report 2025' }),
    ).toBeTruthy();
    // The Executive Summary is Markdown, and is rendered as such.
    expect(await screen.findByRole('heading', { name: 'Key points' })).toBeTruthy();
    expect(screen.getByText('Revenue grew 18% year on year.')).toBeTruthy();

    // Extracted metadata (NBK-7) is on the Document, so it is shown here.
    expect(screen.getByText('Quarterly Report 2025')).toBeTruthy();
    expect(screen.getByText(/A\. Analyst/)).toBeTruthy();

    // Nothing of the full content yet, and crucially not even a request for
    // it — a 200-page payload must be opt-in.
    expect(getDocumentVersionContent).not.toHaveBeenCalled();
    expect(screen.queryByText('Revenue grew to 12.4M.')).toBeNull();
    expect(getDocument).toHaveBeenCalledWith({ notebookId: NOTEBOOK_ID, documentId: DOCUMENT_ID });
  });

  it('expands to the full Converted Markdown, rendered with its headings and tables', async () => {
    const getDocument = vi.fn().mockResolvedValue(SUMMARIZED_DETAIL);
    const getDocumentVersionContent = vi
      .fn()
      .mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN });

    const { container } = await renderPage({ getDocument, getDocumentVersionContent });

    await screen.findByRole('heading', { name: 'Key points' });
    fireEvent.click(screen.getByRole('button', { name: 'Read the full Document' }));

    expect(await screen.findByText('Revenue grew to 12.4M.')).toBeTruthy();
    expect(getDocumentVersionContent).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
    });

    // "Rendered with its original structure (headings, tables, etc.)" is the
    // acceptance criterion, so the assertion is on real elements: a document
    // of 200 pages is only readable if its structure survived.
    expect(await screen.findByRole('heading', { name: 'Revenue' })).toBeTruthy();
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table!.querySelectorAll('th')).toHaveLength(2);
    expect(table!.textContent).toContain('12.4M');
  });

  // NBK-61: the tab names the open Document, so several are distinguishable.
  it('puts the filename in the browser tab, and the default back on leaving', async () => {
    document.title = 'A stale title';
    const getDocument = vi.fn().mockResolvedValue(SUMMARIZED_DETAIL);
    const { fixture } = await renderPage({ getDocument });

    await waitFor(() => expect(document.title).toBe(`quarterly.pdf – ${APP_NAME}`));

    fixture.destroy();
    expect(document.title).toBe(APP_NAME);
  });

  it('collapses back to the Executive Summary without re-fetching the content', async () => {
    const getDocument = vi.fn().mockResolvedValue(SUMMARIZED_DETAIL);
    const getDocumentVersionContent = vi
      .fn()
      .mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN });

    await renderPage({ getDocument, getDocumentVersionContent });

    await screen.findByRole('heading', { name: 'Key points' });
    fireEvent.click(screen.getByRole('button', { name: 'Read the full Document' }));
    await screen.findByText('Revenue grew to 12.4M.');

    fireEvent.click(screen.getByRole('button', { name: 'Hide the full Document' }));
    expect(screen.queryByText('Revenue grew to 12.4M.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Read the full Document' }));
    expect(await screen.findByText('Revenue grew to 12.4M.')).toBeTruthy();
    // Already loaded once; re-expanding must not re-download 200 pages.
    expect(getDocumentVersionContent).toHaveBeenCalledTimes(1);
  });

  it('explains that the summaries are not ready while ingestion is still running', async () => {
    const getDocument = vi.fn().mockResolvedValue({
      ...SUMMARIZED_DETAIL,
      status: 'converting',
      abstract: null,
      chatSnippet: null,
      executiveSummary: null,
      metadata: null,
    });

    await renderPage({ getDocument });

    expect(await screen.findByRole('heading', { level: 1, name: 'quarterly.pdf' })).toBeTruthy();
    expect(
      screen.getByText('The Executive Summary is still being generated for this Document.'),
    ).toBeTruthy();
  });

  it('surfaces an error when the Document cannot be loaded', async () => {
    const getDocument = vi.fn().mockRejectedValue({ error: { message: 'Document not found.' } });

    await renderPage({ getDocument });

    expect(await screen.findByText('Document not found.')).toBeTruthy();
  });

  // NBK-68: a failed Document says why, in the same sentence the Documents
  // panel's warning uses — written out here rather than read from
  // FAILURE_SENTENCES so a change to the wording is a deliberate test change.
  it('says why a failed Document failed, beside its status', async () => {
    const getDocument = vi.fn().mockResolvedValue({
      ...SUMMARIZED_DETAIL,
      status: 'failed',
      executiveSummary: null,
      failure: { reason: 'no-text-layer', failedAt: 'converting' },
    });

    await renderPage({ getDocument });

    expect(
      await screen.findByText(
        'This PDF has no selectable text (it looks like a scan). Upload a PDF whose text can be selected.',
      ),
    ).toBeTruthy();
  });

  it('shows no failure reason for a Document that has not failed', async () => {
    const getDocument = vi
      .fn()
      .mockResolvedValue({ ...SUMMARIZED_DETAIL, status: 'ready', failure: null });

    await renderPage({ getDocument });

    await screen.findByTestId('byline');
    expect(screen.queryByTestId('failure-reason')).toBeNull();
    expect(screen.queryByText(/Upload a PDF whose text can be selected/)).toBeNull();
  });
});
