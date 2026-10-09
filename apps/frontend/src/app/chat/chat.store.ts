import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { Subscription } from 'rxjs';
import { ChatService } from '../api/services/chat.service';
import { AuthStore } from '../auth/auth.store';
import { AppEvent, AppEventsService } from '../events/app-events.service';
import { errorMessage } from '../shared/error-message';

// Who did something. Mirrors the backend's `chatParticipantSchema`: the email
// is what a reader recognises in a shared Chat Thread, which is the whole
// reason attribution is recorded (ADR-0001).
export interface ChatParticipant {
  id: string;
  email: string;
}

// A Chat Thread. See GLOSSARY.md: "a named sequence of messages asked against
// a Notebook's Documents, started by one user (its author) but visible to
// every user who opens the Notebook."
//
// `author` is displayed, never used to decide what this user may do: any user
// may read, rename and continue any Thread.
export interface ChatThread {
  id: string;
  notebookId: string;
  title: string;
  author: ChatParticipant;
  createdAt: string;
}

// A Citation on an answer. See GLOSSARY.md: "a pointer into one specific
// Document Version at one specific chunk, surfaced in a chat answer as a
// source reference. Following a Citation opens that exact Version at that
// location, even after newer Versions exist."
//
// `documentVersionId` and `chunkId` are what the UI must carry into the link
// it builds — not just `documentId`, which would land a reader on whatever
// Version is latest when they click. `charStart`/`charEnd` are the chunk's
// character range in that Version's Converted Markdown, which is what
// "scrolled to that chunk's location" resolves to; both are null for a
// Version with no Converted Markdown, and the link then simply opens it
// unscrolled.
//
// There is no label field by design: the display name is derived here from
// `filename` and `headingPath` (NBK-12).
export interface Citation {
  id: string;
  /** The marker as it appears in the answer text, e.g. 1 for "[1]". */
  marker: number;
  documentId: string;
  documentVersionId: string;
  versionNumber: number;
  chunkId: string;
  filename: string;
  headingPath: string[];
  charStart: number | null;
  charEnd: number | null;
}

// One message. `askedBy` is set for both roles — for a question it is who
// typed it, for an answer it is whose question produced it — so a Thread
// several people have contributed to can say whose exchange each pair is.
//
// `citations` is the answer's sources (NBK-12); a question has none.
export interface ChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  askedBy: ChatParticipant;
  citations: Citation[];
  createdAt: string;
}

// The app-event types a streamed answer arrives as (NBK-11). They come down
// the same generic SSE stream as Document status changes (NBK-6) — per
// ADR-0004 that channel was built generic for exactly this — so this store
// acts on these three and ignores everything else on it.
const CHAT_ANSWER_CHUNK = 'chat-answer-chunk';
const CHAT_ANSWER_COMPLETED = 'chat-answer-completed';
const CHAT_ANSWER_FAILED = 'chat-answer-failed';

/**
 * An answer being written, as far as this client has seen it.
 *
 * Not a `ChatMessage`: it has no id, no author and no `createdAt`, because
 * the backend writes the one `chat_messages` row only once the answer is
 * complete (NBK-11). It is a *preview* of a message, and it is replaced by
 * the real one rather than promoted into it.
 *
 * `chunks` is indexed by the event's `index` rather than appended blindly, so
 * a duplicated or out-of-order event cannot scramble the prose.
 */
export interface StreamingAnswer {
  threadId: string;
  streamId: string;
  chunks: string[];
  /**
   * The answer's Citations, which arrive only with the completion event:
   * they resolve from the markers in the *complete* text, so no chunk could
   * have carried them.
   */
  citations: Citation[];
  /** True once the backend has said this answer is final. */
  done: boolean;
}

/**
 * A question this user has sent and the server has not yet recorded
 * (NBK-70): shown at the end of its Chat Thread from the moment of sending.
 *
 * Not a `ChatMessage`, for the same reason a `StreamingAnswer` is not: it has
 * no id and no server timestamp, since the backend writes the question's
 * `chat_messages` row only together with the complete answer. It is replaced
 * by the recorded question rather than promoted into it, so nothing ever
 * mistakes it for something the server holds.
 */
export interface PendingQuestion {
  threadId: string;
  content: string;
  /**
   * The signed-in user. Never null: chat is only on pages behind the auth
   * guard, which signs the session in before they render, so a preview
   * can always be attributed — there is no anonymous author line to draw.
   */
  askedBy: ChatParticipant;
  /** When it was sent, by this client's clock: there is no server time yet. */
  sentAt: string;
}

/**
 * A question whose ask failed, kept with the Chat Thread it was asked in
 * until that Thread's question box takes the text back (NBK-69 story 7).
 * The ask may fail while another Thread is open, so neither the text nor
 * the error can simply go to whatever box is on screen.
 */
export interface FailedQuestion {
  content: string;
  /** Shown as the error row when its Thread is next opened. */
  error: string;
}

interface ChatState {
  threads: ChatThread[];
  threadsLoading: boolean;
  /** The open Thread's id, or null when none is open. */
  activeThreadId: string | null;
  messages: ChatMessage[];
  messagesLoading: boolean;
  /** True while a question is in flight. The recorded exchange ends it. */
  sending: boolean;
  /**
   * True while a Chat Thread is being created. Every control that starts
   * one waits on it, so a double click starts one Thread, not two.
   */
  creatingThread: boolean;
  /** The answer currently streaming into the open Thread, if any (NBK-11). */
  streamingAnswer: StreamingAnswer | null;
  /**
   * The question in flight, until it is recorded or fails (NBK-70). Kept
   * across a Thread switch — the ask is still out — and rendered only while
   * its Thread is the open one.
   */
  pendingQuestion: PendingQuestion | null;
  /** Failed questions not yet back in their Thread's box, by Thread id. */
  failedQuestions: Record<string, FailedQuestion>;
  /**
   * The answer of the Exchange a search result opened the Thread at
   * (NBK-97), so the view starts there with it marked; null for a Thread
   * opened any other way, and cleared the moment another is.
   */
  foundAnswerId: string | null;
  /** The words that search result was found by, marked in that Exchange; [] otherwise. */
  foundWords: string[];
  error: string | null;
}

const initialState: ChatState = {
  threads: [],
  threadsLoading: false,
  activeThreadId: null,
  messages: [],
  messagesLoading: false,
  sending: false,
  creatingThread: false,
  streamingAnswer: null,
  pendingQuestion: null,
  failedQuestions: {},
  foundAnswerId: null,
  foundWords: [],
  error: null,
};

/**
 * The fixed title a Thread starts with (NBK-43, spec 04 "Default Thread"),
 * whichever control starts it — the navigator's button or a question sent
 * from the landing (NBK-81):
 * the create request requires a non-empty title, and the user renames the
 * Thread from the Thread view's header once they know what it is about.
 */
export const NEW_THREAD_TITLE = 'New Chat Thread';

/** What every event about one streamed answer carries, if it is one. */
function streamFields(event: AppEvent): { threadId: string; streamId: string } | null {
  const threadId = event.data['threadId'];
  const streamId = event.data['streamId'];
  if (typeof threadId !== 'string' || typeof streamId !== 'string') return null;
  return { threadId, streamId };
}

/** The Citations on a completion event, or none if it carried any. */
function eventCitations(event: AppEvent): Citation[] {
  const citations = event.data['citations'];
  // Absent when the backend had to drop them to stay inside the NOTIFY size
  // cap (ADR-0004); the re-read below is then what supplies them.
  return Array.isArray(citations) ? (citations as Citation[]) : [];
}

/**
 * Holds one Notebook's Chat Threads and the open Thread's messages, fetched
 * through the generated ng-openapi-gen client (NBK-10).
 *
 * Per ADR-0001 nothing here filters or gates by author: the Thread list is
 * whatever the Notebook holds, and any Thread can be opened, renamed and
 * continued.
 */
export const ChatStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withMethods((store, chatService = inject(ChatService), appEvents = inject(AppEventsService)) => {
    const auth = inject(AuthStore);

    // The live subscription for whichever Notebook is open. Held outside
    // the state because it is plumbing, not something a template renders —
    // the same shape as DocumentsStore's.
    let watching: Subscription | null = null;

    /**
     * Whether `threadId` is still the open Thread: a read that resolves after
     * the Thread was closed (NBK-81) or swapped for another must not land.
     */
    function stillOpen(threadId: string): boolean {
      return store.activeThreadId() === threadId;
    }

    function stopWatching(): void {
      watching?.unsubscribe();
      watching = null;
    }

    /**
     * Re-reads the open Thread's messages over the normal REST route and drops
     * the preview it replaces.
     *
     * This is GLOSSARY.md's rule about an App Event, applied: the events
     * "carry what changed, and a client that missed one re-reads the truth
     * over the normal API". Used when the answer was not this client's own
     * ask — someone else asked in the shared Thread, or this client joined
     * the stream late — because there is no response in flight that would
     * otherwise deliver the recorded messages.
     */
    async function refreshThreadMessages(
      notebookId: string,
      threadId: string,
      streamId: string,
    ): Promise<void> {
      try {
        const messages = (await chatService.listChatMessages({
          notebookId,
          threadId,
        })) as ChatMessage[];
        if (!stillOpen(threadId)) return;
        patchState(store, {
          messages,
          // Only if it is still the same answer: a newer one may have
          // started streaming while this request was out.
          ...(store.streamingAnswer()?.streamId === streamId ? { streamingAnswer: null } : {}),
        });
      } catch {
        // The preview stays up rather than vanishing into nothing. It is
        // the right prose; only its persisted form failed to load, and the
        // next open of the Thread will fetch it.
      }
    }

    /**
     * Opens a Chat Thread and loads its messages — at the Exchange whose
     * answer is named, when a search result opened it (NBK-97).
     */
    async function openThread(
      notebookId: string,
      threadId: string,
      foundAnswerId: string | null = null,
      foundWords: string[] = [],
    ): Promise<void> {
      patchState(store, {
        activeThreadId: threadId,
        foundAnswerId,
        foundWords: foundAnswerId === null ? [] : foundWords,
        // The previous Thread's messages belong to a different Chat Thread,
        // and so does anything that was streaming into it.
        messages: [],
        streamingAnswer: null,
        messagesLoading: true,
        // An ask that failed here while another Thread was open explains
        // itself now, beside the text the box takes back.
        error: store.failedQuestions()[threadId]?.error ?? null,
      });
      try {
        const fetched = (await chatService.listChatMessages({
          notebookId,
          threadId,
        })) as ChatMessage[];
        // Closed (NBK-81) or swapped for another while the read was out:
        // these are no longer the messages on screen.
        if (!stillOpen(threadId)) return;
        // An ask in this Thread can land while the read is out — the user
        // switched back mid-answer — and `sendMessage` has then appended an
        // exchange the snapshot predates. Keep it rather than let the older
        // snapshot overwrite it.
        const ids = new Set(fetched.map((m) => m.id));
        const recordedMeanwhile = store
          .messages()
          .filter((m) => m.threadId === threadId && !ids.has(m.id));
        const messages = [...fetched, ...recordedMeanwhile].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        patchState(store, { messages, messagesLoading: false });
      } catch (err) {
        if (!stillOpen(threadId)) return;
        patchState(store, {
          messagesLoading: false,
          error: errorMessage(err, 'Failed to load the Chat Thread.'),
        });
      }
    }

    /**
     * Closes the open Chat Thread (NBK-81, spec 07 "Middle pane"): the
     * Thread view's back arrow returns to the Notebook landing. Only the
     * client lets go — the Thread stays in the list and nothing is sent to
     * the server, so an answer still being written there keeps being
     * recorded, as when another Thread is opened. Not a reload either:
     * `loadThreads` would reopen the newest Thread (NBK-43), and the
     * landing must stay. A question in flight and failed questions are
     * kept: they belong to their Thread, which may be opened again.
     */
    function closeThread(): void {
      patchState(store, {
        activeThreadId: null,
        foundAnswerId: null,
        foundWords: [],
        messages: [],
        messagesLoading: false,
        streamingAnswer: null,
        // The error row is the closed Thread's (or about an ask in it).
        error: null,
      });
    }

    return {
      /**
       * Loads the Notebook's Chat Threads and, when none is open, opens the
       * most recently created one (NBK-43, spec 04 "Default Thread": a user
       * opening a Notebook that has Threads lands in context rather than on
       * an empty card). Decided here rather than in the navigator because
       * it is a rule about the data — whichever component triggers the load
       * gets the same open Thread — and because this is the one place that
       * knows the load has just finished. By `createdAt`, not list position:
       * the backend lists newest first today, but that ordering is its
       * choice, and the rule is "most recent".
       *
       * A search result names an Exchange too (NBK-97): the user picked
       * that result, so its Thread opens at it even over one already open —
       * or, gone since, the newest does.
       */
      async loadThreads(
        notebookId: string,
        preferredThreadId: string | null = null,
        foundAnswerId: string | null = null,
        foundWords: string[] = [],
      ): Promise<void> {
        patchState(store, { threadsLoading: true, error: null });
        try {
          const threads = (await chatService.listChatThreads({ notebookId })) as ChatThread[];
          patchState(store, { threads, threadsLoading: false });
          if (threads.length === 0) return;
          // A Thread the caller names — a search result's (NBK-97) — wins
          // over the newest, if it is in this Notebook; one that is not
          // (deleted, another Notebook's) is ignored.
          const preferred = threads.find((t) => t.id === preferredThreadId);
          const newest = threads.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
          if (preferredThreadId !== null && foundAnswerId !== null) {
            // Following a search result replaces whatever Thread was open.
            await openThread(
              notebookId,
              (preferred ?? newest).id,
              preferred ? foundAnswerId : null,
              foundWords,
            );
          } else if (store.activeThreadId() === null) {
            await openThread(notebookId, (preferred ?? newest).id);
          }
        } catch (err) {
          patchState(store, {
            threadsLoading: false,
            error: errorMessage(err, 'Failed to load Chat Threads.'),
          });
        }
      },

      async createThread(notebookId: string, title: string): Promise<void> {
        if (store.creatingThread()) return;
        patchState(store, { error: null, creatingThread: true });
        try {
          const thread = (await chatService.createChatThread({
            notebookId,
            body: { title },
          })) as ChatThread;
          // Newest first, matching the backend's ordering, so a Thread just
          // started is where the user is already looking.
          patchState(store, {
            threads: [thread, ...store.threads()],
            activeThreadId: thread.id,
            foundAnswerId: null,
            foundWords: [],
            messages: [],
            streamingAnswer: null,
          });
        } catch (err) {
          patchState(store, { error: errorMessage(err, 'Failed to start a Chat Thread.') });
        } finally {
          patchState(store, { creatingThread: false });
        }
      },

      async renameThread(notebookId: string, threadId: string, title: string): Promise<void> {
        patchState(store, { error: null });
        try {
          const renamed = (await chatService.renameChatThread({
            notebookId,
            threadId,
            body: { title },
          })) as ChatThread;
          patchState(store, {
            threads: store.threads().map((t) => (t.id === renamed.id ? renamed : t)),
          });
        } catch (err) {
          patchState(store, { error: errorMessage(err, 'Failed to rename the Chat Thread.') });
        }
      },

      openThread,

      /**
       * Deletes a Chat Thread (NBK-95) — its author's call alone, which the
       * server enforces; the navigator only offers it to the author. Gone
       * from the list once the server agrees, and closed if it was the open
       * one, as the back arrow closes a Thread. There is no Undo (an
       * Administrator can restore it through the API). A refusal leaves the
       * Thread where it was and says why in the error row.
       */
      async deleteThread(notebookId: string, threadId: string): Promise<void> {
        patchState(store, { error: null });
        try {
          await chatService.deleteChatThread({ notebookId, threadId });
        } catch (err) {
          patchState(store, { error: errorMessage(err, 'Failed to delete the Chat Thread.') });
          return;
        }
        patchState(store, { threads: store.threads().filter((t) => t.id !== threadId) });
        if (store.activeThreadId() === threadId) closeThread();
      },

      closeThread,

      /**
       * Asks a question and appends the exchange.
       *
       * The question shows at once as a `pendingQuestion` (NBK-70): the
       * server records it only with the complete answer, and until then the
       * user would watch an answer stream in under a list that does not show
       * what they asked. The response carries both recorded messages, so
       * nothing is re-fetched, and the preview is cleared in the same update
       * that appends them — replaced by the server's copy, with its id and
       * attribution, rather than promoted, and never shown beside it.
       * Resolves `true` when the exchange landed. On failure the text is kept
       * as a `FailedQuestion` of its Thread for the box to take back — a
       * failed ask records nothing server-side, which makes asking again the
       * retry, and that only works if the text survives, even when another
       * Thread is open by the time the ask fails.
       *
       * While this request is out, the answer's chunks are arriving on the
       * live stream and `streamingAnswer` is being rendered (NBK-11). That
       * preview is dropped here, whichever way the request ends: on success
       * the recorded messages take its place, and on failure there is nothing
       * to show — the backend persisted no half answer.
       */
      async sendMessage(notebookId: string, threadId: string, content: string): Promise<boolean> {
        // Asserted, not checked: see `PendingQuestion.askedBy`.
        const { id, email } = auth.user()!;
        patchState(store, {
          sending: true,
          error: null,
          pendingQuestion: {
            threadId,
            content,
            askedBy: { id, email },
            sentAt: new Date().toISOString(),
          },
        });
        try {
          const exchange = (await chatService.sendChatMessage({
            notebookId,
            threadId,
            body: { content },
          })) as { question: ChatMessage; answer: ChatMessage };
          patchState(store, {
            sending: false,
            pendingQuestion: null,
            // Only into the Thread it was asked in: if another is open now,
            // this one re-reads the exchange when it is next opened.
            ...(store.activeThreadId() === threadId
              ? { messages: [...store.messages(), exchange.question, exchange.answer] }
              : {}),
            streamingAnswer: null,
          });
          return true;
        } catch (err) {
          const error = errorMessage(err, 'Failed to send the message.');
          patchState(store, {
            sending: false,
            pendingQuestion: null,
            streamingAnswer: null,
            failedQuestions: { ...store.failedQuestions(), [threadId]: { content, error } },
            // The error row sits above the open Thread's box, so it is only
            // raised there if this is that Thread; otherwise it waits with
            // the question for its Thread to be opened.
            ...(store.activeThreadId() === threadId ? { error } : {}),
          });
          return false;
        }
      },

      /**
       * Follows one Notebook's live app events so a streamed answer renders as
       * it is written (NBK-11).
       *
       * Only this Notebook's topic is requested, and only the three chat
       * answer event types are acted on — the stream carries everything,
       * including the Document status events DocumentsStore watches.
       *
       * Note what this does *not* do: it never treats a chunk as the record.
       * The answer becomes a message when a `chat_messages` row exists, which
       * the completion event announces and the REST routes serve; until then
       * it is a preview that can be dropped at any moment.
       */
      watchNotebook(notebookId: string): void {
        stopWatching();
        watching = appEvents.stream([`notebook:${notebookId}`]).subscribe((event) => {
          const fields = streamFields(event);
          if (!fields) return;
          // A Notebook can hold several Threads, and everyone watching it sees
          // every Thread's answers (they are shared, per GLOSSARY.md). Only
          // the open one is rendered.
          if (fields.threadId !== store.activeThreadId()) return;

          const current = store.streamingAnswer();
          const isCurrent = current?.streamId === fields.streamId;

          if (event.type === CHAT_ANSWER_CHUNK) {
            const index = event.data['index'];
            const text = event.data['text'];
            if (typeof index !== 'number' || typeof text !== 'string') return;

            if (!isCurrent) {
              // A stream this client has not seen before. It is only rendered
              // from its first chunk: an index above 0 means this client
              // joined mid-answer — a reconnect, or a question someone else
              // asked before the page was open — and NOTIFY has no replay, so
              // the opening of the answer is gone for good. Rendering an
              // answer with its beginning missing would be worse than
              // rendering none; the completion event below re-reads it whole.
              if (index !== 0) return;
              patchState(store, {
                streamingAnswer: {
                  threadId: fields.threadId,
                  streamId: fields.streamId,
                  chunks: [text],
                  citations: [],
                  done: false,
                },
              });
              return;
            }

            // Indexed rather than appended, so a duplicate event (or two
            // arriving out of order) cannot reorder or double the prose.
            const chunks = [...current!.chunks];
            chunks[index] = text;
            patchState(store, { streamingAnswer: { ...current!, chunks } });
            return;
          }

          if (event.type === CHAT_ANSWER_COMPLETED) {
            // The Citations land here and nowhere earlier, so the preview's
            // markers become links at the same moment the answer stops
            // growing.
            if (isCurrent) {
              patchState(store, {
                streamingAnswer: { ...current!, done: true, citations: eventCitations(event) },
              });
            }
            // This client's own ask already has the recorded exchange coming
            // back in `sendMessage`'s response, so re-reading would be a
            // wasted round trip. Any other case — someone else asked, or this
            // client joined late — has no response in flight, and the event is
            // only a hint: the truth comes from the REST route.
            if (!store.sending()) {
              void refreshThreadMessages(notebookId, fields.threadId, fields.streamId);
            }
            return;
          }

          if (event.type === CHAT_ANSWER_FAILED && isCurrent) {
            // Nothing was persisted, so there is nothing to replace the
            // preview with: it goes. The asking client also gets a 502 with a
            // message to show; a watching one simply sees the half answer
            // disappear, which is honest — it was never a message.
            patchState(store, { streamingAnswer: null });
          }
        });
      },

      /**
       * Closes the live stream but keeps the open Chat Thread: for a page
       * handing the Notebook over to another of its pages (spec 08); the
       * Notebook page watches again on arrival.
       */
      stopWatching,

      /** Drops the open Chat Thread, so navigating away doesn't leak it. */
      reset(): void {
        stopWatching();
        patchState(store, initialState);
      },

      /**
       * Clears the error the user has read (NBK-45). Only the message goes:
       * an error row above the composer is about an ask that is over, so
       * there is nothing else to undo.
       */
      dismissError(): void {
        patchState(store, { error: null });
      },

      /** Called once a Thread's box has taken back its failed question's text. */
      forgetFailedQuestion(threadId: string): void {
        const { [threadId]: _restored, ...rest } = store.failedQuestions();
        patchState(store, { failedQuestions: rest });
      },
    };
  }),
);
