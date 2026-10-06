import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import { DocumentDetailPage } from './document-detail-page';
import { DocumentsService } from '../api/services/documents.service';

const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';
const DOCUMENT_ID = '22222222-2222-2222-2222-222222222222';
const VERSION_ID = '33333333-3333-3333-3333-333333333333';

function activatedRoute() {
  return {
    provide: ActivatedRoute,
    useValue: {
      snapshot: { paramMap: convertToParamMap({ notebookId: NOTEBOOK_ID, documentId: DOCUMENT_ID }) },
    },
  };
}

const SUMMARIZED_DETAIL = {
  id: DOCUMENT_ID,
  notebookId: NOTEBOOK_ID,
  filename: 'quarterly.pdf',
  status: 'summarized',
  abstract: 'A short Abstract for lists.',
  chatSnippet: 'A dense Chat Snippet for the model.',
  executiveSummary:
    '## Key points\n\n- Revenue grew 18% year on year.\n- Supply-chain risk remains the main exposure.\n',
  metadata: { title: 'Quarterly Report 2025', authors: ['A. Analyst'], documentType: 'report' },
  createdAt: '2026-01-01T00:00:00.000Z',
  latestVersion: {
    id: VERSION_ID,
    versionNumber: 2,
    mimeType: 'application/pdf',
    sizeBytes: 100,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
};

const FULL_MARKDOWN = [
  '# Quarterly Report 2025',
  '',
  '## Revenue',
  '',
  'Revenue grew to 12.4M.',
  '',
  '| Quarter | Total |',
  '| --- | --- |',
  '| Q1 | 12.4M |',
  '',
].join('\n');

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
    const getDocumentVersionContent = vi.fn().mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN });

    await render(DocumentDetailPage, {
      providers: [
        activatedRoute(),
        { provide: DocumentsService, useValue: { getDocument, getDocumentVersionContent } },
      ],
    });

    expect(await screen.findByText('quarterly.pdf')).toBeTruthy();
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
    const getDocumentVersionContent = vi.fn().mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN });

    const { container } = await render(DocumentDetailPage, {
      providers: [
        activatedRoute(),
        { provide: DocumentsService, useValue: { getDocument, getDocumentVersionContent } },
      ],
    });

    await screen.findByRole('heading', { name: 'Key points' });
    fireEvent.click(screen.getByRole('button', { name: 'Show full content' }));

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

  it('collapses back to the Executive Summary without re-fetching the content', async () => {
    const getDocument = vi.fn().mockResolvedValue(SUMMARIZED_DETAIL);
    const getDocumentVersionContent = vi.fn().mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN });

    await render(DocumentDetailPage, {
      providers: [
        activatedRoute(),
        { provide: DocumentsService, useValue: { getDocument, getDocumentVersionContent } },
      ],
    });

    await screen.findByRole('heading', { name: 'Key points' });
    fireEvent.click(screen.getByRole('button', { name: 'Show full content' }));
    await screen.findByText('Revenue grew to 12.4M.');

    fireEvent.click(screen.getByRole('button', { name: 'Hide full content' }));
    expect(screen.queryByText('Revenue grew to 12.4M.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show full content' }));
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

    await render(DocumentDetailPage, {
      providers: [activatedRoute(), { provide: DocumentsService, useValue: { getDocument } }],
    });

    expect(await screen.findByText('quarterly.pdf')).toBeTruthy();
    expect(
      screen.getByText('The Executive Summary is still being generated for this Document.'),
    ).toBeTruthy();
  });

  it('surfaces an error when the Document cannot be loaded', async () => {
    const getDocument = vi.fn().mockRejectedValue({ error: { message: 'Document not found.' } });

    await render(DocumentDetailPage, {
      providers: [activatedRoute(), { provide: DocumentsService, useValue: { getDocument } }],
    });

    expect(await screen.findByText('Document not found.')).toBeTruthy();
  });
});
