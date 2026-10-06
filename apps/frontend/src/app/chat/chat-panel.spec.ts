import { provideRouter } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import { ChatPanel } from './chat-panel';
import { ChatService } from '../api/services/chat.service';

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

// Seam-3 test (per NBK-1's testing decisions, and explicitly called for by
// NBK-10's acceptance criteria): render the real panel + SignalStore, mocking
// only the generated ng-openapi-gen client interface (ChatService) — never
// the store or any Angular service internals.
describe('ChatPanel', () => {
  async function renderPanel(chatService: Partial<ChatService>) {
    return render(ChatPanel, {
      inputs: { notebookId: NOTEBOOK_ID },
      // A real router, not a mocked one: a Citation's whole job is to link
      // somewhere, so the link has to be built by the thing that will
      // actually navigate (NBK-1's seam-3 rule — mock the generated HTTP
      // client, never Angular's own services).
      providers: [provideRouter([]), { provide: ChatService, useValue: chatService }],
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
      thread({ id: 'thread-1', title: 'Alice asks about revenue', author: participant('alice@example.com') }),
      thread({ id: 'thread-2', title: 'Bob asks about risk', author: participant('bob@example.com') }),
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

  // NBK-10: "shows the conversation with per-message author attribution".
  // GLOSSARY.md: "every message in it records which user asked it".
  it('opens a Thread and shows the conversation with per-message attribution', async () => {
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
    expect(askers).toEqual(['alice@example.com', 'Assistant, for alice@example.com', 'bob@example.com']);
  });

  it('sends a question and appends both it and the answer to the conversation', async () => {
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
    // The conversation was not re-fetched: the response carries both
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
    // The rename lands in both the list entry and the open conversation's
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

    it('turns each source marker in the prose into a link to the passage it cites', async () => {
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
      const marker = await screen.findByRole('link', { name: 'Source 1' });
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
          // passage, so it was dropped rather than written — and must not
          // become a link to nowhere.
          content: 'Lead times lengthened [1]. Margins improved [4].',
          citations: [citation()],
        }),
      ]);

      expect(await screen.findByRole('link', { name: 'Source 1' })).toBeTruthy();
      expect(screen.queryByRole('link', { name: 'Source 4' })).toBeNull();
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
});
