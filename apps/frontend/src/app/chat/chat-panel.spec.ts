import { input } from '@angular/core';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import {
  NOTEBOOK_ID,
  participant,
  thread,
  message,
  avatarOf,
  tooltipOf,
  resetAppEvents,
  renderPanel,
} from './chat-panel.spec-helpers';

describe('Chat panel (ThreadNavigator + ThreadView) — Chat Threads', () => {
  beforeEach(resetAppEvents);

  it('shows an empty state when the Notebook has no Chat Threads', async () => {
    await renderPanel({ listChatThreads: vi.fn().mockResolvedValue([]) as never });

    expect(await screen.findByText('No Chat Threads yet.')).toBeTruthy();
  });

  // NBK-10: "list every thread in a Notebook regardless of who started it".
  // Per GLOSSARY.md a Thread is "visible to every user who opens the
  // Notebook" — so the list must show other people's Threads, and say whose
  // they are.
  it('lists every Thread with its author and start date, whoever started it', async () => {
    const listChatThreads = vi.fn().mockResolvedValue([
      thread({
        id: 'thread-1',
        title: 'Alice asks about revenue',
        author: participant('alice@example.com'),
        createdAt: '2026-03-15T12:00:00.000Z',
      }),
      thread({
        id: 'thread-2',
        title: 'Bob asks about risk',
        author: participant('bob@example.com'),
        createdAt: '2026-02-03T12:00:00.000Z',
      }),
    ]);

    await renderPanel({
      listChatThreads: listChatThreads as never,
      listChatMessages: vi.fn().mockResolvedValue([]) as never,
    });

    const alice = await screen.findByRole('button', { name: 'Open Alice asks about revenue' });
    const bob = screen.getByRole('button', { name: 'Open Bob asks about risk' });
    expect(within(alice).getByText('Alice asks about revenue')).toBeTruthy();
    expect(within(bob).getByText('Bob asks about risk')).toBeTruthy();
    // Attribution, so a reader picking up someone else's line of questioning
    // knows whose it was — and when (spec 04 "Navigator": e-mail and a short
    // start date under the title).
    expect(within(alice).getByText('alice@example.com · Mar 15')).toBeTruthy();
    expect(within(bob).getByText('bob@example.com · Feb 3')).toBeTruthy();
    expect(listChatThreads).toHaveBeenCalledWith({ notebookId: NOTEBOOK_ID });
  });

  // NBK-43: starting a Thread is one click on the navigator's "New Chat
  // Thread" button; the title is the fixed placeholder "New Chat Thread"
  // (the create request requires a non-empty title) and renaming comes after.
  it('starts a new Chat Thread from the header button and opens it', async () => {
    const listChatThreads = vi.fn().mockResolvedValue([]);
    const createChatThread = vi.fn().mockResolvedValue(thread({ title: 'New Chat Thread' }));
    const listChatMessages = vi.fn().mockResolvedValue([]);

    await renderPanel({
      listChatThreads: listChatThreads as never,
      createChatThread: createChatThread as never,
      listChatMessages: listChatMessages as never,
    });

    await screen.findByText('No Chat Threads yet.');
    expect(screen.queryByLabelText('New Chat Thread title')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start Chat Thread' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'New Chat Thread' }));

    expect(createChatThread).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      body: { title: 'New Chat Thread' },
    });
    // It joins the list, and opens — the point of starting one is to ask in
    // it. (The title shows in both places, hence the role-scoped queries.)
    expect(await screen.findByRole('button', { name: 'Open New Chat Thread' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'New Chat Thread' })).toBeTruthy();
  });

  // NBK-10: "shows the conversation with per-message author attribution"
  // — which GLOSSARY.md names a Chat Thread's messages.
  // GLOSSARY.md: "every message in it records which user asked it".
  it('opens a Thread and shows its messages with per-message attribution', async () => {
    const listChatThreads = vi.fn().mockResolvedValue([thread()]);
    const listChatMessages = vi.fn().mockResolvedValue([
      message({
        id: 'm1',
        role: 'user',
        content: 'What was revenue in Q3?',
        askedBy: participant('alice@example.com'),
      }),
      message({
        id: 'm2',
        role: 'assistant',
        content: 'Revenue in Q3 was 12.4M.',
        askedBy: participant('alice@example.com'),
      }),
      message({
        id: 'm3',
        role: 'user',
        content: 'And the margin?',
        askedBy: participant('bob@example.com'),
      }),
    ]);

    await renderPanel({
      listChatThreads: listChatThreads as never,
      listChatMessages: listChatMessages as never,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Open Revenue questions' }));

    expect(await screen.findByText('What was revenue in Q3?')).toBeTruthy();
    expect(screen.getByText('Revenue in Q3 was 12.4M.')).toBeTruthy();
    expect(screen.getByText('And the margin?')).toBeTruthy();
    expect(listChatMessages).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      threadId: 'thread-1',
    });

    // A shared Thread several people contributed to has to say who asked
    // what — that is the whole point of recording it (ADR-0001). Spec 04
    // (NBK-44) shows the e-mail's local part on the line and keeps the full
    // e-mail on the avatar, so attribution stays exact without repeating
    // "@example.com" on every message.
    const askers = screen.getAllByTestId('chat-message-author').map((el) => el.textContent?.trim());
    expect(askers).toEqual(['alice', 'Assistant', 'bob']);
    expect(await tooltipOf(avatarOf(askers.indexOf('bob')))).toBe('bob@example.com');
  });

  it('sends a question and appends both it and the answer to the Chat Thread', async () => {
    const listChatThreads = vi.fn().mockResolvedValue([thread()]);
    const listChatMessages = vi.fn().mockResolvedValue([]);
    const sendChatMessage = vi.fn().mockResolvedValue({
      question: message({ id: 'q1', role: 'user', content: 'What was revenue in Q3?' }),
      answer: message({ id: 'a1', role: 'assistant', content: 'Revenue in Q3 was 12.4M.' }),
    });

    await renderPanel({
      listChatThreads: listChatThreads as never,
      listChatMessages: listChatMessages as never,
      sendChatMessage: sendChatMessage as never,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Open Revenue questions' }));
    await screen.findByText('Ask anything about the Documents in this Notebook');

    fireEvent.input(screen.getByLabelText('Ask a question'), {
      target: { value: 'What was revenue in Q3?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(sendChatMessage).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      threadId: 'thread-1',
      body: { content: 'What was revenue in Q3?' },
    });

    // One complete answer arrives with the question — NBK-10 is synchronous,
    // so there is no partial state to render here. NBK-11 streams it.
    expect(await screen.findByText('What was revenue in Q3?')).toBeTruthy();
    expect(await screen.findByText('Revenue in Q3 was 12.4M.')).toBeTruthy();
    // The messages were not re-fetched: the response carries both
    // messages with their server-assigned ids and attribution.
    expect(listChatMessages).toHaveBeenCalledTimes(1);
  });

  it('renames the open Thread', async () => {
    const listChatThreads = vi.fn().mockResolvedValue([thread({ title: 'Untitled' })]);
    const listChatMessages = vi.fn().mockResolvedValue([]);
    const renameChatThread = vi.fn().mockResolvedValue(thread({ title: 'Q3 revenue' }));

    await renderPanel({
      listChatThreads: listChatThreads as never,
      listChatMessages: listChatMessages as never,
      renameChatThread: renameChatThread as never,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Open Untitled' }));

    // NBK-51: the title in the header is the rename control.
    fireEvent.click(
      within(await screen.findByRole('heading', { name: 'Untitled' })).getByRole('button'),
    );
    const renameInput = screen.getByLabelText('Rename Chat Thread');
    fireEvent.input(renameInput, { target: { value: 'Q3 revenue' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });

    expect(renameChatThread).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      threadId: 'thread-1',
      body: { title: 'Q3 revenue' },
    });
    // The rename lands in both the list entry and the open Thread's
    // heading, and the old title is gone from both.
    expect(await screen.findByRole('button', { name: 'Open Q3 revenue' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Q3 revenue' })).toBeTruthy();
    expect(screen.queryByText('Untitled')).toBeNull();
  });

  it('surfaces a failure to answer without losing the typed question', async () => {
    const listChatThreads = vi.fn().mockResolvedValue([thread()]);
    const listChatMessages = vi.fn().mockResolvedValue([]);
    const sendChatMessage = vi
      .fn()
      .mockRejectedValue({ error: { message: 'The answer could not be generated.' } });

    await renderPanel({
      listChatThreads: listChatThreads as never,
      listChatMessages: listChatMessages as never,
      sendChatMessage: sendChatMessage as never,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Open Revenue questions' }));

    const input = (await screen.findByLabelText('Ask a question')) as HTMLTextAreaElement;
    fireEvent.input(input, { target: { value: 'What was revenue in Q3?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('The answer could not be generated.')).toBeTruthy();
    // The backend recorded nothing, so asking again is the retry — which is
    // only possible if the question is still in the box.
    expect(input.value).toBe('What was revenue in Q3?');
  });

  // NBK-43 (spec 04 "Navigator", "Default Thread"): the Chat Threads
  // navigator is a list read at a glance — the open Thread is marked, and a
  // Notebook that has Threads lands the user in the most recent one.
  describe('NBK-43: navigator', () => {
    /** The navigator row that opens the Thread with this title. */
    function row(title: string) {
      return screen.getByRole('button', { name: `Open ${title}` });
    }

    const OLDER = thread({
      id: 'thread-1',
      title: 'Revenue questions',
      createdAt: '2026-01-01T12:00:00.000Z',
    });
    const NEWER = thread({
      id: 'thread-2',
      title: 'Supply chain',
      author: participant('bob@example.com'),
      createdAt: '2026-03-15T12:00:00.000Z',
    });

    // User story 22: "opening a Notebook that has Chat Threads, I want the
    // most recently started one opened by default, so that I land in
    // context." Listed older-first here to prove it is the start date that
    // decides, not the list position.
    it('opens the most recently created Thread by default', async () => {
      const listChatMessages = vi.fn().mockResolvedValue([]);
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([OLDER, NEWER]) as never,
        listChatMessages: listChatMessages as never,
      });

      expect(await screen.findByRole('heading', { name: 'Supply chain' })).toBeTruthy();
      expect(listChatMessages).toHaveBeenCalledWith({
        notebookId: NOTEBOOK_ID,
        threadId: 'thread-2',
      });
      expect(listChatMessages).toHaveBeenCalledTimes(1);
    });

    it('opens no Thread when the Notebook has none', async () => {
      const listChatMessages = vi.fn().mockResolvedValue([]);
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([]) as never,
        listChatMessages: listChatMessages as never,
      });

      await screen.findByText('No Chat Threads yet.');
      expect(listChatMessages).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    });

    // User story 17: the open Thread is marked unmistakably. The mark the
    // tests can see is the selected state; the tint, bar and bold title hang
    // off the same class.
    it('marks the open Thread as current, and moves the mark when another is opened', async () => {
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([OLDER, NEWER]) as never,
        listChatMessages: vi.fn().mockResolvedValue([]) as never,
      });

      await screen.findByRole('heading', { name: 'Supply chain' });
      expect(row('Supply chain').getAttribute('aria-current')).toBe('true');
      expect(row('Revenue questions').getAttribute('aria-current')).toBeNull();

      fireEvent.click(row('Revenue questions'));

      expect(await screen.findByRole('heading', { name: 'Revenue questions' })).toBeTruthy();
      expect(row('Revenue questions').getAttribute('aria-current')).toBe('true');
      expect(row('Supply chain').getAttribute('aria-current')).toBeNull();
    });

    // Activating the row of the Thread already open is not a reload: the
    // messages on screen are the Thread's, and re-fetching them would blank
    // the list for a moment (and drop a streaming answer) for nothing.
    it('does not re-open the Thread that is already open', async () => {
      const listChatMessages = vi.fn().mockResolvedValue([]);
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([OLDER, NEWER]) as never,
        listChatMessages: listChatMessages as never,
      });

      await screen.findByRole('heading', { name: 'Supply chain' });
      fireEvent.click(row('Supply chain'));

      await screen.findByText('Ask anything about the Documents in this Notebook');
      expect(listChatMessages).toHaveBeenCalledTimes(1);
    });
  });

  describe('NBK-51: Thread title', () => {
    /** Activates the open Thread's title in the header, opening the rename box. */
    async function startRenaming(title: string) {
      const heading = await screen.findByRole('heading', { name: title });
      fireEvent.click(within(heading).getByRole('button', { name: title }));
      return screen.getByLabelText('Rename Chat Thread') as HTMLInputElement;
    }

    it('heads the open Thread with its title and who started it, with no rename form', async () => {
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([thread()]) as never,
        listChatMessages: vi.fn().mockResolvedValue([]) as never,
      });

      const heading = await screen.findByRole('heading', { name: 'Revenue questions' });
      expect(within(heading).getByRole('button', { name: 'Revenue questions' })).toBeTruthy();
      expect(screen.getByText('Started by alice@example.com')).toBeTruthy();
      expect(screen.queryByLabelText('Rename Chat Thread')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    });

    it('discards the typed title on Escape', async () => {
      const renameChatThread = vi.fn();
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([thread()]) as never,
        listChatMessages: vi.fn().mockResolvedValue([]) as never,
        renameChatThread: renameChatThread as never,
      });

      const box = await startRenaming('Revenue questions');
      fireEvent.input(box, { target: { value: 'Q3 revenue' } });
      fireEvent.keyDown(box, { key: 'Escape' });

      expect(screen.queryByLabelText('Rename Chat Thread')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Revenue questions' })).toBeTruthy();
      expect(renameChatThread).not.toHaveBeenCalled();
    });

    // A Thread starts as "New Chat Thread" (NBK-43), so renaming it is the
    // very next thing a user does — it must not wait on a reload.
    it('renames a Thread created a moment ago', async () => {
      const created = thread({ id: 'thread-new', title: 'New Chat Thread' });
      const renameChatThread = vi
        .fn()
        .mockResolvedValue(thread({ id: 'thread-new', title: 'Supply chain' }));
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([]) as never,
        listChatMessages: vi.fn().mockResolvedValue([]) as never,
        createChatThread: vi.fn().mockResolvedValue(created) as never,
        renameChatThread: renameChatThread as never,
      });
      await screen.findByText('No Chat Threads yet.');

      fireEvent.click(screen.getByRole('button', { name: 'New Chat Thread' }));
      const box = await startRenaming('New Chat Thread');
      fireEvent.input(box, { target: { value: 'Supply chain' } });
      fireEvent.keyDown(box, { key: 'Enter' });

      expect(renameChatThread).toHaveBeenCalledWith({
        notebookId: NOTEBOOK_ID,
        threadId: 'thread-new',
        body: { title: 'Supply chain' },
      });
      expect(await screen.findByRole('heading', { name: 'Supply chain' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Open Supply chain' })).toBeTruthy();
    });
  });
});
