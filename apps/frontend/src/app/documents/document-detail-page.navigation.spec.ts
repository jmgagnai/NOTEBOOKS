import { TestBed } from '@angular/core/testing';
import { fireEvent, screen, waitFor, within } from '@testing-library/angular';
import {
  DOCUMENT_ID,
  NEWER_THREAD,
  NOTEBOOK_ID,
  OLDER_THREAD,
  SUMMARIZED_DETAIL,
  chatPane,
  renderRouted,
} from './document-detail-page.spec-helpers';
import { ChatStore } from '../chat/chat.store';

/**
 * Spec 08 (NBK-86): the open Chat Thread follows the reader between the
 * Notebook page and the Document page, both ways, through the real router —
 * which destroys one page before it creates the next, so this is the only
 * seam where carrying it over can be seen to work. Entering the Notebook
 * from anywhere else still opens its newest Chat Thread (NBK-43).
 */
describe('DocumentDetailPage — the open Chat Thread between pages', () => {
  const renderApp = () =>
    renderRouted({ getDocument: vi.fn().mockResolvedValue(SUMMARIZED_DETAIL) }, {
      listChatThreads: vi.fn().mockResolvedValue([OLDER_THREAD, NEWER_THREAD]),
      listChatMessages: vi.fn().mockResolvedValue([]),
    } as never);

  const openThreadTitle = (title: string) => screen.findByRole('heading', { name: title });

  it('keeps the Chat Thread open from the Notebook page to the Document and back', async () => {
    const { navigate } = await renderApp();
    await navigate(`/notebooks/${NOTEBOOK_ID}`);
    await openThreadTitle('Newer questions');
    // What clicking "Older questions" in the sidebar does.
    await TestBed.inject(ChatStore).openThread(NOTEBOOK_ID, 'thread-old');
    await openThreadTitle('Older questions');

    await navigate(`/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`);
    await screen.findByRole('region', { name: 'Chat' });
    expect(
      await within(chatPane()).findByRole('heading', { name: 'Older questions' }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Back to the Notebook' }));
    // Back on the Notebook page once the Document is gone. (Not the "Chat"
    // region: the Notebook page's middle pane carries that name too.)
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 1, name: 'Quarterly Report 2025' })).toBeNull(),
    );
    expect(await openThreadTitle('Older questions')).toBeTruthy();
  });

  it('opens the newest Chat Thread again when the Notebook is entered from elsewhere', async () => {
    const { navigate } = await renderApp();
    await navigate(`/notebooks/${NOTEBOOK_ID}`);
    await openThreadTitle('Newer questions');
    await TestBed.inject(ChatStore).openThread(NOTEBOOK_ID, 'thread-old');
    await openThreadTitle('Older questions');

    await navigate('/');
    await screen.findByText('Somewhere else');
    await navigate(`/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`);

    await screen.findByRole('region', { name: 'Chat' });
    expect(
      await within(chatPane()).findByRole('heading', { name: 'Newer questions' }),
    ).toBeTruthy();
  });

  // Spec 08 (NBK-87): the Thread a reader is in wins over the one a link
  // names — following a Citation from it must not swap the conversation.
  it('keeps the Chat Thread already open over the one the link names', async () => {
    const { navigate } = await renderApp();
    await navigate(`/notebooks/${NOTEBOOK_ID}`);
    await openThreadTitle('Newer questions');

    await navigate(`/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}?thread=thread-old`);

    await screen.findByRole('region', { name: 'Chat' });
    expect(
      await within(chatPane()).findByRole('heading', { name: 'Newer questions' }),
    ).toBeTruthy();
  });
});
