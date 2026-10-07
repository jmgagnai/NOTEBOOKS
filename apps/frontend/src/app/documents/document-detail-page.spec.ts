import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import { DocumentDetailPage } from './document-detail-page';
import { DocumentsService } from '../api/services/documents.service';

const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';
const DOCUMENT_ID = '22222222-2222-2222-2222-222222222222';
const VERSION_ID = '33333333-3333-3333-3333-333333333333';

// A Citation opens this page with the Document Version it pinned, the chunk
// it points at and that chunk's character range in the Converted Markdown —
// see `ThreadView.citationParams`.
function activatedRoute(queryParams: Record<string, string> = {}) {
  return {
    provide: ActivatedRoute,
    useValue: {
      snapshot: {
        paramMap: convertToParamMap({ notebookId: NOTEBOOK_ID, documentId: DOCUMENT_ID }),
        queryParamMap: convertToParamMap(queryParams),
      },
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
    const getDocumentVersionContent = vi
      .fn()
      .mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN });

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
    const getDocumentVersionContent = vi
      .fn()
      .mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN });

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
    const getDocumentVersionContent = vi
      .fn()
      .mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN });

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

  /**
   * Seam-3 tests for the other half of NBK-12's acceptance criteria:
   * "clicking a Citation in the Angular UI opens that exact Document Version,
   * scrolled to that chunk's location".
   *
   * The Document on this page is at v2, so a Citation to v1 is the real case:
   * GLOSSARY.md requires that following it still open "that exact Version at
   * that location, even after newer Versions exist". A page that quietly
   * loaded the latest Version instead would look right and be wrong.
   *
   * "That exact Version" is the whole payload, not just the content. The
   * Executive Summary, the extracted metadata and the version badge all have
   * to be the pinned Version's too — a page showing v1's text under v2's
   * summary and a "v2" badge presents two Versions as one document, and the
   * reader has no way to know which half of what they are reading belongs to
   * the answer they followed. So these tests assert on the whole page, and
   * the Version endpoint is the one the page is expected to call.
   */
  describe('opened from a Citation', () => {
    const OLD_VERSION_ID = '44444444-4444-4444-4444-444444444444';
    const CHUNK_ID = '55555555-5555-5555-5555-555555555555';

    // v1's own Converted Markdown. Its heading deliberately differs from the
    // metadata titles on both Versions, so an assertion about *metadata* can
    // never be satisfied by the rendered document text instead.
    const SUPERSEDED_MARKDOWN = FULL_MARKDOWN.replace(
      '# Quarterly Report 2025',
      '# Quarterly Report, as filed',
    );

    // The paragraph "Revenue grew to 12.4M." as a chunk's character range
    // would have it: a verbatim, contiguous slice. Measured against the
    // Markdown this Version actually serves, because a Citation's range is
    // fixed to one Version's content and is meaningless against another's.
    const CITED_FROM = SUPERSEDED_MARKDOWN.indexOf('Revenue grew to 12.4M.');
    const CITED_TO = CITED_FROM + 'Revenue grew to 12.4M.'.length;

    // What `GET .../documents/:id/versions/:versionId` returns for the pinned
    // v1: its own artifacts throughout, and nothing of v2 except where it
    // says v2 is now the latest.
    const PINNED_VERSION_DETAIL = {
      documentId: DOCUMENT_ID,
      notebookId: NOTEBOOK_ID,
      filename: 'quarterly.pdf',
      documentCreatedAt: '2026-01-01T00:00:00.000Z',
      version: {
        id: OLD_VERSION_ID,
        versionNumber: 1,
        mimeType: 'application/pdf',
        sizeBytes: 90,
        createdAt: '2025-12-01T00:00:00.000Z',
      },
      status: 'ready',
      abstract: 'The Abstract as v1 had it.',
      chatSnippet: 'The Chat Snippet as v1 had it.',
      executiveSummary:
        '## Key points\n\n- Revenue grew 11% year on year.\n- The supply-chain review was still open.\n',
      metadata: {
        title: 'Quarterly Report 2024',
        authors: ['B. Bookkeeper'],
        documentType: 'report',
      },
      isLatestVersion: false,
      latestVersionNumber: 2,
    };

    function citationRoute(extra: Record<string, string> = {}) {
      return activatedRoute({
        version: OLD_VERSION_ID,
        chunk: CHUNK_ID,
        from: String(CITED_FROM),
        to: String(CITED_TO),
        ...extra,
      });
    }

    /** The client as the page sees it when a Citation named a Version. */
    function citationClient() {
      return {
        getDocument: vi.fn().mockResolvedValue(SUMMARIZED_DETAIL),
        getDocumentVersion: vi.fn().mockResolvedValue(PINNED_VERSION_DETAIL),
        getDocumentVersionContent: vi
          .fn()
          .mockResolvedValue({ versionId: OLD_VERSION_ID, markdown: SUPERSEDED_MARKDOWN }),
      };
    }

    it('loads the pinned Document Version rather than the latest one', async () => {
      const client = citationClient();

      await render(DocumentDetailPage, {
        providers: [citationRoute(), { provide: DocumentsService, useValue: client }],
      });

      // Opened at the content, not behind the "Show full content" action: a
      // reader who followed a Citation asked for a Chunk, not for a summary.
      expect(await screen.findByText('Revenue grew to 12.4M.')).toBeTruthy();
      expect(client.getDocumentVersionContent).toHaveBeenCalledWith({
        notebookId: NOTEBOOK_ID,
        documentId: DOCUMENT_ID,
        // The pinned Version — SUMMARIZED_DETAIL's latest is VERSION_ID (v2).
        versionId: OLD_VERSION_ID,
      });
      expect(client.getDocumentVersionContent).not.toHaveBeenCalledWith(
        expect.objectContaining({ versionId: VERSION_ID }),
      );
    });

    it("shows the pinned Version's own summary, metadata and version number", async () => {
      const client = citationClient();

      const { container } = await render(DocumentDetailPage, {
        providers: [citationRoute(), { provide: DocumentsService, useValue: client }],
      });

      await screen.findByText('Revenue grew to 12.4M.');

      // The Version-scoped read is the one made, and the latest-Version
      // detail is not fetched at all: there is nothing on this page it could
      // correctly fill in.
      expect(client.getDocumentVersion).toHaveBeenCalledWith({
        notebookId: NOTEBOOK_ID,
        documentId: DOCUMENT_ID,
        versionId: OLD_VERSION_ID,
      });
      expect(client.getDocument).not.toHaveBeenCalled();

      // v1's Executive Summary, not v2's.
      expect(screen.getByText('Revenue grew 11% year on year.')).toBeTruthy();
      expect(screen.queryByText('Revenue grew 18% year on year.')).toBeNull();

      // v1's extracted metadata, not v2's.
      expect(screen.getByText('Quarterly Report 2024')).toBeTruthy();
      expect(screen.queryByText('Quarterly Report 2025')).toBeNull();
      expect(screen.getByText(/B\. Bookkeeper/)).toBeTruthy();

      // And v1's version badge. A page captioned "v2" over v1's content is
      // the bug this test exists for, so the assertion is on the badge line
      // itself rather than on the page text — the superseded notice below it
      // legitimately names v2 as well.
      const metaLine = container.querySelector('.document-detail-page__meta-line');
      expect(metaLine?.textContent).toContain('v1');
      expect(metaLine?.textContent).not.toContain('v2');
      // The badge shows v1's own ingestion status, not the latest Version's
      // ('summarized' on SUMMARIZED_DETAIL).
      expect(metaLine?.textContent).toContain('ready');
    });

    it('says the Version it opened is a superseded one', async () => {
      const client = citationClient();

      await render(DocumentDetailPage, {
        providers: [citationRoute(), { provide: DocumentsService, useValue: client }],
      });

      // Now that every field on the page belongs to v1, the notice is no
      // longer apologising for a contradiction — it is telling the reader
      // where in the Document's history they are standing, which a reader
      // who followed an old answer needs to know.
      expect(await screen.findByTestId('cited-version-notice')).toBeTruthy();
      const notice = screen.getByTestId('cited-version-notice').textContent ?? '';
      expect(notice).toMatch(/no longer the latest/i);
      // Naming both numbers, so "how far behind is this" is answerable
      // without leaving the page.
      expect(notice).toMatch(/\bv1\b/);
      expect(notice).toMatch(/\bv2\b/);
    });

    it('shows no superseded notice when the Citation pinned the latest Version', async () => {
      const client = citationClient();
      client.getDocumentVersion = vi.fn().mockResolvedValue({
        ...PINNED_VERSION_DETAIL,
        version: { ...PINNED_VERSION_DETAIL.version, versionNumber: 2 },
        isLatestVersion: true,
        latestVersionNumber: 2,
      });

      await render(DocumentDetailPage, {
        providers: [citationRoute(), { provide: DocumentsService, useValue: client }],
      });

      await screen.findByText('Revenue grew to 12.4M.');
      // A Citation into a Document nobody has re-uploaded is the common case,
      // and there is nothing to warn about.
      expect(screen.queryByTestId('cited-version-notice')).toBeNull();
    });

    it("marks the passage at the cited chunk's location", async () => {
      const client = citationClient();

      await render(DocumentDetailPage, {
        providers: [citationRoute(), { provide: DocumentsService, useValue: client }],
      });

      // The cited range resolves to the block of the rendered Markdown it
      // falls in — that element is what gets scrolled to, so it is the
      // observable form of "scrolled to that chunk's location".
      const cited = await screen.findByTestId('cited-passage');
      expect(cited.textContent).toContain('Revenue grew to 12.4M.');
      // And only that Chunk: the heading above it and the table below are
      // not swept into the highlight.
      expect(cited.textContent).not.toContain('Quarterly Report, as filed');
      expect(cited.textContent).not.toContain('Q1');
      // The rest of the document is still there to read around it.
      expect(screen.getByRole('heading', { name: 'Revenue' })).toBeTruthy();
    });

    it('opens the pinned Version unscrolled when the Citation has no range', async () => {
      const client = citationClient();

      await render(DocumentDetailPage, {
        providers: [
          // A Citation whose chunk text could not be located in the Converted
          // Markdown carries no `from`/`to` — the Version must still open.
          activatedRoute({ version: OLD_VERSION_ID, chunk: CHUNK_ID }),
          { provide: DocumentsService, useValue: client },
        ],
      });

      expect(await screen.findByText('Revenue grew to 12.4M.')).toBeTruthy();
      expect(screen.queryByTestId('cited-passage')).toBeNull();
    });

    it('surfaces an error when the pinned Version cannot be loaded', async () => {
      const client = citationClient();
      // What a Citation into a Notebook that has since been deleted gets.
      client.getDocumentVersion = vi
        .fn()
        .mockRejectedValue({ error: { message: 'Document Version not found.' } });

      await render(DocumentDetailPage, {
        providers: [citationRoute(), { provide: DocumentsService, useValue: client }],
      });

      expect(await screen.findByText('Document Version not found.')).toBeTruthy();
    });
  });
});
