import { Component, input } from '@angular/core';
import { provideRouter } from '@angular/router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { ThreadNavigator } from './thread-navigator';
import { ThreadView } from './thread-view';
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
    return render(ChatPanelHost, {
      inputs: { notebookId: NOTEBOOK_ID },
      // A real router, not a mocked one: a Citation's whole job is to link
      // somewhere, so the link has to be built by the thing that will
      // actually navigate (NBK-1's seam-3 rule — mock the generated HTTP
      // client, never Angular's own services).
      providers: [
        provideRouter([]),
        provideAppIcons(),
        { provide: ChatService, useValue: chatService },
        appEvents.provider,
      ],
    });
  }

  it('shows an empty state when the Notebook has no Chat Threads', async () => {
    await renderPanel({ listChatThreads: vi.fn().mockResolvedValue([]) as never });

    expect(await screen.findByText('No Chat Threads yet.')).toBeTruthy();
  });

  // NBK-10: "list every thread in a Notebook regardless of who started it".
  // Per GLOSSARY.md a Thread is "visible to every user who opens the
  // Notebook" — so the list must show other people's Threads, and say whose
  // they are.
  it('lists every Thread with its author, whoever started it', async () => {
    const listChatThreads = vi.fn().mockResolvedValue([
      thread({
        id: 'thread-1',
        title: 'Alice asks about revenue',
        author: participant('alice@example.com'),
      }),
      thread({
        id: 'thread-2',
        title: 'Bob asks about risk',
        author: participant('bob@example.com'),
      }),
    ]);

    await renderPanel({ listChatThreads: listChatThreads as never });

    expect(await screen.findByText('Alice asks about revenue')).toBeTruthy();
    expect(screen.getByText('Bob asks about risk')).toBeTruthy();
    // Attribution, so a reader picking up someone else's line of questioning
    // knows whose it was.
    expect(screen.getByText('Started by alice@example.com')).toBeTruthy();
    expect(screen.getByText('Started by bob@example.com')).toBeTruthy();
    expect(listChatThreads).toHaveBeenCalledWith({ notebookId: NOTEBOOK_ID });
  });

  it('starts a new Chat Thread and adds it to the list', async () => {
    const listChatThreads = vi.fn().mockResolvedValue([]);
    const createChatThread = vi.fn().mockResolvedValue(thread({ title: 'Supply chain' }));
    const listChatMessages = vi.fn().mockResolvedValue([]);

    await renderPanel({
      listChatThreads: listChatThreads as never,
      createChatThread: createChatThread as never,
      listChatMessages: listChatMessages as never,
    });

    await screen.findByText('No Chat Threads yet.');

    fireEvent.input(screen.getByLabelText('New Chat Thread title'), {
      target: { value: 'Supply chain' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start Chat Thread' }));

    expect(createChatThread).toHaveBeenCalledWith({
      notebookId: NOTEBOOK_ID,
      body: { title: 'Supply chain' },
    });
    // It joins the list, and opens — the point of starting one is to ask in
    // it. (The title shows in both places, hence the role-scoped queries.)
    expect(await screen.findByRole('button', { name: 'Open Supply chain' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Supply chain' })).toBeTruthy();
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
    // what — that is the whole point of recording it (ADR-0001).
    const askers = screen.getAllByTestId('chat-message-author').map((el) => el.textContent?.trim());
    expect(askers).toEqual([
      'alice@example.com',
      'Assistant, for alice@example.com',
      'bob@example.com',
    ]);
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
    await screen.findByText('No messages yet.');

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

    const renameInput = await screen.findByLabelText('Rename Chat Thread');
    fireEvent.input(renameInput, { target: { value: 'Q3 revenue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

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

  // NBK-12: "clicking a Citation in the Angular UI opens that exact Document
  // Version, scrolled to that chunk's location". What this panel is
  // responsible for is the *link*: it has to carry the pinned Version and
  // chunk, not the Document alone, or following it lands on whatever is
  // latest — the exact failure GLOSSARY.md's Citation definition rules out.
  describe('Citations', () => {
    /** Where a Citation link points, taken apart so param order can't matter. */
    function target(link: Element): { pathname: string; params: Record<string, string> } {
      const url = new URL(link.getAttribute('href')!, 'http://localhost');
      return {
        pathname: url.pathname,
        params: Object.fromEntries(url.searchParams.entries()),
      };
    }

    async function openThreadWithAnswer(messages: unknown[]) {
      const listChatThreads = vi.fn().mockResolvedValue([thread()]);
      const listChatMessages = vi.fn().mockResolvedValue(messages);
      const rendered = await renderPanel({
        listChatThreads: listChatThreads as never,
        listChatMessages: listChatMessages as never,
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Open Revenue questions' }));
      return rendered;
    }

    it("links each of an answer's Citations to the exact Document Version and chunk it cites", async () => {
      await openThreadWithAnswer([
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
      await openThreadWithAnswer([
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
      expect(marker.textContent).toContain('[1]');
      expect(target(marker)).toEqual({
        pathname: `/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`,
        params: { version: VERSION_ID, chunk: CHUNK_ID, from: '120', to: '167' },
      });

      // The prose either side of the marker survives unchanged.
      expect(screen.getByText(/Lead times lengthened to 14 weeks/)).toBeTruthy();
    });

    it('leaves a marker the answer has no Citation for as plain text', async () => {
      await openThreadWithAnswer([
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
      await openThreadWithAnswer([
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

    const chunk = (
      index: number,
      text: string,
      overrides: Record<string, unknown> = {},
    ): AppEvent => appEvent('chat-answer-chunk', { index, text, ...overrides });

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
     * Opens a Thread with an ask in flight, handing back the resolver for the
     * `POST .../messages` call.
     *
     * The ask is deliberately left unresolved: the whole user story is that a
     * reader "start[s] reading before the full answer finishes generating",
     * so every assertion about progressive rendering has to be made while
     * the request that produces the answer is still outstanding.
     */
    async function askWithoutAnswering(overrides: Partial<ChatService> = {}) {
      let settle!: (exchange: unknown) => void;
      const sendChatMessage = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          settle = resolve;
        }),
      );
      const listChatMessages = vi.fn().mockResolvedValue([]);

      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([thread()]) as never,
        listChatMessages: listChatMessages as never,
        sendChatMessage: sendChatMessage as never,
        ...overrides,
      });

      fireEvent.click(await screen.findByRole('button', { name: 'Open Revenue questions' }));
      await screen.findByText('No messages yet.');
      fireEvent.input(screen.getByLabelText('Ask a question'), {
        target: { value: 'What was revenue in Q3?' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      return { settle, listChatMessages };
    }

    it('renders each chunk as it arrives, and replaces the preview with the recorded answer', async () => {
      const { settle } = await askWithoutAnswering();

      // The panel asked for this Notebook's topic — the same stream the
      // Document status badges follow, not a chat-specific one.
      expect(appEvents.topics).toContainEqual([`notebook:${NOTEBOOK_ID}`]);

      appEvents.events.next(chunk(0, '## Revenue'));

      // Readable already, with the answer still being generated.
      expect(await screen.findByText('## Revenue')).toBeTruthy();
      // And only as far as the model has got: the second paragraph has not
      // been sent yet, so it is not on screen.
      expect(screen.queryByText('Revenue reached 12.4M in Q3.')).toBeNull();

      appEvents.events.next(chunk(1, 'Revenue reached 12.4M in Q3.'));
      expect(await screen.findByText('Revenue reached 12.4M in Q3.')).toBeTruthy();
      // The first chunk is still there: chunks accumulate into one answer
      // rather than replacing each other.
      expect(screen.getByText('## Revenue')).toBeTruthy();

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
      expect(await screen.findByText('## Revenue')).toBeTruthy();

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

      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([thread()]) as never,
        listChatMessages: listChatMessages as never,
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Open Revenue questions' }));
      await screen.findByText('No messages yet.');

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

  // NBK-45 (spec 04 "Composer" / "Answering state"): the question box as a
  // chat composer — Enter sends, the box closes while the backend answers
  // and reopens focused, and an error is a dismissible row above it.
  describe('NBK-45: composer', () => {
    const ASK = 'What was revenue in Q3?';

    /** The question box, however it is currently rendered (enabled or not). */
    const questionBox = () => screen.getByLabelText('Ask a question') as HTMLTextAreaElement;

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
      await renderPanel({
        listChatThreads: vi.fn().mockResolvedValue([thread()]) as never,
        listChatMessages: vi.fn().mockResolvedValue([]) as never,
        sendChatMessage: sendChatMessage as never,
        ...overrides,
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Open Revenue questions' }));
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
    it('shows a failed ask as an error row above the box, dismissible, with the draft kept', async () => {
      await draftAQuestion({
        sendChatMessage: vi
          .fn()
          .mockRejectedValue({ error: { message: 'The language model is unavailable.' } }) as never,
      });

      fireEvent.keyDown(questionBox(), { key: 'Enter' });

      const row = await screen.findByRole('alert');
      expect(within(row).getByText('The language model is unavailable.')).toBeTruthy();
      expect(questionBox().disabled).toBe(false);
      expect(questionBox().value).toBe(ASK);

      fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));

      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(questionBox().value).toBe(ASK);
    });
  });
});
