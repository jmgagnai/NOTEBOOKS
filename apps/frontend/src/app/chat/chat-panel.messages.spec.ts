import { input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { fireEvent, screen, waitFor, within } from '@testing-library/angular';
import {
  NOTEBOOK_ID,
  DOCUMENT_ID,
  VERSION_ID,
  CHUNK_ID,
  participant,
  thread,
  message,
  citation,
  avatarOf,
  tooltipOf,
  questionBox,
  rowOf,
  heldSend,
  chunk,
  completed,
  failed,
  appEvents,
  resetAppEvents,
  openRevenueQuestions,
  target,
} from './chat-panel.spec-helpers';

describe('Chat panel (ThreadNavigator + ThreadView) — messages and Citations', () => {
  beforeEach(resetAppEvents);

  // NBK-12: "clicking a Citation in the Angular UI opens that exact Document
  // Version, scrolled to that chunk's location". What this panel is
  // responsible for is the *link*: it has to carry the pinned Version and
  // chunk, not the Document alone, or following it lands on whatever is
  // latest — the exact failure GLOSSARY.md's Citation definition rules out.
  // And nothing else: the Document page has no chat pane to name a Chat
  // Thread for (NBK-103), so the link carries none.
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
        // needs, and nothing that would be re-resolved to the latest Version
        params: {
          version: VERSION_ID,
          chunk: CHUNK_ID,
          from: '120',
          to: '167',
        },
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

    it('turns each Citation marker in the prose into a link to the Chunk it cites', async () => {
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
        params: {
          version: VERSION_ID,
          chunk: CHUNK_ID,
          from: '120',
          to: '167',
        },
      });

      // The prose either side of the marker survives unchanged.
      expect(screen.getByText(/Lead times lengthened to 14 weeks/)).toBeTruthy();
    });

    it('leaves a marker the answer has no Citation for as text', async () => {
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
      await screen.findByTestId('chat-messages');
      fireEvent.input(questionBox(), { target: { value: 'What was revenue in Q3?' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      return { settle };
    }

    it('renders each chunk as it arrives, and replaces the streamed answer with the recorded one', async () => {
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
    it('drops the streamed answer when it fails partway', async () => {
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
      await screen.findByTestId('chat-messages');

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
        params: {
          version: VERSION_ID,
          chunk: CHUNK_ID,
          from: '120',
          to: '167',
        },
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
