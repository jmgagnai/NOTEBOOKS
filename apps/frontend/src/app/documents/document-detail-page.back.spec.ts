import { TestBed } from '@angular/core/testing';
import { fireEvent, screen, waitFor } from '@testing-library/angular';
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

/**
 * NBK-103: the Document page is for reading only. The chat pane spec 08 put
 * beside the Document is withdrawn, and a back arrow takes the reader to
 * where they came from — the search results they opened it from, or the
 * Notebook page with the Chat Thread they were in still open. Through the
 * real router, which destroys one page before it creates the next: the
 * only seam where either can be seen to work.
 */
describe('DocumentDetailPage — reading only, with a way back', () => {
  // A search result opens the Document at its best Chunk's Version, so the
  // Version-scoped reads answer too.
  const documents = () => ({
    getDocument: vi.fn().mockResolvedValue(SUMMARIZED_DETAIL),
    getDocumentVersion: vi
      .fn()
      .mockResolvedValue(
        versionDetail(VERSION_ID, { metadata: { title: 'Quarterly Report 2025' } }),
      ),
    getDocumentVersionContent: vi
      .fn()
      .mockResolvedValue({ versionId: VERSION_ID, markdown: FULL_MARKDOWN }),
  });
  const renderApp = (search: Record<string, unknown> = {}) =>
    renderRouted(documents(), twoThreads(), search);
  const openThreadTitle = (title: string) => screen.findByRole('heading', { name: title });
  const documentTitle = () =>
    screen.findByRole('heading', { level: 1, name: 'Quarterly Report 2025' });

  it('shows the Document alone: no chat pane, no chat toggle', async () => {
    await renderPage(documents(), undefined, twoThreads());

    await documentTitle();
    expect(screen.queryByRole('region', { name: 'Chat' })).toBeNull();
    expect(screen.queryByLabelText('Ask a question')).toBeNull();
    expect(screen.queryByRole('button', { name: /chat/i })).toBeNull();
  });

  it('goes back to the Notebook, the Chat Thread that was open still open', async () => {
    const { navigate } = await renderApp();
    await navigate(`/notebooks/${NOTEBOOK_ID}`);
    await openThreadTitle('Newer questions');
    // What clicking "Older questions" in the sidebar does.
    await TestBed.inject(ChatStore).openThread(NOTEBOOK_ID, 'thread-old');
    await openThreadTitle('Older questions');
    await navigate(`/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`);
    await documentTitle();

    fireEvent.click(screen.getByRole('link', { name: 'Back to the Notebook' }));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 1, name: 'Quarterly Report 2025' })).toBeNull(),
    );
    expect(await openThreadTitle('Older questions')).toBeTruthy();
  });

  it('goes back to the Notebook from a pasted link', async () => {
    const { navigate } = await renderApp();
    await navigate(`/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`);
    await documentTitle();

    const back = screen.getByRole('link', { name: 'Back to the Notebook' });
    expect(back.getAttribute('href')).toBe(`/notebooks/${NOTEBOOK_ID}`);
    expect(screen.queryByRole('button', { name: 'Back to search' })).toBeNull();
  });

  it('goes back to the search results it was opened from, without searching again', async () => {
    const searchNotebook = vi.fn().mockResolvedValue([
      {
        ...SUMMARIZED_DETAIL,
        status: 'ready',
        title: 'Quarterly Report 2025',
        match: { versionId: VERSION_ID, chunkId: 'chunk-1', charStart: null, charEnd: null },
        score: 0.9,
      },
    ]);
    const { navigate } = await renderApp({
      searchNotebook,
      searchChatThreads: vi.fn().mockResolvedValue([]),
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

  it('drops the open Chat Thread when the Notebook is left from the Document', async () => {
    const { navigate } = await renderApp();
    await navigate(`/notebooks/${NOTEBOOK_ID}`);
    await openThreadTitle('Newer questions');
    await TestBed.inject(ChatStore).openThread(NOTEBOOK_ID, 'thread-old');
    await openThreadTitle('Older questions');
    await navigate(`/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`);
    await documentTitle();

    await navigate('/');
    await screen.findByText('Somewhere else');
    await navigate(`/notebooks/${NOTEBOOK_ID}`);

    expect(await openThreadTitle('Newer questions')).toBeTruthy();
  });
});
