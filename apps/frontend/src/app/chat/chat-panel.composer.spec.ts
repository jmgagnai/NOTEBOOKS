import { input } from '@angular/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/angular';
import {
  NOTEBOOK_ID,
  thread,
  message,
  tooltipOf,
  questionBox,
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
  openRevenueQuestions,
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
      const send = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
      expect(send().disabled).toBe(false);

      fireEvent.input(questionBox(), { target: { value: '   ' } });

      // Whitespace is nothing to ask: the same rule `send` applies, shown
      // on the button rather than discovered on click.
      expect(send().disabled).toBe(true);
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
    const originals = {
      scrollTo: HTMLElement.prototype.scrollTo,
      scrollIntoView: HTMLElement.prototype.scrollIntoView,
    };

    // jsdom leaves both unimplemented, so they are stood in for on the
    // prototype; `mock.contexts` then says which element each call was on.
    beforeEach(() => {
      scrollTo = vi.fn();
      scrollIntoView = vi.fn();
      HTMLElement.prototype.scrollTo = scrollTo as never;
      HTMLElement.prototype.scrollIntoView = scrollIntoView as never;
    });

    afterEach(() => {
      HTMLElement.prototype.scrollTo = originals.scrollTo;
      HTMLElement.prototype.scrollIntoView = originals.scrollIntoView;
    });

    /** Every element a scroll call was made on, in call order. */
    const scrolled = (spy: ReturnType<typeof vi.fn>) => spy.mock.contexts as HTMLElement[];

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
    // its place is the same question already in view, so it is not a move.
    it('brings the question just asked into view at the bottom on send, and not again when it is recorded', async () => {
      const { settle } = await askInFlight();

      const pending = pendingRow()!;
      await waitFor(() => expect(scrolled(scrollIntoView)).toEqual([pending]));
      expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'end' }));

      settle(q3Exchange());

      await waitFor(() => expect(pendingRow()).toBeNull());
      await screen.findByText('Revenue in Q3 was 12.4M.');
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    // Story 15d: the reader starts a long answer at its first line. Only the
    // first block moves the view — no following the bottom as it grows, and
    // the recorded answer taking the preview's place is not a move either.
    it("brings the answer's start to the top on its first block, and then leaves the view alone", async () => {
      const { settle } = await askInFlight();
      // The send's own move (rule 2) is the test above's; set it aside.
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      scrollIntoView.mockClear();

      appEvents.events.next(chunk(0, '## Revenue'));

      const answer = await screen.findByTestId('chat-streaming-answer');
      await waitFor(() => expect(scrolled(scrollIntoView)).toEqual([answer]));
      expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));

      appEvents.events.next(chunk(1, 'Revenue in Q3 was 12.4M.'));
      await screen.findByText('Revenue in Q3 was 12.4M.');
      settle(q3Exchange());
      await waitFor(() => expect(screen.queryByTestId('chat-streaming-answer')).toBeNull());
      await screen.findByText('What was revenue in Q3?', { selector: 'p' });

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollTo).not.toHaveBeenCalled();
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

    it('replaces the empty state at once', async () => {
      await sendHeld();

      await screen.findByTestId('chat-pending-question');
      expect(screen.queryByText('Ask anything about the Documents in this Notebook')).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Summarize the Documents in this Notebook' }),
      ).toBeNull();
    });

    it('shows a starter prompt as a pending question', async () => {
      const { sendChatMessage } = heldSend();
      await openRevenueQuestions([], { sendChatMessage });
      await screen.findByText('Ask anything about the Documents in this Notebook');

      fireEvent.click(
        screen.getByRole('button', { name: 'Summarize the Documents in this Notebook' }),
      );

      const row = await screen.findByTestId('chat-pending-question');
      expect(within(row).getByText('Summarize the Documents in this Notebook')).toBeTruthy();
      expect(within(row).getByText('Sending…')).toBeTruthy();
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

  // NBK-54 (spec 04 "Empty state", stories 20–21): with nothing to read, the
  // Thread card offers three static starter prompts instead of a blank pane;
  // activating one asks it, starting a Chat Thread first when none is open.
  describe('NBK-54: empty state', () => {
    const SUMMARIZE = 'Summarize the Documents in this Notebook';
    const PROMPTS = [
      SUMMARIZE,
      'What are the key points across these Documents?',
      'What questions do these Documents answer?',
    ];
    const INVITATION = 'Ask anything about the Documents in this Notebook';

    const prompt = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

    it('offers the three starter prompts when no Thread is open', async () => {
      await renderPanel({ listChatThreads: vi.fn().mockResolvedValue([]) as never });

      expect(await screen.findByText(INVITATION)).toBeTruthy();
      for (const name of PROMPTS) {
        // Keyboard operable: native, enabled buttons in the tab order, so
        // Tab reaches each one and Enter or Space activates it.
        expect(prompt(name).tagName).toBe('BUTTON');
        expect(prompt(name).disabled).toBe(false);
        expect(prompt(name).tabIndex).toBe(0);
      }
      expect(screen.queryByText('Open a Chat Thread, or start one, to ask a question.')).toBeNull();
    });

    // NBK-62 (spec 06 "Empty states"): the cat mark replaces the sparkle
    // above the sentence; the sparkle is left to the assistant's avatar.
    it('shows the cat mark above the sentence instead of the sparkle, hidden from assistive technology', async () => {
      await renderPanel({ listChatThreads: vi.fn().mockResolvedValue([]) as never });

      const sentence = await screen.findByText(INVITATION);
      const mark = screen.getByTestId('copycat-mark') as HTMLImageElement;
      expect(mark.getAttribute('src')).toBe('/copycat-mark.svg');
      expect(mark.alt).toBe('');
      expect(mark.closest('[aria-hidden="true"]')).toBeTruthy();
      expect(
        mark.compareDocumentPosition(sentence) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(document.querySelector('mat-icon[svgicon="sparkle"]')).toBeNull();
    });

    it('gives way to the Chat Thread once the open Thread has messages', async () => {
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([thread()]) as never,
        listChatMessages: vi.fn().mockResolvedValue([message()]) as never,
      });

      expect(await screen.findByText('What was revenue in Q3?')).toBeTruthy();
      expect(screen.queryByText(INVITATION)).toBeNull();
      expect(screen.queryByRole('button', { name: SUMMARIZE })).toBeNull();
    });

    it('starts a Chat Thread when none is open and asks the prompt in it', async () => {
      const createChatThread = vi.fn().mockResolvedValue(thread({ title: 'New Chat Thread' }));
      const sendChatMessage = vi.fn().mockResolvedValue({
        question: message({ id: 'q1', role: 'user', content: SUMMARIZE }),
        answer: message({ id: 'a1', role: 'assistant', content: 'The Documents cover FY26.' }),
      });
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([]) as never,
        createChatThread: createChatThread as never,
        sendChatMessage: sendChatMessage as never,
      });

      await screen.findByText(INVITATION);
      fireEvent.click(prompt(SUMMARIZE));

      expect(await screen.findByText('The Documents cover FY26.')).toBeTruthy();
      expect(createChatThread).toHaveBeenCalledWith({
        notebookId: NOTEBOOK_ID,
        body: { title: 'New Chat Thread' },
      });
      expect(sendChatMessage).toHaveBeenCalledWith({
        notebookId: NOTEBOOK_ID,
        threadId: 'thread-1',
        body: { content: SUMMARIZE },
      });
      expect(screen.getByRole('heading', { name: 'New Chat Thread' })).toBeTruthy();
      expect(screen.queryByText(INVITATION)).toBeNull();
    });

    // A second click while the first create is still pending would start a
    // second, empty Thread: both ways of starting one wait for it.
    it('starts one Chat Thread however often its controls are clicked while it is created', async () => {
      let created!: (thread: unknown) => void;
      const createChatThread = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          created = resolve;
        }),
      );
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([]) as never,
        createChatThread: createChatThread as never,
        sendChatMessage: vi.fn().mockReturnValue(new Promise(() => {})) as never,
      });
      await screen.findByText(INVITATION);
      const newThread = () =>
        screen.getByRole('button', { name: 'New Chat Thread' }) as HTMLButtonElement;

      fireEvent.click(newThread());
      await waitFor(() => expect(newThread().disabled).toBe(true));
      for (const name of PROMPTS) expect(prompt(name).disabled).toBe(true);
      fireEvent.click(newThread());
      fireEvent.click(prompt(SUMMARIZE));
      expect(createChatThread).toHaveBeenCalledTimes(1);

      // Titled otherwise only so its header's rename button is not a second
      // "New Chat Thread" button for the query above.
      created(thread({ title: 'Q3 questions' }));
      await waitFor(() => expect(newThread().disabled).toBe(false));
      expect(createChatThread).toHaveBeenCalledTimes(1);
    });

    // Story 21 with a Thread already open: no second Thread, and the
    // prompts give way to the question they asked (NBK-70), so none can be
    // asked into an answer still being written.
    it('asks the prompt in the open empty Thread, which gives way to it while answering', async () => {
      const { sendChatMessage, settle } = heldSend();
      const createChatThread = vi.fn();
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([thread()]) as never,
        listChatMessages: vi.fn().mockResolvedValue([]) as never,
        createChatThread: createChatThread as never,
        sendChatMessage: sendChatMessage as never,
      });

      await screen.findByRole('heading', { name: 'Revenue questions' });
      await screen.findByText(INVITATION);
      fireEvent.click(prompt(PROMPTS[1]));

      expect(await screen.findByRole('status', { name: 'Answering' })).toBeTruthy();
      expect(createChatThread).not.toHaveBeenCalled();
      expect(sendChatMessage).toHaveBeenCalledWith({
        notebookId: NOTEBOOK_ID,
        threadId: 'thread-1',
        body: { content: PROMPTS[1] },
      });
      expect(within(pendingRow()!).getByText(PROMPTS[1])).toBeTruthy();
      for (const name of PROMPTS) expect(screen.queryByRole('button', { name })).toBeNull();
      expect(sendChatMessage).toHaveBeenCalledTimes(1);

      settle({
        question: message({ id: 'q1', role: 'user', content: PROMPTS[1] }),
        answer: message({ id: 'a1', role: 'assistant', content: 'Lead times fell.' }),
      });

      expect(await screen.findByText('Lead times fell.')).toBeTruthy();
      expect(screen.queryByText(INVITATION)).toBeNull();
    });
  });
});
