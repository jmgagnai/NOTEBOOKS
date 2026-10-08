import { Component, inject, input, OnDestroy, OnInit } from '@angular/core';
import { DeferBlockBehavior, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { ChatStore } from './chat.store';
import { ThreadNavigator } from './thread-navigator';
import { ThreadView } from './thread-view';
import { AuthService } from '../api/services/auth.service';
import { AuthStore } from '../auth/auth.store';
import { ChatService } from '../api/services/chat.service';
import { NotebooksService } from '../api/services/notebooks.service';
import { AppEvent, AppEventsService } from '../events/app-events.service';
import { provideAppIcons } from '../shared/fluent-icons';

export const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';
export const DOCUMENT_ID = '22222222-2222-2222-2222-222222222222';
export const VERSION_ID = '33333333-3333-3333-3333-333333333333';
export const CHUNK_ID = '44444444-4444-4444-4444-444444444444';

export function participant(email: string) {
  return { id: `user-${email}`, email };
}

/**
 * Who is signed in while the panel renders (NBK-70): the asker a pending
 * question is attributed to. Not one of the recorded authors below, so a
 * test can tell the preview's attribution from a recorded message's.
 */
export const SIGNED_IN = {
  ...participant('carol.white@example.com'),
  createdAt: '2025-12-01T00:00:00.000Z',
};

export function thread(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'thread-1',
    notebookId: NOTEBOOK_ID,
    title: 'Revenue questions',
    author: participant('alice@example.com'),
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function message(overrides: Partial<Record<string, unknown>> = {}) {
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
export function citation(overrides: Partial<Record<string, unknown>> = {}) {
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
export function avatarOf(messageIndex: number): HTMLElement {
  const row = screen.getAllByTestId('chat-message-author')[messageIndex].closest('li')!;
  return within(row).getByTestId('chat-user-avatar');
}

/**
 * What a tooltip says, read the way assistive technology reads it: Material
 * registers the message as the element's `aria-describedby` target, so the
 * text is reachable without simulating a hover and waiting out its delay.
 */
export async function tooltipOf(element: HTMLElement): Promise<string | undefined> {
  await waitFor(() => expect(element.getAttribute('aria-describedby')).toBeTruthy());
  return document.getElementById(element.getAttribute('aria-describedby')!)?.textContent?.trim();
}

/** The question box, however it is currently rendered (enabled or not). */
export const questionBox = () => screen.getByLabelText('Ask a question') as HTMLTextAreaElement;

/** The composer's Send button, while the box is not answering. */
export const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;

/** The navigator's "New Chat Thread" button. */
export const newThreadButton = () =>
  screen.getByRole('button', { name: 'New Chat Thread' }) as HTMLButtonElement;

/** The question most tests ask, and the exchange that records it. */
export const ASK = 'What was revenue in Q3?';
export const q3Exchange = () => ({
  question: message({ id: 'q1', content: ASK }),
  answer: message({ id: 'a1', role: 'assistant', content: 'Revenue in Q3 was 12.4M.' }),
});

/** The pending question's row (NBK-70), while there is one. */
export const pendingRow = () => screen.queryByTestId('chat-pending-question');

/** The message row (`li`) a message's text sits in. */
export function rowOf(text: string): HTMLElement {
  return screen.getByText(text).closest('li')!;
}

/** The scrolling message list a message's text sits in. */
export const listOf = (text: string) => screen.getByText(text).closest('ol')!;

/**
 * Stands in for `scrollTo` and `scrollIntoView`, which jsdom leaves
 * unimplemented, on the prototype (NBK-53); `mock.contexts` then says which
 * element each call was on. Call in `beforeEach`, `restore` in `afterEach`.
 */
export function stubScrolling() {
  const originals = {
    scrollTo: HTMLElement.prototype.scrollTo,
    scrollIntoView: HTMLElement.prototype.scrollIntoView,
  };
  const scrollTo = vi.fn();
  const scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = scrollTo as never;
  HTMLElement.prototype.scrollIntoView = scrollIntoView as never;
  return {
    scrollTo,
    scrollIntoView,
    restore() {
      HTMLElement.prototype.scrollTo = originals.scrollTo;
      HTMLElement.prototype.scrollIntoView = originals.scrollIntoView;
    },
  };
}

/** Every element a scroll call was made on, in call order. */
export const scrolled = (spy: ReturnType<typeof vi.fn>) => spy.mock.contexts as HTMLElement[];

/**
 * A `sendChatMessage` whose ask stays in flight until `settle` is called
 * with the recorded exchange (or `fail` with an error), so a test can look
 * at the panel mid-answer.
 */
export function heldSend() {
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
export const STREAM_ID = '77777777-7777-7777-7777-777777777777';

export function appEvent(type: string, data: Record<string, unknown>): AppEvent {
  return {
    id: `event-${type}-${String(data['index'] ?? 'end')}`,
    type,
    topic: `notebook:${NOTEBOOK_ID}`,
    occurredAt: '2026-01-01T00:00:02.000Z',
    data: { notebookId: NOTEBOOK_ID, threadId: 'thread-1', streamId: STREAM_ID, ...data },
  };
}

export const chunk = (
  index: number,
  text: string,
  overrides: Record<string, unknown> = {},
): AppEvent => appEvent('chat-answer-chunk', { index, text, ...overrides });

export const completed = (data: Record<string, unknown> = {}): AppEvent =>
  appEvent('chat-answer-completed', {
    messageId: 'a1',
    questionId: 'q1',
    citations: [],
    ...data,
  });

export const failed = (data: Record<string, unknown> = {}): AppEvent =>
  appEvent('chat-answer-failed', { reason: 'the provider hung up', ...data });

/**
 * The chat panel as the Notebook page composes it: the Thread navigator and
 * the Thread view side by side, sharing the root-provided ChatStore.
 *
 * NBK-34 split the one panel component in two so the workspace frame
 * (NBK-35) can place them in different cards; the behaviour under test is
 * the pair's, so this host stands in for the page and every test below is
 * the one that ran against the single component. Since NBK-79 the page, not
 * the navigator, loads the Threads, follows the live stream and resets the
 * store on the way out, so the host does exactly what the page does there.
 */
@Component({
  selector: 'app-chat-panel-host',
  imports: [ThreadNavigator, ThreadView],
  template: `
    <app-thread-navigator [notebookId]="notebookId()" />
    <app-thread-view [notebookId]="notebookId()" />
  `,
})
export class ChatPanelHost implements OnInit, OnDestroy {
  readonly notebookId = input.required<string>();

  private readonly store = inject(ChatStore);

  ngOnInit(): void {
    void this.store.loadThreads(this.notebookId());
    this.store.watchNotebook(this.notebookId());
  }

  ngOnDestroy(): void {
    this.store.reset();
  }
}

// Seam-3 test (per NBK-1's testing decisions, and explicitly called for by
// NBK-10's acceptance criteria): render the real components + SignalStore,
// mocking only the generated ng-openapi-gen client interface (ChatService) —
// never the store or any Angular service internals.
/**
 * Stands in for the live SSE connection a streamed answer arrives on
 * (NBK-11). `AppEventsService` is the seam, not `EventSource`: jsdom has no
 * `EventSource`, and the panel's contract is "events arrive on this
 * stream", not "an HTTP connection is opened in this particular way". That
 * the real service turns a live SSE connection into these events is proven
 * on the backend, by apps/backend/test/events.route.test.ts — and the same
 * stub shape is already used by notebook-detail-page.spec.ts.
 */
export function appEventsStub() {
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

/**
 * The App Event stream the panel under test is watching. Fresh per test:
 * every area file of this spec calls `resetAppEvents` from its `beforeEach`.
 */
export let appEvents: ReturnType<typeof appEventsStub>;

export function resetAppEvents() {
  appEvents = appEventsStub();
}

export async function renderPanel(chatService: Partial<ChatService>) {
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
      // The Notebook landing (NBK-81) shows and renames the Notebook's title
      // through the Notebooks store; the page, not the panel, loads it.
      { provide: NotebooksService, useValue: { listNotebooks: vi.fn().mockResolvedValue([]) } },
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
export async function openRevenueQuestions(
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

/**
 * Opens "Revenue questions" on `messages` and types `ASK`, so a test starts
 * from a draft ready to send. Waits on the box itself rather than on the
 * empty-state copy, which another ticket rewrites. The send resolves with
 * `q3Exchange()` unless `overrides` says otherwise.
 */
export async function draftAQuestion(
  overrides: Partial<Record<keyof ChatService, unknown>> = {},
  messages: unknown[] = [],
) {
  const sendChatMessage = vi.fn().mockResolvedValue(q3Exchange());
  await openRevenueQuestions(messages, { sendChatMessage, ...overrides });
  await waitFor(() => expect(questionBox().disabled).toBe(false));
  fireEvent.input(questionBox(), { target: { value: ASK } });
  return { sendChatMessage };
}

/** Sends `ASK` from `draftAQuestion` with the ask held open, handing back the held send. */
export async function sendHeld(
  overrides: Partial<Record<keyof ChatService, unknown>> = {},
  messages: unknown[] = [],
) {
  const held = heldSend();
  await draftAQuestion({ sendChatMessage: held.sendChatMessage, ...overrides }, messages);
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  return held;
}

/** Where a Citation link points, taken apart so param order can't matter. */
export function target(link: Element): { pathname: string; params: Record<string, string> } {
  const url = new URL(link.getAttribute('href')!, 'http://localhost');
  return {
    pathname: url.pathname,
    params: Object.fromEntries(url.searchParams.entries()),
  };
}
