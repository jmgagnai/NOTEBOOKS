import { fireEvent, screen, waitFor, within } from '@testing-library/angular';
import {
  ASK,
  message,
  q3Exchange,
  questionBox,
  sendButton,
  thread,
} from '../chat/chat-panel.spec-helpers';
import { NOTEBOOK_ID, SUMMARIZED_DETAIL, renderPage } from './document-detail-page.spec-helpers';

/**
 * Spec 08 (NBK-86): a chat pane beside the Document, so a reader can ask
 * about what they are reading without leaving it. The pane is the Notebook
 * page's own Thread view, so these tests drive it through the page.
 */
describe('DocumentDetailPage — chat beside the Document', () => {
  const documents = () => ({ getDocument: vi.fn().mockResolvedValue(SUMMARIZED_DETAIL) });
  const chatPane = () => screen.getByRole('region', { name: 'Chat' });

  it("opens the Notebook's newest Chat Thread beside the Document", async () => {
    const listChatMessages = vi.fn().mockResolvedValue([message({ threadId: 'thread-new' })]);
    await renderPage(documents(), undefined, {
      listChatThreads: vi
        .fn()
        .mockResolvedValue([
          thread({ id: 'thread-old', title: 'Older questions', createdAt: '2026-01-01T00:00:00Z' }),
          thread({ id: 'thread-new', title: 'Newer questions', createdAt: '2026-02-01T00:00:00Z' }),
        ]),
      listChatMessages,
    } as never);

    await screen.findByText('What was revenue in Q3?');
    expect(within(chatPane()).getByText('Newer questions')).toBeTruthy();
    expect(listChatMessages).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-new' }),
    );
    // The Document is still the page.
    expect(screen.getByRole('heading', { level: 1, name: 'Quarterly Report 2025' })).toBeTruthy();
  });

  it('shows only the question box in a Notebook with no Chat Threads, not the Notebook landing', async () => {
    await renderPage(documents());
    await screen.findByRole('heading', { level: 1, name: 'Quarterly Report 2025' });

    await waitFor(() => expect(within(chatPane()).getByLabelText('Ask a question')).toBeTruthy());
    // The landing's folder and Notebook title would compete with the
    // Document's own headline in a third of the page.
    expect(within(chatPane()).queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Notebook title' })).toBeNull();
  });

  it('starts a Chat Thread from the empty pane and asks in it', async () => {
    const createChatThread = vi.fn().mockResolvedValue(thread({ title: 'New Chat Thread' }));
    const sendChatMessage = vi.fn().mockResolvedValue(q3Exchange());
    await renderPage(documents(), undefined, {
      listChatThreads: vi.fn().mockResolvedValue([]),
      createChatThread,
      sendChatMessage,
    } as never);
    await screen.findByRole('heading', { level: 1, name: 'Quarterly Report 2025' });

    fireEvent.input(questionBox(), { target: { value: ASK } });
    fireEvent.click(sendButton());

    expect(await within(chatPane()).findByText('Revenue in Q3 was 12.4M.')).toBeTruthy();
    expect(createChatThread).toHaveBeenCalledTimes(1);
    expect(createChatThread).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      body: { title: 'New Chat Thread' },
    });
    expect(sendChatMessage).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      threadId: 'thread-1',
      body: { content: ASK },
    });
  });

  it('closes the Chat Thread with ← and stays on the Document', async () => {
    await renderPage(documents(), undefined, {
      listChatThreads: vi.fn().mockResolvedValue([thread()]),
      listChatMessages: vi.fn().mockResolvedValue([]),
    } as never);
    await within(chatPane()).findByText('Revenue questions');

    fireEvent.click(within(chatPane()).getByRole('button', { name: 'Close Chat Thread' }));

    expect(within(chatPane()).queryByText('Revenue questions')).toBeNull();
    expect(within(chatPane()).getByLabelText('Ask a question')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Quarterly Report 2025' })).toBeTruthy();
  });

  it('hides the chat pane and brings it back on the same Chat Thread', async () => {
    await renderPage(documents(), undefined, {
      listChatThreads: vi.fn().mockResolvedValue([thread()]),
      listChatMessages: vi.fn().mockResolvedValue([]),
    } as never);
    await within(chatPane()).findByText('Revenue questions');

    fireEvent.click(screen.getByRole('button', { name: 'Hide chat' }));
    expect(screen.queryByRole('region', { name: 'Chat' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Quarterly Report 2025' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show chat' }));
    expect(await within(chatPane()).findByText('Revenue questions')).toBeTruthy();
  });

  describe('on a window narrower than 900 px', () => {
    const width = window.innerWidth;
    beforeEach(() =>
      Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true }),
    );
    afterEach(() =>
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true }),
    );

    it('starts with the chat pane hidden, a click away', async () => {
      await renderPage(documents());
      await screen.findByRole('heading', { level: 1, name: 'Quarterly Report 2025' });

      expect(screen.queryByRole('region', { name: 'Chat' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Show chat' }));
      expect(chatPane()).toBeTruthy();
    });
  });
});
