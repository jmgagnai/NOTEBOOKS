import { Component, input } from '@angular/core';
import { DeferBlockBehavior, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { ThreadNavigator } from './thread-navigator';
import { ThreadView } from './thread-view';
import { AuthService } from '../api/services/auth.service';
import { AuthStore } from '../auth/auth.store';
import { ChatService } from '../api/services/chat.service';
import { AppEvent, AppEventsService } from '../events/app-events.service';
import { provideAppIcons } from '../shared/fluent-icons';

const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';
const DOCUMENT_ID = '22222222-2222-2222-2222-222222222222';
const VERSION_ID = '33333333-3333-3333-3333-333333333333';
const CHUNK_ID = '44444444-4444-4444-4444-444444444444';

function participant(email: string) {
  return { id: `user-${email}`, email };
}

/**
 * Who is signed in while the panel renders (NBK-70): the asker a pending
 * question is attributed to. Not one of the recorded authors below, so a
 * test can tell the preview's attribution from a recorded message's.
 */
const SIGNED_IN = {
  ...participant('carol.white@example.com'),
  createdAt: '2025-12-01T00:00:00.000Z',
};

function thread(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'thread-1',
    notebookId: NOTEBOOK_ID,
    title: 'Revenue questions',
    author: participant('alice@example.com'),
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function message(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'message-1',
    threadId: 'thread-1',
    role: 'user',
    content: 'What was revenue in Q3?',
    askedBy: participant('alice@example.com'),
    citations: [],
    createdAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

/**
 * A Citation as the backend returns one: the pinned
 * (documentVersionId, chunkId) pair, plus what a reader needs to recognise
 * the source and where in the Converted Markdown it sits.
 */
function citation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'citation-1',
    marker: 1,
    documentId: DOCUMENT_ID,
    documentVersionId: VERSION_ID,
    versionNumber: 1,
    chunkId: CHUNK_ID,
    filename: 'logistics.md',
    headingPath: ['FY26', 'Lead times'],
    charStart: 120,
    charEnd: 167,
    ...overrides,
  };
}

/** The initials avatar beside the message whose author line is the n-th one. */
function avatarOf(messageIndex: number): HTMLElement {
  const row = screen.getAllByTestId('chat-message-author')[messageIndex].closest('li')!;
  return within(row).getByTestId('chat-user-avatar');
}

/**
 * What a tooltip says, read the way assistive technology reads it: Material
 * registers the message as the element's `aria-describedby` target, so the
 * text is reachable without simulating a hover and waiting out its delay.
 */
async function tooltipOf(element: HTMLElement): Promise<string | undefined> {
  await waitFor(() => expect(element.getAttribute('aria-describedby')).toBeTruthy());
  return document.getElementById(element.getAttribute('aria-describedby')!)?.textContent?.trim();
}

/** The question box, however it is currently rendered (enabled or not). */
const questionBox = () => screen.getByLabelText('Ask a question') as HTMLTextAreaElement;

/** The message row (`li`) a message's text sits in. */
function rowOf(text: string): HTMLElement {
  return screen.getByText(text).closest('li')!;
}

/** The scrolling message list a message's text sits in. */
const listOf = (text: string) => screen.getByText(text).closest('ol')!;

/**
 * A `sendChatMessage` whose ask stays in flight until `settle` is called
 * with the recorded exchange (or `fail` with an error), so a test can look
 * at the panel mid-answer.
 */
function heldSend() {
  let settle!: (exchange: unknown) => void;
  let fail!: (error: unknown) => void;
  const sendChatMessage = vi.fn().mockReturnValue(
    new Promise((resolve, reject) => {
      settle = resolve;
      fail = reject;
    }),
  );
  return {
    sendChatMessage,
    settle: (exchange: unknown) => settle(exchange),
    fail: (error: unknown) => fail(error),
  };
}

// A streamed answer's App Events (NBK-11), as the notebook topic carries
// them for thread-1.
const STREAM_ID = '77777777-7777-7777-7777-777777777777';

function appEvent(type: string, data: Record<string, unknown>): AppEvent {
  return {
    id: `event-${type}-${String(data['index'] ?? 'end')}`,
    type,
    topic: `notebook:${NOTEBOOK_ID}`,
    occurredAt: '2026-01-01T00:00:02.000Z',
    data: { notebookId: NOTEBOOK_ID, threadId: 'thread-1', streamId: STREAM_ID, ...data },
  };
}

const chunk = (index: number, text: string, overrides: Record<string, unknown> = {}): AppEvent =>
  appEvent('chat-answer-chunk', { index, text, ...overrides });

const completed = (data: Record<string, unknown> = {}): AppEvent =>
  appEvent('chat-answer-completed', {
    messageId: 'a1',
    questionId: 'q1',
    citations: [],
    ...data,
  });

const failed = (data: Record<string, unknown> = {}): AppEvent =>
  appEvent('chat-answer-failed', { reason: 'the provider hung up', ...data });

/**
 * The chat panel as the Notebook page composes it: the Thread navigator and
 * the Thread view side by side, sharing the root-provided ChatStore.
 *
 * NBK-34 split the one panel component in two so the workspace frame
 * (NBK-35) can place them in different cards; the behaviour under test is
 * the pair's, so this host stands in for the page and every test below is
 * the one that ran against the single component.
 */
@Component({
  selector: 'app-chat-panel-host',
  imports: [ThreadNavigator, ThreadView],
  template: `
    <app-thread-navigator [notebookId]="notebookId()" />
    <app-thread-view [notebookId]="notebookId()" />
  `,
})
class ChatPanelHost {
  readonly notebookId = input.required<string>();
}

// Seam-3 test (per NBK-1's testing decisions, and explicitly called for by
// NBK-10's acceptance criteria): render the real components + SignalStore,
// mocking only the generated ng-openapi-gen client interface (ChatService) —
// never the store or any Angular service internals.
describe('Chat panel (ThreadNavigator + ThreadView)', () => {
  /**
   * Stands in for the live SSE connection a streamed answer arrives on
   * (NBK-11). `AppEventsService` is the seam, not `EventSource`: jsdom has no
   * `EventSource`, and the panel's contract is "events arrive on this
   * stream", not "an HTTP connection is opened in this particular way". That
   * the real service turns a live SSE connection into these events is proven
   * on the backend, by apps/backend/test/events.route.test.ts — and the same
   * stub shape is already used by notebook-detail-page.spec.ts.
   */
  function appEventsStub() {
    const events = new Subject<AppEvent>();
    const topics: string[][] = [];
    return {
      events,
      topics,
      provider: {
        provide: AppEventsService,
        useValue: {
          stream: (requested: string[]) => {
            topics.push(requested);
            return events.asObservable();
          },
        },
      },
    };
  }

  let appEvents: ReturnType<typeof appEventsStub>;

  beforeEach(() => {
    appEvents = appEventsStub();
  });

  async function renderPanel(chatService: Partial<ChatService>) {
    const rendered = await render(ChatPanelHost, {
      inputs: { notebookId: NOTEBOOK_ID },
      // An answer's Markdown renderer is a deferred block loaded on idle
      // (NBK-52); Testing Library would otherwise hold every deferred block
      // at its placeholder, which is not what a reader ever ends up seeing.
      deferBlockBehavior: DeferBlockBehavior.Playthrough,
      // A real router, not a mocked one: a Citation's whole job is to link
      // somewhere, so the link has to be built by the thing that will
      // actually navigate (NBK-1's seam-3 rule — mock the generated HTTP
      // client, never Angular's own services).
      providers: [
        provideRouter([]),
        provideAppIcons(),
        { provide: ChatService, useValue: chatService },
        {
          provide: AuthService,
          useValue: { getCurrentUser: vi.fn().mockResolvedValue(SIGNED_IN) },
        },
        appEvents.provider,
      ],
    });
    // Signed in the way the auth guard signs the app in, before any ask.
    await TestBed.inject(AuthStore).checkSession();
    return rendered;
  }

  /**
   * Renders the panel on the one Thread, "Revenue questions", holding
   * `messages`, and opens it from the navigator. `overrides` replaces any
   * ChatService call, including the two this sets up.
   */
  async function openRevenueQuestions(
    messages: unknown[] = [],
    overrides: Partial<Record<keyof ChatService, unknown>> = {},
  ) {
    const rendered = await renderPanel({
      listChatThreads: vi.fn().mockResolvedValue([thread()]) as never,
      listChatMessages: vi.fn().mockResolvedValue(messages) as never,
      ...(overrides as Partial<ChatService>),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Open Revenue questions' }));
    return rendered;
  }

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

  /** Where a Citation link points, taken apart so param order can't matter. */
  function target(link: Element): { pathname: string; params: Record<string, string> } {
    const url = new URL(link.getAttribute('href')!, 'http://localhost');
    return {
      pathname: url.pathname,
      params: Object.fromEntries(url.searchParams.entries()),
    };
  }

  // NBK-12: "clicking a Citation in the Angular UI opens that exact Document
  // Version, scrolled to that chunk's location". What this panel is
  // responsible for is the *link*: it has to carry the pinned Version and
  // chunk, not the Document alone, or following it lands on whatever is
  // latest — the exact failure GLOSSARY.md's Citation definition rules out.
  describe('Citations', () => {
    it("links each of an answer's Citations to the exact Document Version and chunk it cites", async () => {
      await openRevenueQuestions([
        message({
          id: 'a1',
          role: 'assistant',
          content: 'Lead times lengthened to 14 weeks [1], against revenue of 12.4M [2].',
          citations: [
            citation(),
            citation({
              id: 'citation-2',
              marker: 2,
              filename: 'quarterly.md',
              headingPath: ['FY26', 'Revenue'],
              documentVersionId: '55555555-5555-5555-5555-555555555555',
              versionNumber: 3,
              chunkId: '66666666-6666-6666-6666-666666666666',
              charStart: 0,
              charEnd: 24,
            }),
          ],
        }),
      ]);

      // Each source is named by its filename and the heading path of the
      // chunk — per NBK-12 a Citation's display name derives from that, which
      // is why no label travels over the API.
      const first = await screen.findByRole('link', {
        name: /logistics\.md.*FY26 > Lead times/,
      });
      const second = screen.getByRole('link', { name: /quarterly\.md.*FY26 > Revenue/ });

      expect(target(first)).toEqual({
        pathname: `/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`,
        // The pinned Version, the pinned chunk, and the chunk's character
        // range — everything "open that exact Version at that location"
        // needs, and nothing that would be re-resolved to the latest Version.
        params: { version: VERSION_ID, chunk: CHUNK_ID, from: '120', to: '167' },
      });
      expect(target(second)).toEqual({
        pathname: `/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`,
        params: {
          version: '55555555-5555-5555-5555-555555555555',
          chunk: '66666666-6666-6666-6666-666666666666',
          from: '0',
          to: '24',
        },
      });
    });

    it('turns each source marker in the prose into a link to the Chunk it cites', async () => {
      await openRevenueQuestions([
        message({
          id: 'a1',
          role: 'assistant',
          content: 'Lead times lengthened to 14 weeks [1].',
          citations: [citation()],
        }),
      ]);

      // The marker a reader sees mid-sentence is itself the way into the
      // source, so it is a link to the same pinned location.
      const marker = await screen.findByRole('link', { name: 'Citation 1' });
      // A chip showing the number alone (spec 04 "Citation chips", NBK-52).
      expect(marker.textContent?.trim()).toBe('1');
      expect(target(marker)).toEqual({
        pathname: `/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`,
        params: { version: VERSION_ID, chunk: CHUNK_ID, from: '120', to: '167' },
      });

      // The prose either side of the marker survives unchanged.
      expect(screen.getByText(/Lead times lengthened to 14 weeks/)).toBeTruthy();
    });

    it('leaves a marker the answer has no Citation for as plain text', async () => {
      await openRevenueQuestions([
        message({
          id: 'a1',
          role: 'assistant',
          // [4] is a marker the backend could not resolve to a retrieved
          // Chunk, so it was dropped rather than written — and must not
          // become a link to nowhere.
          content: 'Lead times lengthened [1]. Margins improved [4].',
          citations: [citation()],
        }),
      ]);

      expect(await screen.findByRole('link', { name: 'Citation 1' })).toBeTruthy();
      expect(screen.queryByRole('link', { name: 'Citation 4' })).toBeNull();
      // Still shown, because it is what the answer says.
      expect(screen.getByText(/Margins improved \[4\]/)).toBeTruthy();
    });

    it('shows no sources for a question, or for an answer that cited nothing', async () => {
      await openRevenueQuestions([
        message({ id: 'q1', role: 'user', content: 'How long are lead times?' }),
        message({
          id: 'a1',
          role: 'assistant',
          content: 'The sources do not say.',
          citations: [],
        }),
      ]);

      expect(await screen.findByText('The sources do not say.')).toBeTruthy();
      expect(screen.queryAllByTestId('chat-citation')).toEqual([]);
    });
  });

  // NBK-11's third acceptance criterion: "Angular chat UI renders the answer
  // progressively as chunks arrive". The chunks arrive as App Events on the
  // same generic SSE stream a Document's status changes arrive on (NBK-6),
  // because per ADR-0004 that channel was built generic for exactly this.
  describe('a streamed answer (NBK-11)', () => {
    /**
     * Opens a Thread with an ask in flight, handing back the resolver for the
     * `POST .../messages` call.
     *
     * The ask is deliberately left unresolved: the whole user story is that a
     * reader "start[s] reading before the full answer finishes generating",
     * so every assertion about progressive rendering has to be made while
     * the request that produces the answer is still outstanding.
     */
    async function askWithoutAnswering() {
      const { sendChatMessage, settle } = heldSend();
      await openRevenueQuestions([], { sendChatMessage });
      await screen.findByText('Ask anything about the Documents in this Notebook');
      fireEvent.input(questionBox(), { target: { value: 'What was revenue in Q3?' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      return { settle };
    }

    it('renders each chunk as it arrives, and replaces the preview with the recorded answer', async () => {
      const { settle } = await askWithoutAnswering();

      // The panel asked for this Notebook's topic — the same stream the
      // Document status badges follow, not a chat-specific one.
      expect(appEvents.topics).toContainEqual([`notebook:${NOTEBOOK_ID}`]);

      appEvents.events.next(chunk(0, '## Revenue'));

      // Readable already, with the answer still being generated — and
      // through the same Markdown path as a recorded answer (NBK-52).
      expect(await screen.findByRole('heading', { name: 'Revenue' })).toBeTruthy();
      // And only as far as the model has got: the second paragraph has not
      // been sent yet, so it is not on screen.
      expect(screen.queryByText('Revenue reached 12.4M in Q3.')).toBeNull();

      appEvents.events.next(chunk(1, 'Revenue reached 12.4M in Q3.'));
      expect(await screen.findByText('Revenue reached 12.4M in Q3.')).toBeTruthy();
      // The first chunk is still there: chunks accumulate into one answer
      // rather than replacing each other.
      expect(screen.getByRole('heading', { name: 'Revenue' })).toBeTruthy();

      // The ask resolves with the recorded exchange — which is the truth
      // (GLOSSARY.md: a client re-reads the truth over the normal API), so
      // the preview gives way to the two persisted messages rather than
      // leaving a third, duplicate copy of the answer on screen.
      appEvents.events.next(completed());
      settle({
        question: message({ id: 'q1', role: 'user', content: 'What was revenue in Q3?' }),
        answer: message({
          id: 'a1',
          role: 'assistant',
          content: '## Revenue\n\nRevenue reached 12.4M in Q3.',
        }),
      });

      await waitFor(() => {
        expect(screen.queryByTestId('chat-streaming-answer')).toBeNull();
      });
      expect(screen.getAllByTestId('chat-message-author')).toHaveLength(2);
    });

    // Citations resolve from the markers in the *complete* text, so they
    // cannot travel with any chunk — they arrive with the completion event
    // (NBK-11), in the same shape the non-streaming response returns.
    it("shows the answer's Citations as soon as the completion event carries them", async () => {
      await askWithoutAnswering();

      appEvents.events.next(chunk(0, 'Lead times lengthened to 14 weeks [1].'));
      expect(await screen.findByText(/Lead times lengthened to 14 weeks/)).toBeTruthy();
      // Nothing to link to yet, so the marker stays plain text.
      expect(screen.queryByRole('link', { name: 'Citation 1' })).toBeNull();

      appEvents.events.next(completed({ citations: [citation()] }));

      const preview = await screen.findByTestId('chat-streaming-answer');
      expect(within(preview).getByRole('link', { name: 'Citation 1' })).toBeTruthy();
      expect(within(preview).getByTestId('chat-citation')).toBeTruthy();
    });

    // A stream that dies partway leaves prose that will never be persisted,
    // so the preview has to go: leaving it up would show a reader an answer
    // that no re-read of the Thread will ever contain.
    it('drops the preview when the answer fails partway', async () => {
      await askWithoutAnswering();

      appEvents.events.next(chunk(0, '## Revenue'));
      expect(await screen.findByRole('heading', { name: 'Revenue' })).toBeTruthy();

      appEvents.events.next(failed());

      await waitFor(() => {
        expect(screen.queryByTestId('chat-streaming-answer')).toBeNull();
      });
    });

    // The case the GLOSSARY's App Event rule is about: this client was not
    // connected when the answer started — someone else asked, or the
    // EventSource reconnected mid-answer — and NOTIFY has no replay. Showing
    // an answer with its opening missing would be worse than showing none,
    // so it renders nothing and re-reads the Thread when the answer lands.
    it('renders nothing for a stream it joined mid-answer, and re-reads the Thread instead', async () => {
      const listChatMessages = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          message({ id: 'q1', role: 'user', content: 'What was revenue in Q3?' }),
          message({ id: 'a1', role: 'assistant', content: 'Revenue reached 12.4M in Q3.' }),
        ]);

      await openRevenueQuestions([], { listChatMessages });
      await screen.findByText('Ask anything about the Documents in this Notebook');

      // The first chunk this client sees is the third one of the answer.
      appEvents.events.next(chunk(2, 'and the trend is upward.'));
      expect(screen.queryByText('and the trend is upward.')).toBeNull();
      expect(screen.queryByTestId('chat-streaming-answer')).toBeNull();

      appEvents.events.next(completed());

      // Re-read over the normal API, and the whole answer appears.
      expect(await screen.findByText('Revenue reached 12.4M in Q3.')).toBeTruthy();
      expect(listChatMessages).toHaveBeenCalledTimes(2);
    });

    it("ignores another Chat Thread's streamed answer", async () => {
      await askWithoutAnswering();

      appEvents.events.next(chunk(0, 'An answer in some other Thread.', { threadId: 'thread-2' }));

      await waitFor(() => {
        expect(screen.queryByText('An answer in some other Thread.')).toBeNull();
      });
    });
  });

  // Spec 04 "Message rendering": questions read as speech, answers as the
  // page's prose. The tests check the parts a reader relies on to tell the
  // two apart and to know who asked — never the colours or alignment.
  describe('NBK-44: message rendering', () => {
    /** Opens one question and its answer, both asked by Jane Doe. */
    async function openExchange() {
      await openRevenueQuestions([
        message({
          id: 'q1',
          role: 'user',
          content: 'What was revenue in Q3?',
          askedBy: participant('jane.doe@example.com'),
        }),
        message({
          id: 'a1',
          role: 'assistant',
          content: 'Revenue in Q3 was 12.4M.',
          askedBy: participant('jane.doe@example.com'),
        }),
      ]);
      await screen.findByText('Revenue in Q3 was 12.4M.');
    }

    it("shows a question beside the asker's initials avatar and an answer beside the sparkle avatar", async () => {
      await openExchange();

      const question = rowOf('What was revenue in Q3?');
      expect(within(question).getByTestId('chat-user-avatar').textContent?.trim()).toBe('JD');
      expect(within(question).queryByTestId('chat-assistant-avatar')).toBeNull();

      const answer = rowOf('Revenue in Q3 was 12.4M.');
      expect(within(answer).getByTestId('chat-assistant-avatar')).toBeTruthy();
      expect(within(answer).queryByTestId('chat-user-avatar')).toBeNull();
      expect(within(answer).getByTestId('chat-message-author').textContent?.trim()).toBe(
        'Assistant',
      );
    });

    // The e-mail is still there for whoever needs it exactly — on the avatar
    // — but a shared Thread must not read as a column of addresses.
    it('keeps the full e-mail off every message line, in the avatar tooltip only', async () => {
      await openExchange();

      const list = rowOf('What was revenue in Q3?').parentElement!;
      expect(within(list).queryByText(/@example\.com/)).toBeNull();
      expect(await tooltipOf(avatarOf(0))).toBe('jane.doe@example.com');
    });
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

  // NBK-45 (spec 04 "Composer" / "Answering state"): the question box as a
  // chat composer — Enter sends, the box closes while the backend answers
  // and reopens focused, and an error is a dismissible row above it.
  describe('NBK-45: composer', () => {
    const ASK = 'What was revenue in Q3?';

    /**
     * Opens the Thread with no messages and types a question, so each test
     * below starts from a draft ready to send. Waits on the box itself
     * rather than on the empty-state copy, which another ticket rewrites.
     */
    async function draftAQuestion(overrides: Partial<ChatService> = {}) {
      const sendChatMessage = vi.fn().mockResolvedValue({
        question: message({ id: 'q1', role: 'user', content: ASK }),
        answer: message({ id: 'a1', role: 'assistant', content: 'Revenue in Q3 was 12.4M.' }),
      });
      await openRevenueQuestions([], { sendChatMessage, ...overrides });
      await waitFor(() => expect(questionBox().disabled).toBe(false));
      fireEvent.input(questionBox(), { target: { value: ASK } });
      return { sendChatMessage };
    }

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
      let settle!: (exchange: unknown) => void;
      const sendChatMessage = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          settle = resolve;
        }),
      );
      await draftAQuestion({ sendChatMessage: sendChatMessage as never });

      fireEvent.keyDown(questionBox(), { key: 'Enter' });

      expect(await screen.findByRole('status', { name: 'Answering' })).toBeTruthy();
      expect(questionBox().disabled).toBe(true);
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
      expect(screen.getByText('Answering… the box reopens when the answer is in')).toBeTruthy();
      // Enter while closed is nothing: no second ask goes out.
      fireEvent.keyDown(questionBox(), { key: 'Enter' });
      expect(sendChatMessage).toHaveBeenCalledTimes(1);

      settle({
        question: message({ id: 'q1', role: 'user', content: ASK }),
        answer: message({ id: 'a1', role: 'assistant', content: 'Revenue in Q3 was 12.4M.' }),
      });

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
      await draftAQuestion({ sendChatMessage: sendChatMessage as never });

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
      await openRevenueQuestions(
        [
          message({ id: 'q0', content: 'What was revenue in Q2?' }),
          message({ id: 'a0', role: 'assistant', content: 'Revenue in Q2 was 11.9M.' }),
        ],
        { sendChatMessage },
      );
      const box = questionBox();
      await waitFor(() => expect(box.disabled).toBe(false));
      await waitFor(() => expect(scrollTo).toHaveBeenCalled());
      scrollTo.mockClear();
      scrollIntoView.mockClear();

      fireEvent.input(box, { target: { value: 'What was revenue in Q3?' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      await screen.findByRole('status', { name: 'Answering' });
      return { settle };
    }

    /** The exchange the in-flight ask resolves with. */
    const q3Exchange = () => ({
      question: message({ id: 'q1', content: 'What was revenue in Q3?' }),
      answer: message({
        id: 'a1',
        role: 'assistant',
        content: '## Revenue\n\nRevenue in Q3 was 12.4M.',
      }),
    });

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

      const pending = screen.getByTestId('chat-pending-question');
      await waitFor(() => expect(scrolled(scrollIntoView)).toEqual([pending]));
      expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'end' }));

      settle(q3Exchange());

      await waitFor(() => expect(screen.queryByTestId('chat-pending-question')).toBeNull());
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
    const ASK = 'What was revenue in Q3?';

    /** The recorded exchange the held ask resolves with. */
    const exchange = () => ({
      question: message({ id: 'q1', content: ASK }),
      answer: message({ id: 'a1', role: 'assistant', content: 'Revenue in Q3 was 12.4M.' }),
    });

    /**
     * Opens thread-1, empty, and sends `ASK` with the ask held open, handing
     * back the held send.
     */
    async function sendHeld(overrides: Partial<Record<keyof ChatService, unknown>> = {}) {
      const held = heldSend();
      await openRevenueQuestions([], { sendChatMessage: held.sendChatMessage, ...overrides });
      await waitFor(() => expect(questionBox().disabled).toBe(false));
      fireEvent.input(questionBox(), { target: { value: ASK } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      return held;
    }

    /** The pending question's row, while there is one. */
    const pendingRow = () => screen.queryByTestId('chat-pending-question');

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

      settle(exchange());

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

      settle(exchange());

      expect(await screen.findByText('Revenue in Q3 was 12.4M.')).toBeTruthy();
      expect(screen.getAllByText(ASK)).toHaveLength(1);
      expect(pendingRow()).toBeNull();
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
      let settle!: (exchange: unknown) => void;
      const sendChatMessage = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          settle = resolve;
        }),
      );
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
      expect(
        within(screen.getByTestId('chat-pending-question')).getByText(PROMPTS[1]),
      ).toBeTruthy();
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

  // Spec 04 "Markdown with Citations": an answer is Markdown, and its
  // markers are swapped for links before parsing so they survive inside
  // headings, list items and table cells. The renderer arrives in a deferred
  // chunk, so every assertion waits on the rendered element itself.
  describe('NBK-52: Markdown answers', () => {
    const TABLE_ANSWER = [
      '## Lead times',
      '',
      '| Quarter | Weeks |',
      '| --- | --- |',
      '| Q3 | 14 [1] |',
    ].join('\n');

    it('renders an answer as Markdown, with a marker in a table cell still a Citation link', async () => {
      await openRevenueQuestions([
        message({ id: 'a1', role: 'assistant', content: TABLE_ANSWER, citations: [citation()] }),
      ]);

      expect(await screen.findByRole('heading', { name: 'Lead times' })).toBeTruthy();
      const cell = await screen.findByRole('cell', { name: /14/ });
      const marker = within(cell).getByRole('link', { name: 'Citation 1' });
      expect(target(marker)).toEqual({
        pathname: `/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`,
        params: { version: VERSION_ID, chunk: CHUNK_ID, from: '120', to: '167' },
      });
    });
    // The rendered marker is a plain `<a href>` from `[innerHTML]`, not a
    // `routerLink`: left to the browser, following it would reload the app.
    it('follows a chip in the rendered Markdown through the router', async () => {
      await openRevenueQuestions([
        message({ id: 'a1', role: 'assistant', content: TABLE_ANSWER, citations: [citation()] }),
      ]);
      const router = TestBed.inject(Router);
      router.resetConfig([{ path: '**', children: [] }]);

      const cell = await screen.findByRole('cell', { name: /14/ });
      const marker = await within(cell).findByRole('link', { name: 'Citation 1' });

      // Not prevented would mean the browser goes on to load the href itself.
      expect(fireEvent.click(marker)).toBe(false);
      await waitFor(() => expect(router.url).toBe(marker.getAttribute('href')));
      expect(target(marker).params).toEqual({
        version: VERSION_ID,
        chunk: CHUNK_ID,
        from: '120',
        to: '167',
      });
    });

    // Spec 04 "Citation chips": the tooltip says which Document and which
    // Version, nothing more; the heading path stays in the group chip's
    // accessible name, where a screen reader still gets it.
    it('titles every chip "<filename> (v<n>)", in the prose and in the groups', async () => {
      await openRevenueQuestions([
        message({ id: 'a1', role: 'assistant', content: TABLE_ANSWER, citations: [citation()] }),
      ]);

      const cell = await screen.findByRole('cell', { name: /14/ });
      const inProse = within(cell).getByRole('link', { name: 'Citation 1' });
      const inGroup = screen.getByTestId('chat-citation');
      expect(inProse.getAttribute('title')).toBe('logistics.md (v1)');
      expect(inGroup.getAttribute('title')).toBe('logistics.md (v1)');
      expect(inGroup.getAttribute('aria-label')).toBe(
        'Citation 1: logistics.md — FY26 > Lead times',
      );
    });

    // Story 12: four Citations into one Document are one line, not four.
    const BRIDGE_VERSION = '88888888-8888-8888-8888-888888888888';
    const bridge = (marker: number, overrides: Partial<Record<string, unknown>> = {}) =>
      citation({
        id: `bridge-${marker}`,
        marker,
        documentVersionId: BRIDGE_VERSION,
        chunkId: `chunk-${marker}`,
        filename: 'leblanc_the_bridge.pdf',
        headingPath: [],
        ...overrides,
      });

    /** The rows under an answer: one per Document Version it cites. */
    const citationGroups = () =>
      within(screen.getByRole('list', { name: 'Citations' })).getAllByRole('listitem');

    it('groups the Citations into one Document Version on one row, chips ascending', async () => {
      await openRevenueQuestions([
        message({
          id: 'a1',
          role: 'assistant',
          content: 'The bridge opened in 1890 [10][1], was widened [12] and repaired [8].',
          // Deliberately out of order: the row sorts them, not the backend.
          citations: [bridge(10), bridge(1), bridge(12), bridge(8)],
        }),
      ]);

      await screen.findByRole('list', { name: 'Citations' });
      const [row, ...others] = citationGroups();
      expect(others).toEqual([]);
      expect(within(row).getByText('leblanc_the_bridge.pdf')).toBeTruthy();
      expect(within(row).getByText('v1')).toBeTruthy();

      const chips = screen.getAllByTestId('chat-citation');
      expect(chips).toHaveLength(4);
      expect(chips.every((chip) => row.contains(chip))).toBe(true);
      expect(chips.map((chip) => chip.textContent?.trim())).toEqual(['1', '8', '10', '12']);
      // Each chip still opens its own Chunk.
      expect(target(chips[2]).params).toMatchObject({
        version: BRIDGE_VERSION,
        chunk: 'chunk-10',
      });
    });

    // Story 13: a Citation into a superseded Version is its own row, so the
    // reader sees the answer was grounded in the older text.
    it('gives each cited Version of a Document its own row, named by its number', async () => {
      await openRevenueQuestions([
        message({
          id: 'a1',
          role: 'assistant',
          content: 'It opened in 1890 [1] and was widened in 1932 [2].',
          citations: [
            bridge(1),
            bridge(2, {
              documentVersionId: '99999999-9999-9999-9999-999999999999',
              versionNumber: 3,
            }),
          ],
        }),
      ]);

      await screen.findByRole('list', { name: 'Citations' });
      const rows = citationGroups();
      expect(rows).toHaveLength(2);
      expect(within(rows[0]).getByText('v1')).toBeTruthy();
      expect(within(rows[1]).getByText('v3')).toBeTruthy();
      expect(within(rows[1]).getByTestId('chat-citation').textContent?.trim()).toBe('2');
    });
  });
});
