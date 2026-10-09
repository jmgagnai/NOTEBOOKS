import { screen } from '@testing-library/angular';
import {
  NOTEBOOK_ID,
  DOCUMENT_ID,
  VERSION_ID,
  SUMMARIZED_DETAIL,
  FULL_MARKDOWN,
  activatedRoute,
  renderPage,
  supersededVersionDetail,
} from './document-detail-page.spec-helpers';

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
describe('DocumentDetailPage — opened from a Citation', () => {
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
  const PINNED_VERSION_DETAIL = supersededVersionDetail(OLD_VERSION_ID, {
    abstract: 'The Abstract as v1 had it.',
    chatSnippet: 'The Chat Snippet as v1 had it.',
    executiveSummary:
      '## Key points\n\n- Revenue grew 11% year on year.\n- The supply-chain review was still open.\n',
    metadata: {
      title: 'Quarterly Report 2024',
      authors: ['B. Bookkeeper'],
      documentType: 'report',
    },
  });

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

    await renderPage(client, citationRoute());

    // Opened at the content, not behind the "Read the full Document" action: a
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

    await renderPage(client, citationRoute());

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
    const byline = screen.getByTestId('byline');
    expect(byline.textContent).toContain('v1');
    expect(byline.textContent).not.toContain('v2');
    // The badge shows v1's own ingestion status, not the latest Version's
    // ('summarized' on SUMMARIZED_DETAIL), in the badge's sentence case (NBK-32).
    expect(byline.textContent).toContain('Ready');
  });

  it('says the Version it opened is a superseded one', async () => {
    const client = citationClient();

    await renderPage(client, citationRoute());

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

    await renderPage(client, citationRoute());

    await screen.findByText('Revenue grew to 12.4M.');
    // A Citation into a Document nobody has re-uploaded is the common case,
    // and there is nothing to warn about.
    expect(screen.queryByTestId('cited-version-notice')).toBeNull();
  });

  it('marks the cited Chunk at its location', async () => {
    const client = citationClient();

    await renderPage(client, citationRoute());

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

    await renderPage(
      client,
      // A Citation whose chunk text could not be located in the Converted
      // Markdown carries no `from`/`to` — the Version must still open.
      activatedRoute({ version: OLD_VERSION_ID, chunk: CHUNK_ID }),
    );

    expect(await screen.findByText('Revenue grew to 12.4M.')).toBeTruthy();
    expect(screen.queryByTestId('cited-passage')).toBeNull();
  });

  it('surfaces an error when the pinned Version cannot be loaded', async () => {
    const client = citationClient();
    // What a Citation into a Notebook that has since been deleted gets.
    client.getDocumentVersion = vi
      .fn()
      .mockRejectedValue({ error: { message: 'Document Version not found.' } });

    await renderPage(client, citationRoute());

    expect(await screen.findByText('Document Version not found.')).toBeTruthy();
  });

  // A search result also says which words were searched for: they are
  // marked inside the cited Chunk — whole words, accents and case ignored —
  // and nowhere else.
  it('marks the words searched for inside the cited Chunk, and only there', async () => {
    await renderPage(citationClient(), citationRoute({ words: 'REVENUE grèw' }));

    const cited = await screen.findByTestId('cited-passage');
    const marks = [...cited.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['Revenue', 'grew']);
    // "## Revenue" sits outside the cited Chunk.
    expect(document.querySelectorAll('mark')).toHaveLength(2);
  });

  it('marks nothing when the link names no words, as a Citation does not', async () => {
    await renderPage(citationClient(), citationRoute());

    await screen.findByTestId('cited-passage');
    expect(document.querySelector('mark')).toBeNull();
  });
});
