import { fireEvent, screen } from '@testing-library/angular';
import {
  FULL_MARKDOWN,
  SUMMARIZED_DETAIL,
  VERSION_ID,
  activatedRoute,
  renderPage,
  supersededVersionDetail,
} from './document-detail-page.spec-helpers';

/**
 * NBK-90: a failed Version will never get what it is missing, so the page
 * says Ingestion failed before it was written — not that it is on its way,
 * under a failure sentence saying otherwise. What a failed Version does have
 * (a failure after conversion keeps the Converted Markdown; one while
 * indexing keeps the Executive Summary) is shown as ever.
 */
describe("DocumentDetailPage — a failed Document's missing sections", () => {
  const NO_SUMMARY =
    'This Document has no Executive Summary: its Ingestion failed before one was written.';
  const NO_MARKDOWN =
    'This Document has no Converted Markdown: its Ingestion failed before conversion finished.';
  const STILL_GENERATING = 'The Executive Summary is still being generated for this Document.';
  const NOT_CONVERTED = 'This Document has not been converted to Markdown yet.';

  const FAILED = {
    ...SUMMARIZED_DETAIL,
    status: 'failed',
    executiveSummary: null,
    failure: { reason: 'unexpected', failedAt: null },
  };

  const noMarkdown = () => vi.fn().mockResolvedValue({ versionId: VERSION_ID, markdown: null });

  it('says a failed Document has no Executive Summary, not that it is being generated', async () => {
    await renderPage({ getDocument: vi.fn().mockResolvedValue(FAILED) });

    expect(await screen.findByText(NO_SUMMARY)).toBeTruthy();
    expect(screen.queryByText(STILL_GENERATING)).toBeNull();
  });

  it('says a failed Document has no Converted Markdown, not that it is not converted yet', async () => {
    await renderPage({
      getDocument: vi.fn().mockResolvedValue(FAILED),
      getDocumentVersionContent: noMarkdown(),
    });
    await screen.findByText(NO_SUMMARY);

    fireEvent.click(screen.getByRole('button', { name: 'Read the full Document' }));

    expect(await screen.findByText(NO_MARKDOWN)).toBeTruthy();
    expect(screen.queryByText(NOT_CONVERTED)).toBeNull();
  });

  it('shows what a failed Document does have', async () => {
    await renderPage({
      getDocument: vi.fn().mockResolvedValue({
        ...FAILED,
        executiveSummary: SUMMARIZED_DETAIL.executiveSummary,
      }),
      getDocumentVersionContent: vi
        .fn()
        .mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN }),
    });

    expect(await screen.findByRole('heading', { name: 'Key points' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read the full Document' }));
    expect(await screen.findByText('Revenue grew to 12.4M.')).toBeTruthy();
    expect(screen.queryByText(NO_SUMMARY)).toBeNull();
    expect(screen.queryByText(NO_MARKDOWN)).toBeNull();
  });

  it.each(['queued', 'converting', 'converted', 'summarizing'])(
    'keeps the waiting sentences for a Document still in Ingestion (%s)',
    async (status) => {
      await renderPage({
        getDocument: vi.fn().mockResolvedValue({
          ...SUMMARIZED_DETAIL,
          status,
          executiveSummary: null,
        }),
        getDocumentVersionContent: noMarkdown(),
      });
      await screen.findByText(STILL_GENERATING);

      fireEvent.click(screen.getByRole('button', { name: 'Read the full Document' }));

      expect(await screen.findByText(NOT_CONVERTED)).toBeTruthy();
      expect(screen.queryByText(NO_SUMMARY)).toBeNull();
    },
  );

  it("goes by the pinned Version's status when a Citation was followed", async () => {
    const PINNED = '66666666-6666-6666-6666-666666666666';
    await renderPage(
      {
        // The latest Version is fine; only the pinned one failed.
        getDocument: vi.fn().mockResolvedValue(SUMMARIZED_DETAIL),
        getDocumentVersion: vi.fn().mockResolvedValue(
          supersededVersionDetail(PINNED, {
            status: 'failed',
            failure: { reason: 'unexpected', failedAt: null },
          }),
        ),
        getDocumentVersionContent: vi.fn().mockResolvedValue({ versionId: PINNED, markdown: null }),
      },
      activatedRoute({ version: PINNED }),
    );

    expect(await screen.findByText(NO_SUMMARY)).toBeTruthy();
    expect(await screen.findByText(NO_MARKDOWN)).toBeTruthy();
  });
});
