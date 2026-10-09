import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, screen, waitFor, within } from '@testing-library/angular';
import {
  DOCUMENT_ID,
  FULL_MARKDOWN,
  NOTEBOOK_ID,
  SUMMARIZED_DETAIL,
  VERSION_ID,
  renderPage,
  activatedRoute,
  noChat,
  renderRouted,
  supersededVersionDetail,
  versionDetail,
} from './document-detail-page.spec-helpers';
import type { AppEvent } from '../events/app-events.service';

/**
 * NBK-93: the Document page follows the Version on screen through Ingestion
 * while it is open — its status from each event at once, its artifacts by
 * re-reading that Version when they exist ("an event is a hint; re-read the
 * truth", ADR-0004) — instead of showing its arrival state until reload.
 */
describe('DocumentDetailPage — following Ingestion while open', () => {
  /** The Document as it is mid-Ingestion: converting, nothing generated yet. */
  const CONVERTING = {
    ...SUMMARIZED_DETAIL,
    status: 'converting',
    executiveSummary: null,
    metadata: null,
  };

  let next = 0;
  function statusChanged(
    status: string,
    { documentId = DOCUMENT_ID, versionId = VERSION_ID, failure = undefined as unknown } = {},
  ): AppEvent {
    next++;
    return {
      id: `event-${next}`,
      type: 'document-version-status-changed',
      topic: `notebook:${NOTEBOOK_ID}`,
      occurredAt: `2026-01-01T00:00:0${next % 10}.000Z`,
      data: { documentId, versionId, status, ...(failure ? { failure } : {}) },
    };
  }

  it("shows each later status on the Version's badge as it arrives", async () => {
    const { appEvents } = await renderPage({ getDocument: vi.fn().mockResolvedValue(CONVERTING) });
    const byline = await screen.findByTestId('byline');
    expect(within(byline).getByText('Converting')).toBeTruthy();

    appEvents.events.next(statusChanged('converted'));

    expect(await within(byline).findByText('Converted')).toBeTruthy();
  });

  /** What re-reading the Version returns once Stage 2 has written its artifacts. */
  const SUMMARIZED_VERSION = versionDetail(VERSION_ID, {
    version: {
      id: VERSION_ID,
      versionNumber: 2,
      mimeType: 'application/pdf',
      sizeBytes: 100,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    status: 'summarized',
    executiveSummary: SUMMARIZED_DETAIL.executiveSummary,
    metadata: SUMMARIZED_DETAIL.metadata,
    isLatestVersion: true,
  });

  function clients() {
    return {
      getDocument: vi.fn().mockResolvedValue(CONVERTING),
      getDocumentVersion: vi.fn().mockResolvedValue(SUMMARIZED_VERSION),
      getDocumentVersionContent: vi
        .fn()
        .mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN }),
    };
  }

  it('re-reads the Version on screen once it is summarized, in place', async () => {
    const documents = clients();
    const { appEvents } = await renderPage(documents);
    await screen.findByText('The Executive Summary is still being generated for this Document.');
    fireEvent.click(screen.getByRole('button', { name: 'Read the full Document' }));
    await screen.findByText('Revenue grew to 12.4M.');

    appEvents.events.next(statusChanged('summarized'));

    // The extracted title heads the page now, the filename under it.
    expect(await screen.findByTestId('document-filename')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Key points' })).toBeTruthy();
    expect(documents.getDocumentVersion).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      documentId: DOCUMENT_ID,
      versionId: VERSION_ID,
    });
    // In place: the full Document the reader opened is still open, and was
    // not fetched again.
    expect(screen.getByText('Revenue grew to 12.4M.')).toBeTruthy();
    expect(documents.getDocumentVersionContent).toHaveBeenCalledTimes(1);
  });

  it('says why when the Version fails while open', async () => {
    const failure = { reason: 'no-text-layer', failedAt: 'converting' };
    const documents = {
      ...clients(),
      getDocumentVersion: vi.fn().mockResolvedValue({
        ...SUMMARIZED_VERSION,
        status: 'failed',
        executiveSummary: null,
        failure,
      }),
    };
    const { appEvents } = await renderPage(documents);
    await screen.findByText('The Executive Summary is still being generated for this Document.');

    appEvents.events.next(statusChanged('failed', { failure }));

    expect(
      await screen.findByText(
        'This PDF has no selectable text (it looks like a scan). Upload a PDF whose text can be selected.',
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText(
        'This Document has no Executive Summary: its Ingestion failed before one was written.',
      ),
    ).toBeTruthy();
  });

  it('brings in the Converted Markdown once conversion finishes, if the full Document is open', async () => {
    const documents = {
      ...clients(),
      getDocumentVersionContent: vi
        .fn()
        .mockResolvedValueOnce({ versionId: VERSION_ID, markdown: null })
        .mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN }),
    };
    const { appEvents } = await renderPage(documents);
    await screen.findByTestId('byline');
    fireEvent.click(screen.getByRole('button', { name: 'Read the full Document' }));
    await screen.findByText('This Document has not been converted to Markdown yet.');

    appEvents.events.next(statusChanged('converted'));

    expect(await screen.findByText('Revenue grew to 12.4M.')).toBeTruthy();
    expect(documents.getDocumentVersionContent).toHaveBeenCalledTimes(2);
  });

  it('ignores events about another Document or another Version of this one', async () => {
    const documents = clients();
    const { appEvents } = await renderPage(documents);
    const byline = await screen.findByTestId('byline');

    appEvents.events.next(statusChanged('ready', { documentId: 'another-document' }));
    appEvents.events.next(statusChanged('ready', { versionId: 'a-newer-version' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(within(byline).getByText('Converting')).toBeTruthy();
    expect(documents.getDocumentVersion).not.toHaveBeenCalled();
  });

  it('keeps showing "not converted yet", with no spinner, while it reads the Converted Markdown again', async () => {
    let deliver!: (content: unknown) => void;
    const documents = {
      ...clients(),
      getDocumentVersionContent: vi
        .fn()
        .mockResolvedValueOnce({ versionId: VERSION_ID, markdown: null })
        .mockImplementationOnce(() => new Promise((resolve) => (deliver = resolve))),
    };
    const { appEvents } = await renderPage(documents);
    await screen.findByTestId('byline');
    fireEvent.click(screen.getByRole('button', { name: 'Read the full Document' }));
    await screen.findByText('This Document has not been converted to Markdown yet.');

    appEvents.events.next(statusChanged('converted'));
    await waitFor(() => expect(documents.getDocumentVersionContent).toHaveBeenCalledTimes(2));

    expect(screen.getByText('This Document has not been converted to Markdown yet.')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    deliver({ versionId: VERSION_ID, markdown: FULL_MARKDOWN });
    expect(await screen.findByText('Revenue grew to 12.4M.')).toBeTruthy();
  });

  it('leaves the page as it is when a background read fails', async () => {
    const documents = {
      ...clients(),
      getDocumentVersion: vi.fn().mockRejectedValue({ error: { message: 'Gateway timeout.' } }),
      getDocumentVersionContent: vi
        .fn()
        .mockResolvedValueOnce({ versionId: VERSION_ID, markdown: null })
        .mockRejectedValue({ error: { message: 'Gateway timeout.' } }),
    };
    const { appEvents } = await renderPage(documents);
    const byline = await screen.findByTestId('byline');
    fireEvent.click(screen.getByRole('button', { name: 'Read the full Document' }));
    await screen.findByText('This Document has not been converted to Markdown yet.');

    appEvents.events.next(statusChanged('summarized'));
    await waitFor(() => expect(documents.getDocumentVersion).toHaveBeenCalled());
    await waitFor(() => expect(documents.getDocumentVersionContent).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByText(/Gateway timeout|Failed to load/)).toBeNull();
    expect(within(byline).getByText('Summarized')).toBeTruthy();
  });

  it('never moves the badge back when an earlier re-read answers after a later event', async () => {
    let answerLate!: (detail: unknown) => void;
    const documents = {
      ...clients(),
      getDocumentVersion: vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => (answerLate = resolve)))
        .mockResolvedValue({ ...SUMMARIZED_VERSION, status: 'ready' }),
    };
    const { appEvents } = await renderPage(documents);
    const byline = await screen.findByTestId('byline');

    appEvents.events.next(statusChanged('summarized'));
    appEvents.events.next(statusChanged('ready'));
    expect(await within(byline).findByText('Ready')).toBeTruthy();
    answerLate(SUMMARIZED_VERSION);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(within(screen.getByTestId('byline')).getByText('Ready')).toBeTruthy();
  });

  it('does not bring in the superseded notice when a newer Version arrives mid-read', async () => {
    const documents = {
      ...clients(),
      getDocumentVersion: vi.fn().mockResolvedValue({
        ...SUMMARIZED_VERSION,
        isLatestVersion: false,
        latestVersionNumber: 3,
      }),
    };
    const { appEvents } = await renderPage(documents);
    await screen.findByTestId('byline');

    appEvents.events.next(statusChanged('summarized'));
    await screen.findByRole('heading', { name: 'Key points' });

    expect(screen.queryByTestId('cited-version-notice')).toBeNull();
  });

  it('leaves a pinned older Version alone when the latest Version moves on', async () => {
    const OLD = '77777777-7777-7777-7777-777777777777';
    const documents = {
      ...clients(),
      getDocumentVersion: vi.fn().mockResolvedValue(supersededVersionDetail(OLD)),
    };
    const { appEvents } = await renderPage(documents, activatedRoute({ version: OLD }));
    const byline = await screen.findByTestId('byline');

    appEvents.events.next(statusChanged('failed', { failure: { reason: 'unexpected' } }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(within(byline).getByText('Ready')).toBeTruthy();
    expect(documents.getDocumentVersion).toHaveBeenCalledTimes(1);
  });

  // Through the real router: what only navigation shows.
  describe('across navigation', () => {
    const OTHER_DOCUMENT_ID = '99999999-9999-9999-9999-999999999999';
    const OTHER_VERSION_ID = '88888888-8888-8888-8888-888888888888';
    const OTHER_VERSION = versionDetail(OTHER_VERSION_ID, {
      documentId: OTHER_DOCUMENT_ID,
      filename: 'suppliers.pdf',
      metadata: { title: 'Supplier Review' },
      isLatestVersion: true,
      latestVersionNumber: 1,
    });
    const chat = () => ({ listChatThreads: vi.fn().mockResolvedValue([]) }) as never;

    it('lets a Citation followed during a refresh win over the refresh', async () => {
      let answerLate!: (detail: unknown) => void;
      const documents = {
        ...clients(),
        getDocumentVersion: vi
          .fn()
          .mockImplementationOnce(() => new Promise((resolve) => (answerLate = resolve)))
          .mockResolvedValue(OTHER_VERSION),
      };
      const { navigate, appEvents } = await renderRouted(documents, noChat());
      await navigate(`/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`);
      await screen.findByTestId('byline');

      appEvents.events.next(statusChanged('summarized'));
      await waitFor(() => expect(documents.getDocumentVersion).toHaveBeenCalledTimes(1));
      await navigate(
        `/notebooks/${NOTEBOOK_ID}/documents/${OTHER_DOCUMENT_ID}?version=${OTHER_VERSION_ID}`,
      );
      await screen.findByRole('heading', { level: 1, name: 'Supplier Review' });
      answerLate(SUMMARIZED_VERSION);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await TestBed.inject(ApplicationRef).whenStable();

      expect(screen.getByRole('heading', { level: 1, name: 'Supplier Review' })).toBeTruthy();
      expect(screen.queryByTestId('document-filename')?.textContent).not.toContain('quarterly');
    });

    it('hands the live stream between the Notebook page and the Document page', async () => {
      // The list reports the Document as the server holds it by then.
      let stored = CONVERTING;
      const send = (status: string) => {
        stored = { ...stored, status };
        appEvents.events.next(statusChanged(status));
      };
      const documents = {
        ...clients(),
        listDocuments: vi.fn().mockImplementation(() => Promise.resolve([stored])),
      };
      const { navigate, appEvents } = await renderRouted(documents, noChat());
      await navigate(`/notebooks/${NOTEBOOK_ID}`);
      await screen.findByText('quarterly.pdf');
      // The Notebook page's subscriptions to the stream (Documents and chat).
      const onNotebookPage = appEvents.events.observers.length;

      await navigate(`/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`);
      const byline = await screen.findByTestId('byline');
      send('converted');
      expect(await within(byline).findByText('Converted')).toBeTruthy();

      await navigate(`/notebooks/${NOTEBOOK_ID}`);
      await waitFor(() => expect(screen.queryByTestId('byline')).toBeNull());
      send('indexing');
      expect(await screen.findByText('Indexing')).toBeTruthy();
      // Handed over, not stacked: as many subscriptions as before the trip.
      expect(appEvents.events.observers.length).toBe(onNotebookPage);
    });
  });
});
