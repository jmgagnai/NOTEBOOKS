import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { render, screen, waitFor } from '@testing-library/angular';
import { NotebookDetailPage } from './notebook-detail-page';
import { ChatStore } from '../chat/chat.store';
import {
  Elsewhere,
  NOTEBOOK_ID,
  RESEARCH,
  RouterShell,
  pageProviders,
} from './notebook-detail-page.spec-helpers';
import { listOf, message, thread } from '../chat/chat-panel.spec-helpers';

/**
 * NBK-97: a Chat Thread result on the Search page opens the Notebook at
 * `?thread=<id>&message=<answer id>` — that Thread, scrolled so the
 * Exchange's question is at the top, the question and answer marked as a
 * cited Chunk is. jsdom has no layout, so the scroll is asserted through the
 * calls made and the elements they were made on, as NBK-53's rules are.
 */
describe('NotebookDetailPage — opening a Chat Thread at an Exchange (NBK-97)', () => {
  let scrollTo: ReturnType<typeof vi.fn>;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  const originals = {
    scrollTo: HTMLElement.prototype.scrollTo,
    scrollIntoView: HTMLElement.prototype.scrollIntoView,
  };

  beforeEach(() => {
    scrollTo = vi.fn();
    scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo as never;
    HTMLElement.prototype.scrollIntoView = scrollIntoView as never;
  });

  afterEach(() => {
    HTMLElement.prototype.scrollTo = originals.scrollTo;
    HTMLElement.prototype.scrollIntoView = originals.scrollIntoView;
    TestBed.inject(ChatStore).reset();
  });

  const scrolled = (spy: ReturnType<typeof vi.fn>) => spy.mock.contexts as HTMLElement[];
  const rowOf = (text: string) => screen.getByText(text).closest('li')!;

  /** thread-1, older, holds the Exchange searched for; thread-2 is the newest. */
  const THREADS = [
    thread({ id: 'thread-2', title: 'Supply chain', createdAt: '2026-03-15T00:00:00.000Z' }),
    thread({ id: 'thread-1', title: 'Revenue questions', createdAt: '2026-01-01T00:00:00.000Z' }),
  ];
  const MESSAGES: Record<string, unknown[]> = {
    'thread-1': [
      message({ id: 'q1', content: 'What was revenue in Q2?' }),
      message({ id: 'a1', role: 'assistant', content: 'Revenue in Q2 was 11.9M.' }),
      message({ id: 'q2', content: 'And in Q3?' }),
      message({ id: 'a2', role: 'assistant', content: 'Revenue in Q3 was 12.4M.' }),
    ],
    'thread-2': [message({ id: 'q9', threadId: 'thread-2', content: 'Who ships the parts?' })],
  };

  async function renderAt(url: string) {
    await render(RouterShell, {
      routes: [
        { path: 'notebooks/:notebookId', component: NotebookDetailPage },
        { path: 'notebooks/:notebookId/search', component: Elsewhere },
      ],
      providers: pageProviders({
        notebooks: { listNotebooks: vi.fn().mockResolvedValue([RESEARCH]) },
        documents: { listDocuments: vi.fn().mockResolvedValue([]) },
        chat: {
          listChatThreads: vi.fn().mockResolvedValue(THREADS),
          listChatMessages: vi.fn(({ threadId }: { threadId: string }) =>
            Promise.resolve(MESSAGES[threadId]),
          ),
        },
        inRouterShell: true,
      }),
    });
    await TestBed.inject(Router).navigateByUrl(url);
  }

  const AT_A1 = `/notebooks/${NOTEBOOK_ID}?thread=thread-1&message=a1`;

  it("opens the named Chat Thread with the Exchange's question scrolled to the top, not the bottom", async () => {
    await renderAt(AT_A1);

    await screen.findByText('What was revenue in Q2?');
    await waitFor(() =>
      expect(scrolled(scrollIntoView)).toEqual([rowOf('What was revenue in Q2?')]),
    );
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
    expect(scrolled(scrollTo)).not.toContain(listOf('What was revenue in Q2?'));
  });

  it('marks the question and the answer of that Exchange, and nothing else', async () => {
    await renderAt(AT_A1);

    await screen.findByText('What was revenue in Q2?');
    const marked = await screen.findAllByTestId('found-exchange');
    expect(marked).toEqual([rowOf('What was revenue in Q2?'), rowOf('Revenue in Q2 was 11.9M.')]);
  });

  it('opens that Chat Thread even when another one of the Notebook is already open', async () => {
    await renderAt(`/notebooks/${NOTEBOOK_ID}`);
    await screen.findByText('Who ships the parts?');
    // To the Search page and back through a result: the open Thread is kept
    // across pages of the same Notebook (spec 08).
    await TestBed.inject(Router).navigateByUrl(`/notebooks/${NOTEBOOK_ID}/search?q=revenue`);
    await TestBed.inject(Router).navigateByUrl(AT_A1);

    await screen.findByText('What was revenue in Q2?');
    expect(screen.queryByText('Who ships the parts?')).toBeNull();
    expect(await screen.findAllByTestId('found-exchange')).toHaveLength(2);
  });

  it('falls back to the newest Chat Thread, landing at the bottom, when the named one is gone', async () => {
    await renderAt(`/notebooks/${NOTEBOOK_ID}?thread=deleted&message=a1`);

    await screen.findByText('Who ships the parts?');
    await waitFor(() => expect(scrolled(scrollTo)).toContain(listOf('Who ships the parts?')));
    expect(screen.queryByTestId('found-exchange')).toBeNull();
  });

  it('lands at the bottom, unmarked, when that Chat Thread is opened any other way', async () => {
    await renderAt(AT_A1);
    await screen.findAllByTestId('found-exchange');

    const store = TestBed.inject(ChatStore);
    await store.openThread(NOTEBOOK_ID, 'thread-2');
    await store.openThread(NOTEBOOK_ID, 'thread-1');
    scrollTo.mockClear();
    scrollIntoView.mockClear();
    await store.openThread(NOTEBOOK_ID, 'thread-2');
    await store.openThread(NOTEBOOK_ID, 'thread-1');

    await screen.findByText('What was revenue in Q2?');
    await waitFor(() => expect(scrolled(scrollTo)).toContain(listOf('What was revenue in Q2?')));
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.queryByTestId('found-exchange')).toBeNull();
  });
});
