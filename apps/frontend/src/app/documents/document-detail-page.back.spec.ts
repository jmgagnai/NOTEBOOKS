import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { fireEvent, screen, waitFor, within } from '@testing-library/angular';
import {
  DOCUMENT_ID,
  FULL_MARKDOWN,
  NOTEBOOK_ID,
  SUMMARIZED_DETAIL,
  VERSION_ID,
  renderPage,
  renderRouted,
  twoThreads,
  versionDetail,
} from './document-detail-page.spec-helpers';
import { ChatStore } from '../chat/chat.store';
import { citation, message } from '../chat/chat-panel.spec-helpers';
import { OPENED_FROM_SEARCH } from './opened-from-search';

/**
 * NBK-103: the Document page is for reading only. The chat pane spec 08 put
 * beside the Document is withdrawn, and a back arrow takes the reader to
 * where they came from — the search results they opened it from, or the
 * Notebook page with the Chat Thread they were in still open. Through the
 * real router, which destroys one page before it creates the next: the
 * only seam where either can be seen to work.
 */
describe('DocumentDetailPage — reading only, with a way back', () => {
  const DOCUMENT_URL = `/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`;

  // The Documents panel lists the Document, and a search result or a
  // Citation opens it at a Chunk's Version, so the Version-scoped reads
  // answer too.
  const documents = () => ({
    getDocument: vi.fn().mockResolvedValue(SUMMARIZED_DETAIL),
    listDocuments: vi.fn().mockResolvedValue([{ ...SUMMARIZED_DETAIL, status: 'ready' }]),
    getDocumentVersion: vi
      .fn()
      .mockResolvedValue(
        versionDetail(VERSION_ID, { metadata: { title: 'Quarterly Report 2025' } }),
      ),
    getDocumentVersionContent: vi
      .fn()
      .mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN }),
  });
  const renderApp = (search: Record<string, unknown> = {}, chat = twoThreads()) =>
    renderRouted(documents(), chat, search);
  const openThreadTitle = (title: string) => screen.findByRole('heading', { name: title });
  const documentTitle = () =>
    screen.findByRole('heading', { level: 1, name: 'Quarterly Report 2025' });
  const backToTheNotebook = () => screen.getByRole('link', { name: 'Back to the Notebook' });

  /** On the Notebook page with its older Chat Thread open, as clicking it in the sidebar does. */
  async function inTheOlderThread(navigate: (url: string) => Promise<unknown>) {
    await navigate(`/notebooks/${NOTEBOOK_ID}`);
    await openThreadTitle('Newer questions');
    await TestBed.inject(ChatStore).openThread(NOTEBOOK_ID, 'thread-old');
    await openThreadTitle('Older questions');
  }

  it('shows the Document alone: no chat pane, no chat toggle', async () => {
    await renderPage(documents());

    await documentTitle();
    expect(screen.queryByRole('region', { name: 'Chat' })).toBeNull();
    expect(screen.queryByLabelText('Ask a question')).toBeNull();
    expect(screen.queryByRole('button', { name: /chat/i })).toBeNull();
  });

  it('goes back to the Notebook from the Documents panel, the Chat Thread still open', async () => {
    const { navigate } = await renderApp();
    await inTheOlderThread(navigate);
    const panel = screen.getByRole('list', { name: 'Documents' });
    fireEvent.click(await within(panel).findByRole('link', { name: /quarterly\.pdf/ }));
    await documentTitle();

    fireEvent.click(backToTheNotebook());

    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 1, name: 'Quarterly Report 2025' })).toBeNull(),
    );
    expect(await openThreadTitle('Older questions')).toBeTruthy();
  });

  it('goes back to the Notebook from a Citation', async () => {
    const { navigate } = await renderApp(
      {},
      {
        ...twoThreads(),
        listChatMessages: vi.fn().mockResolvedValue([
          message({
            id: 'a1',
            threadId: 'thread-new',
            role: 'assistant',
            content: 'Revenue grew [1].',
            citations: [citation({ documentId: DOCUMENT_ID, documentVersionId: VERSION_ID })],
          }),
        ]) as never,
      },
    );
    await navigate(`/notebooks/${NOTEBOOK_ID}`);
    fireEvent.click(await screen.findByRole('link', { name: 'Citation 1' }));
    await documentTitle();

    expect(backToTheNotebook().getAttribute('href')).toBe(`/notebooks/${NOTEBOOK_ID}`);
    expect(screen.queryByRole('button', { name: 'Back to search' })).toBeNull();
  });

  it('goes back to the Notebook from a pasted link', async () => {
    const { navigate } = await renderApp();
    await navigate(DOCUMENT_URL);
    await documentTitle();

    expect(backToTheNotebook().getAttribute('href')).toBe(`/notebooks/${NOTEBOOK_ID}`);
    expect(screen.queryByRole('button', { name: 'Back to search' })).toBeNull();
  });

  it('goes back to the search results it was opened from, without searching again', async () => {
    const searchNotebook = vi.fn().mockResolvedValue({
      correctedQuery: null,
      results: [
        {
          documentId: DOCUMENT_ID,
          filename: 'quarterly.pdf',
          title: 'Quarterly Report 2025',
          headingPath: ['Revenue'],
          match: { versionId: VERSION_ID, chunkId: 'chunk-1', charStart: null, charEnd: null },
          excerpt: [{ text: 'Revenue grew to 12.4M.', match: false }],
        },
      ],
    });
    const { navigate } = await renderApp({
      searchNotebook,
      searchChatThreads: vi.fn().mockResolvedValue({ correctedQuery: null, results: [] }),
    });
    await navigate(`/notebooks/${NOTEBOOK_ID}/search?q=revenue`);
    fireEvent.click(await screen.findByRole('link', { name: /Quarterly Report 2025/ }));
    await documentTitle();
    expect(screen.queryByRole('link', { name: 'Back to the Notebook' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Back to search' }));

    expect(await screen.findByRole('link', { name: /Quarterly Report 2025/ })).toBeTruthy();
    expect(screen.getByRole('search')).toBeTruthy();
    expect(searchNotebook).toHaveBeenCalledTimes(1);
  });

  // A reload keeps the history entry's state, and the router hands it back
  // to the page with the app's first navigation; but a reloaded app has no
  // search results to go back to. The test router starts from no history,
  // so that first navigation is stood in for by one the router has not yet
  // `navigated` before.
  it('goes back to the Notebook after a reload, even from a search result', async () => {
    await renderApp();
    const router = TestBed.inject(Router);
    router.navigated = false;

    await router.navigateByUrl(DOCUMENT_URL, { state: OPENED_FROM_SEARCH });
    await documentTitle();

    expect(backToTheNotebook()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to search' })).toBeNull();
  });

  it('drops the open Chat Thread when the Notebook is left from the Document', async () => {
    const { navigate } = await renderApp();
    await inTheOlderThread(navigate);
    await navigate(DOCUMENT_URL);
    await documentTitle();

    await navigate('/');
    await screen.findByText('Somewhere else');
    await navigate(`/notebooks/${NOTEBOOK_ID}`);

    expect(await openThreadTitle('Newer questions')).toBeTruthy();
  });
});
