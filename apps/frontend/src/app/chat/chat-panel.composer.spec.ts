import { input } from '@angular/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/angular';
import {
  scrolled,
  stubScrolling,
  NOTEBOOK_ID,
  thread,
  message,
  tooltipOf,
  questionBox,
  sendButton,
  newThreadButton,
  ASK,
  q3Exchange,
  pendingRow,
  listOf,
  heldSend,
  chunk,
  failed,
  appEvents,
  resetAppEvents,
  renderPanel,
  draftAQuestion,
  sendHeld,
} from './chat-panel.spec-helpers';

describe('Chat panel (ThreadNavigator + ThreadView) — asking', () => {
  beforeEach(resetAppEvents);

  // NBK-45 (spec 04 "Composer" / "Answering state"): the question box as a
  // chat composer — Enter sends, the box closes while the backend answers
  // and reopens focused, and an error is a dismissible row above it.
  describe('NBK-45: composer', () => {
    it('cannot send an empty draft', async () => {
      await draftAQuestion();
      expect(sendButton().disabled).toBe(false);

      fireEvent.input(questionBox(), { target: { value: '   ' } });

      // Whitespace is nothing to ask: the same rule `send` applies, shown
      // on the button rather than discovered on click.
      expect(sendButton().disabled).toBe(true);
    });

    it('sends on Enter, while Shift+Enter is left to add a line', async () => {
      const { sendChatMessage } = await draftAQuestion();

      // Not prevented, so the browser goes on to insert the newline.
      expect(fireEvent.keyDown(questionBox(), { key: 'Enter', shiftKey: true })).toBe(true);
      expect(sendChatMessage).not.toHaveBeenCalled();

      expect(fireEvent.keyDown(questionBox(), { key: 'Enter' })).toBe(false);
      expect(sendChatMessage).toHaveBeenCalledWith({
        notebookId: NOTEBOOK_ID,
        threadId: 'thread-1',
        body: { content: ASK },
      });
    });

    // Story 15: the box is closed from the send until the recorded answer is
    // back (`sending` in the store), so a second question cannot be asked
    // into an answer still being written — and it reopens focused, so the
    // next one can be typed straight away.
    it('closes the box while answering, then reopens it focused and empty', async () => {
      const { sendChatMessage, settle } = heldSend();
      await draftAQuestion({ sendChatMessage });

      fireEvent.keyDown(questionBox(), { key: 'Enter' });

      expect(await screen.findByRole('status', { name: 'Answering' })).toBeTruthy();
      expect(questionBox().disabled).toBe(true);
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
      expect(screen.getByText('Answering… the box reopens when the answer is in')).toBeTruthy();
      // Enter while closed is nothing: no second ask goes out.
      fireEvent.keyDown(questionBox(), { key: 'Enter' });
      expect(sendChatMessage).toHaveBeenCalledTimes(1);

      settle(q3Exchange());

      await waitFor(() => expect(questionBox().disabled).toBe(false));
      expect(screen.queryByRole('status', { name: 'Answering' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
      expect(screen.getByText('Enter to send · Shift+Enter for a new line')).toBeTruthy();
      expect(questionBox().value).toBe('');
      await waitFor(() => expect(document.activeElement).toBe(questionBox()));
    });

    // Story 23: the 503 when the LLM is unavailable is the case to design
    // for — it is not the user's fault, and it must not take the draft.
    // NBK-70: the draft moves out of the box on send, into the Thread as
    // the pending question, and back in when the ask fails.
    it('shows a failed ask as an error row above the box, dismissible, with the draft back in the box', async () => {
      const { sendChatMessage, fail } = heldSend();
      await draftAQuestion({ sendChatMessage });

      fireEvent.keyDown(questionBox(), { key: 'Enter' });
      await screen.findByRole('status', { name: 'Answering' });
      expect(questionBox().value).toBe('');

      fail({ error: { message: 'The language model is unavailable.' } });

      const row = await screen.findByRole('alert');
      expect(within(row).getByText('The language model is unavailable.')).toBeTruthy();
      expect(questionBox().disabled).toBe(false);
      expect(questionBox().value).toBe(ASK);

      fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));

      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(questionBox().value).toBe(ASK);
    });
  });

  // NBK-53 (spec 04 "Scrolling", stories 15b–15d): the message list follows
  // three rules and nothing else. jsdom has no layout, so each rule is
  // asserted through the scroll calls the list makes — on itself, or on the
  // row it brings into view — never through a resulting position.
  describe('NBK-53: scrolling', () => {
    let scrollTo: ReturnType<typeof vi.fn>;
    let scrollIntoView: ReturnType<typeof vi.fn>;
    let restoreScrolling: () => void;

    beforeEach(() => {
      ({ scrollTo, scrollIntoView, restore: restoreScrolling } = stubScrolling());
    });

    afterEach(() => restoreScrolling());

    /**
     * Opens thread-1 on one earlier exchange and sends a question whose ask
     * is left in flight, handing back its resolver. The scroll calls made by
     * opening the Thread are cleared, so each test sees only what follows.
     */
    async function askInFlight() {
      const { sendChatMessage, settle } = heldSend();
      await draftAQuestion({ sendChatMessage }, [
        message({ id: 'q0', content: 'What was revenue in Q2?' }),
        message({ id: 'a0', role: 'assistant', content: 'Revenue in Q2 was 11.9M.' }),
      ]);
      await waitFor(() => expect(scrollTo).toHaveBeenCalled());
      scrollTo.mockClear();
      scrollIntoView.mockClear();

      fireEvent.keyDown(questionBox(), { key: 'Enter' });
      await screen.findByRole('status', { name: 'Answering' });
      return { settle };
    }

    it('lands at the end of the messages when a Thread is opened or switched to', async () => {
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([
          thread({
            id: 'thread-1',
            title: 'Revenue questions',
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
          thread({
            id: 'thread-2',
            title: 'Supply chain',
            createdAt: '2026-03-15T00:00:00.000Z',
          }),
        ]) as never,
        listChatMessages: vi.fn(({ threadId }: { threadId: string }) =>
          Promise.resolve([
            message({ id: `${threadId}-q`, threadId, content: `Question in ${threadId}` }),
          ]),
        ) as never,
      });

      // The newest Thread opens by default (NBK-43): that is an open too.
      await screen.findByText('Question in thread-2');
      await waitFor(() => expect(scrolled(scrollTo)).toContain(listOf('Question in thread-2')));
      expect(scrollTo).toHaveBeenLastCalledWith(
        expect.objectContaining({ top: expect.any(Number) }),
      );

      scrollTo.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Open Revenue questions' }));

      await screen.findByText('Question in thread-1');
      await waitFor(() => expect(scrolled(scrollTo)).toContain(listOf('Question in thread-1')));
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    // Story 15c (NBK-71): the question shows the moment it is sent, as a
    // pending question (NBK-70), so that is the moment it comes into view, at
    // the bottom where the newest exchange sits. The recorded question taking
    // its place is the same question already in view, so it is not a move of
    // its own — but the answer recorded with it is (story 15d, below).
    it('brings the question just asked into view at the bottom on send, and not again when it is recorded', async () => {
      const { settle } = await askInFlight();

      const pending = pendingRow()!;
      await waitFor(() => expect(scrolled(scrollIntoView)).toEqual([pending]));
      expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'end' }));

      settle(q3Exchange());

      await waitFor(() => expect(pendingRow()).toBeNull());
      await screen.findByText('Revenue in Q3 was 12.4M.');
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    // Story 15d, as amended: the list follows the answer to its end — each
    // block as it streams in, and the recorded answer taking the preview's
    // place — so the newest text, its Citations and the question box stay in
    // view without scrolling by hand.
    it('follows the bottom as the answer streams in, and when it is recorded', async () => {
      const { settle } = await askInFlight();
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      scrollIntoView.mockClear();
      const list = listOf('What was revenue in Q2?');
      const toBottom = () =>
        expect(scrollTo).toHaveBeenLastCalledWith(
          expect.objectContaining({ top: list.scrollHeight }),
        );

      appEvents.events.next(chunk(0, '## Revenue'));
      await screen.findByTestId('chat-streaming-answer');
      await waitFor(() => expect(scrolled(scrollTo)).toEqual([list]));
      toBottom();

      scrollTo.mockClear();
      appEvents.events.next(chunk(1, 'Revenue in Q3 was 12.4M.'));
      await screen.findByText('Revenue in Q3 was 12.4M.');
      await waitFor(() => expect(scrolled(scrollTo)).toEqual([list]));
      toBottom();

      scrollTo.mockClear();
      settle(q3Exchange());
      await waitFor(() => expect(screen.queryByTestId('chat-streaming-answer')).toBeNull());
      await screen.findByText('What was revenue in Q3?', { selector: 'p' });
      await waitFor(() => expect(scrolled(scrollTo)).toContain(list));
      toBottom();
      // No jump back to the answer's start.
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('follows the bottom when an answer is recorded without streaming', async () => {
      const { settle } = await askInFlight();
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      const list = listOf('What was revenue in Q2?');

      settle(q3Exchange());

      await screen.findByText('Revenue in Q3 was 12.4M.');
      await waitFor(() => expect(scrolled(scrollTo)).toContain(list));
      expect(scrollTo).toHaveBeenLastCalledWith(
        expect.objectContaining({ top: list.scrollHeight }),
      );
    });
  });

  // NBK-70 (spec NBK-69): the question shows the moment it is sent, as a
  // pending question — the asker's bubble, muted, with "Sending…" — and the
  // box empties. The recorded question replaces it; a failed ask takes it
  // back out and returns the text to the box.
  describe('NBK-70: pending question', () => {
    it('shows the question at once, marked as sending and attributed to the signed-in user, and empties the box', async () => {
      await sendHeld();

      const row = await screen.findByTestId('chat-pending-question');
      expect(within(row).getByText(ASK)).toBeTruthy();
      expect(within(row).getByText('Sending…')).toBeTruthy();
      expect(within(row).getByTestId('chat-message-author').textContent?.trim()).toBe(
        'carol.white',
      );
      expect(within(row).getByTestId('chat-user-avatar').textContent?.trim()).toBe('CW');
      expect(await tooltipOf(within(row).getByTestId('chat-user-avatar'))).toBe(
        'carol.white@example.com',
      );
      // In the message list, in reading order.
      expect(row.closest('ol')).toBeTruthy();
      expect(questionBox().value).toBe('');
      expect(screen.getByRole('status', { name: 'Answering' })).toBeTruthy();
    });

    it('shows the streamed answer beneath the pending question', async () => {
      await sendHeld();

      appEvents.events.next(chunk(0, 'Revenue in Q3 was 12.4M.'));

      const answer = await screen.findByTestId('chat-streaming-answer');
      expect(
        pendingRow()!.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('is replaced by the recorded question, leaving one copy and no "Sending…"', async () => {
      const { settle } = await sendHeld();
      await screen.findByTestId('chat-pending-question');

      settle(q3Exchange());

      expect(await screen.findByText('Revenue in Q3 was 12.4M.')).toBeTruthy();
      expect(screen.getAllByText(ASK)).toHaveLength(1);
      expect(pendingRow()).toBeNull();
      expect(screen.queryByText('Sending…')).toBeNull();
    });

    it('goes when the ask fails, handing the text back to the box beside the error row', async () => {
      const { fail } = await sendHeld();
      await screen.findByTestId('chat-pending-question');

      fail({ error: { message: 'The language model is unavailable.' } });

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText('The language model is unavailable.')).toBeTruthy();
      expect(pendingRow()).toBeNull();
      expect(screen.queryByText('Sending…')).toBeNull();
      expect(questionBox().disabled).toBe(false);
      expect(questionBox().value).toBe(ASK);
    });

    // Story 11: the preview belongs to the Thread it was asked in.
    it('stays with its Chat Thread across a switch', async () => {
      const { settle } = await sendHeld({
        listChatThreads: vi.fn().mockResolvedValue([
          thread(),
          thread({
            id: 'thread-2',
            title: 'Supply chain',
            createdAt: '2025-12-15T00:00:00.000Z',
          }),
        ]),
      });
      await screen.findByTestId('chat-pending-question');

      fireEvent.click(screen.getByRole('button', { name: 'Open Supply chain' }));
      await screen.findByRole('heading', { name: 'Supply chain' });
      await waitFor(() => expect(pendingRow()).toBeNull());
      expect(screen.queryByText(ASK)).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Open Revenue questions' }));
      await screen.findByRole('heading', { name: 'Revenue questions' });
      const row = await screen.findByTestId('chat-pending-question');
      expect(within(row).getByText(ASK)).toBeTruthy();

      settle(q3Exchange());

      expect(await screen.findByText('Revenue in Q3 was 12.4M.')).toBeTruthy();
      expect(screen.getAllByText(ASK)).toHaveLength(1);
      expect(pendingRow()).toBeNull();
    });

    /** "Revenue questions" (opened) and an older "Supply chain" to switch to. */
    const twoThreads = () =>
      vi
        .fn()
        .mockResolvedValue([
          thread(),
          thread({ id: 'thread-2', title: 'Supply chain', createdAt: '2025-12-15T00:00:00.000Z' }),
        ]);

    /** Opens a Thread from the navigator and waits for its header. */
    async function switchTo(title: string) {
      fireEvent.click(screen.getByRole('button', { name: `Open ${title}` }));
      await screen.findByRole('heading', { name: title });
    }

    // Story 7 while away: the text belongs to the Thread it was asked in, so
    // it waits there — not in the open Thread's box, and not lost — and the
    // error row explains it where the question was asked.
    it('keeps the text of a question that failed while another Thread was open, for when its Thread is back', async () => {
      const { fail } = await sendHeld({ listChatThreads: twoThreads() });
      await screen.findByTestId('chat-pending-question');
      await switchTo('Supply chain');

      fail({ error: { message: 'The language model is unavailable.' } });

      await waitFor(() => expect(questionBox().disabled).toBe(false));
      expect(questionBox().value).toBe('');
      expect(screen.queryByRole('alert')).toBeNull();

      await switchTo('Revenue questions');
      await waitFor(() => expect(questionBox().value).toBe(ASK));
      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText('The language model is unavailable.')).toBeTruthy();
      expect(pendingRow()).toBeNull();
    });

    // Switching back re-reads the Thread; if the ask lands while that read
    // is out, the read's older snapshot must not wipe the exchange.
    it('keeps an exchange recorded while its Thread was being re-read', async () => {
      let reread!: (messages: unknown[]) => void;
      let thread1Reads = 0;
      const listChatMessages = vi.fn(({ threadId }: { threadId: string }) => {
        if (threadId === 'thread-1' && ++thread1Reads === 2) {
          return new Promise((resolve) => {
            reread = resolve;
          });
        }
        return Promise.resolve([]);
      });
      const { settle } = await sendHeld({ listChatThreads: twoThreads(), listChatMessages });
      await screen.findByTestId('chat-pending-question');
      await switchTo('Supply chain');
      await switchTo('Revenue questions');
      await waitFor(() => expect(thread1Reads).toBe(2));

      settle(q3Exchange());
      await waitFor(() => expect(screen.queryByRole('status', { name: 'Answering' })).toBeNull());
      // A snapshot taken before the exchange was recorded.
      reread([]);

      expect(await screen.findByText('Revenue in Q3 was 12.4M.')).toBeTruthy();
      expect(screen.getAllByText(ASK)).toHaveLength(1);
    });
  });

  // NBK-81 (spec 07 "Notebook landing", "Asking from the landing",
  // "Placeholder removed"): with no Thread open the Thread card is the
  // Notebook landing — its title and a live composer — and sending from it
  // starts a Chat Thread and asks in it, the sequence NBK-54's starter
  // prompts ran, now the composer's. The prompts and their invitation are gone.
  describe('NBK-81: asking from the landing', () => {
    const INVITATION = 'Ask anything about the Documents in this Notebook';
    const SUMMARIZE = 'Summarize the Documents in this Notebook';

    /** The landing of a Notebook with no Chat Threads, `ASK` typed into its box. */
    async function draftOnTheLanding(overrides: Partial<Record<string, unknown>> = {}) {
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([]) as never,
        listChatMessages: vi.fn().mockResolvedValue([]) as never,
        ...overrides,
      });
      await screen.findByText('No Chat Threads yet.');
      fireEvent.input(questionBox(), { target: { value: ASK } });
    }

    it('shows the Notebook title and an open question box, and nothing else, when no Thread is open', async () => {
      await renderPanel({ listChatThreads: vi.fn().mockResolvedValue([]) as never });
      await screen.findByText('No Chat Threads yet.');

      // The page's Notebooks store is not loaded here, so the title is the
      // fallback the Notebook page shows too.
      const title = screen.getByRole('heading', { name: 'Notebook' });
      expect(within(title).getByRole('button', { name: 'Notebook' })).toBeTruthy();
      expect(questionBox().disabled).toBe(false);
      expect(screen.queryByText(INVITATION)).toBeNull();
      expect(screen.queryByRole('button', { name: SUMMARIZE })).toBeNull();
      expect(screen.queryByTestId('copycat-mark')).toBeNull();
      expect(screen.queryByText('Open or start a Chat Thread to ask')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Back to Notebook' })).toBeNull();
    });

    it('starts a Chat Thread titled "New Chat Thread" and asks the question in it', async () => {
      const createChatThread = vi.fn().mockResolvedValue(thread({ title: 'New Chat Thread' }));
      const sendChatMessage = vi.fn().mockResolvedValue(q3Exchange());
      await draftOnTheLanding({ createChatThread, sendChatMessage });

      fireEvent.click(sendButton());

      expect(await screen.findByText('Revenue in Q3 was 12.4M.')).toBeTruthy();
      expect(createChatThread).toHaveBeenCalledTimes(1);
      expect(createChatThread).toHaveBeenCalledWith({
        notebookId: NOTEBOOK_ID,
        body: { title: 'New Chat Thread' },
      });
      expect(sendChatMessage).toHaveBeenCalledTimes(1);
      expect(sendChatMessage).toHaveBeenCalledWith({
        notebookId: NOTEBOOK_ID,
        threadId: 'thread-1',
        body: { content: ASK },
      });
      // The new Thread is open, with the question, and in the list.
      expect(screen.getByRole('heading', { name: 'New Chat Thread' })).toBeTruthy();
      expect(screen.getByText(ASK)).toBeTruthy();
      const row = screen.getByRole('button', { name: 'Open New Chat Thread' });
      expect(row.getAttribute('aria-current')).toBe('true');
      expect(screen.queryByRole('heading', { name: 'Notebook' })).toBeNull();
    });

    it('shows the question at once as pending in the new Thread, the answer arriving under it', async () => {
      const { sendChatMessage, settle } = heldSend();
      await draftOnTheLanding({
        createChatThread: vi.fn().mockResolvedValue(thread({ title: 'New Chat Thread' })),
        sendChatMessage,
      });

      fireEvent.keyDown(questionBox(), { key: 'Enter' });

      const row = await screen.findByTestId('chat-pending-question');
      expect(within(row).getByText(ASK)).toBeTruthy();
      expect(within(row).getByText('Sending…')).toBeTruthy();
      expect(questionBox().value).toBe('');
      appEvents.events.next(chunk(0, 'Revenue in Q3'));
      expect(await screen.findByTestId('chat-streaming-answer')).toBeTruthy();

      settle(q3Exchange());
      expect(await screen.findByText('Revenue in Q3 was 12.4M.')).toBeTruthy();
    });

    // Story 35: a double click, or Enter then a click, while the Thread is
    // being created must not start a second, empty one — nor ask twice.
    it('starts one Chat Thread however often it is sent while that Thread is created', async () => {
      let created!: (thread: unknown) => void;
      const createChatThread = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          created = resolve;
        }),
      );
      const { sendChatMessage } = heldSend();
      await draftOnTheLanding({ createChatThread, sendChatMessage });

      fireEvent.click(sendButton());
      await waitFor(() => expect(sendButton().disabled).toBe(true));
      expect(questionBox().disabled).toBe(true);
      expect(newThreadButton().disabled).toBe(true);
      fireEvent.click(sendButton());
      fireEvent.keyDown(questionBox(), { key: 'Enter' });
      fireEvent.click(newThreadButton());
      expect(createChatThread).toHaveBeenCalledTimes(1);

      created(thread({ title: 'New Chat Thread' }));

      // And closed again while the question is answered.
      expect(await screen.findByRole('status', { name: 'Answering' })).toBeTruthy();
      expect(questionBox().disabled).toBe(true);
      expect(createChatThread).toHaveBeenCalledTimes(1);
      expect(sendChatMessage).toHaveBeenCalledTimes(1);
    });

    it('keeps the question in the box when the Chat Thread cannot be started', async () => {
      const sendChatMessage = vi.fn();
      await draftOnTheLanding({
        createChatThread: vi
          .fn()
          .mockRejectedValue({ error: { message: 'The database is unavailable.' } }),
        sendChatMessage,
      });

      fireEvent.click(sendButton());

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText('The database is unavailable.')).toBeTruthy();
      expect(sendChatMessage).not.toHaveBeenCalled();
      expect(questionBox().disabled).toBe(false);
      expect(questionBox().value).toBe(ASK);
      expect(screen.getByRole('heading', { name: 'Notebook' })).toBeTruthy();
    });

    // Spec 07: sending stays disabled while a question is being sent, also
    // from the landing the asker went back to — but the landing has no
    // answer on screen, so it must not claim one is being written there.
    it('keeps the landing box closed while a question is answered elsewhere, without the answering state', async () => {
      const { settle } = await sendHeld();
      await screen.findByRole('status', { name: 'Answering' });

      fireEvent.click(screen.getByRole('button', { name: 'Back to Notebook' }));

      await screen.findByRole('heading', { name: 'Notebook' });
      expect(questionBox().disabled).toBe(true);
      expect(sendButton().disabled).toBe(true);
      expect(screen.queryByRole('status', { name: 'Answering' })).toBeNull();
      expect(screen.queryByText('Answering… the box reopens when the answer is in')).toBeNull();
      expect(screen.getByText('You can ask again once the current answer is in')).toBeTruthy();

      settle(q3Exchange());

      await waitFor(() => expect(questionBox().disabled).toBe(false));
      expect(screen.getByText('Enter to send · Shift+Enter for a new line')).toBeTruthy();
    });

    // Story 43: an open Thread with nothing in it is an empty message area,
    // not the old placeholder — and asking there asks in it.
    it('asks in an open empty Thread without starting another', async () => {
      const createChatThread = vi.fn();
      const { sendChatMessage } = await draftAQuestion({ createChatThread });

      expect((await screen.findByTestId('chat-messages')).children).toHaveLength(0);
      expect(screen.queryByText(INVITATION)).toBeNull();
      expect(screen.queryByRole('button', { name: SUMMARIZE })).toBeNull();

      fireEvent.click(sendButton());

      expect(await screen.findByText('Revenue in Q3 was 12.4M.')).toBeTruthy();
      expect(createChatThread).not.toHaveBeenCalled();
      expect(sendChatMessage).toHaveBeenCalledWith({
        notebookId: NOTEBOOK_ID,
        threadId: 'thread-1',
        body: { content: ASK },
      });
    });
  });

  // NBK-83 (spec 07 "Composer"): the Copilot-style pill. Its look is not
  // testable here; what it offers is — the same two controls, nothing the
  // app cannot do, and the caveat under it once answers are on screen.
  describe('NBK-83: pill composer', () => {
    const CAVEAT = 'AI-generated content may be incorrect';

    it('offers the question box and Send, and no attach or microphone control', async () => {
      await draftAQuestion();

      expect(questionBox().getAttribute('placeholder')).toBe('Ask a question about this Notebook…');
      expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
      // Spec 07 story 46: Copilot's "+" and microphone are features this
      // app does not have, so the box must not offer them under any name.
      for (const name of [
        /attach/i,
        /upload/i,
        /^\+$/,
        /^add$/i,
        /microphone/i,
        /voice/i,
        /dictat/i,
      ]) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
    });

    it('shows the AI caveat under the box in an open Thread, and not on the landing', async () => {
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([thread()]) as never,
        listChatMessages: vi.fn().mockResolvedValue([]) as never,
      });
      expect(await screen.findByText(CAVEAT)).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Back to Notebook' }));

      await waitFor(() => expect(screen.queryByText(CAVEAT)).toBeNull());
      expect(questionBox()).toBeTruthy();
    });
  });
});
