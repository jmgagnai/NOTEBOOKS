import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { ChatService } from '../api/services/chat.service';

// Who did something. Mirrors the backend's `chatParticipantSchema`: the email
// is what a reader recognises in a shared conversation, which is the whole
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

// One message. `askedBy` is set for both roles — for a question it is who
// typed it, for an answer it is whose question produced it — so a Thread
// several people have contributed to can say whose exchange each pair is.
export interface ChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  askedBy: ChatParticipant;
  createdAt: string;
}

interface ChatState {
  threads: ChatThread[];
  threadsLoading: boolean;
  /** The open Thread's id, or null when none is open. */
  activeThreadId: string | null;
  messages: ChatMessage[];
  messagesLoading: boolean;
  /** True while a question is in flight. One complete answer ends it. */
  sending: boolean;
  error: string | null;
}

const initialState: ChatState = {
  threads: [],
  threadsLoading: false,
  activeThreadId: null,
  messages: [],
  messagesLoading: false,
  sending: false,
  error: null,
};

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'error' in err) {
    const body = (err as { error?: unknown }).error;
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
      return body.message;
    }
  }
  return err instanceof Error ? err.message : fallback;
}

/**
 * Holds one Notebook's Chat Threads and the open conversation, fetched
 * through the generated ng-openapi-gen client (NBK-10).
 *
 * Per ADR-0001 nothing here filters or gates by author: the Thread list is
 * whatever the Notebook holds, and any Thread can be opened, renamed and
 * continued.
 */
export const ChatStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withMethods((store, chatService = inject(ChatService)) => ({
    async loadThreads(notebookId: string): Promise<void> {
      patchState(store, { threadsLoading: true, error: null });
      try {
        const threads = (await chatService.listChatThreads({ notebookId })) as ChatThread[];
        patchState(store, { threads, threadsLoading: false });
      } catch (err) {
        patchState(store, {
          threadsLoading: false,
          error: errorMessage(err, 'Failed to load Chat Threads.'),
        });
      }
    },

    async createThread(notebookId: string, title: string): Promise<void> {
      patchState(store, { error: null });
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
          messages: [],
        });
      } catch (err) {
        patchState(store, { error: errorMessage(err, 'Failed to start a Chat Thread.') });
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

    /** Opens a Thread and loads its conversation. */
    async openThread(notebookId: string, threadId: string): Promise<void> {
      patchState(store, {
        activeThreadId: threadId,
        // The previous Thread's messages belong to a different conversation.
        messages: [],
        messagesLoading: true,
        error: null,
      });
      try {
        const messages = (await chatService.listChatMessages({ notebookId, threadId })) as ChatMessage[];
        patchState(store, { messages, messagesLoading: false });
      } catch (err) {
        patchState(store, {
          messagesLoading: false,
          error: errorMessage(err, 'Failed to load the conversation.'),
        });
      }
    },

    /**
     * Asks a question and appends the exchange.
     *
     * The response carries both messages, so nothing is re-fetched and
     * nothing is rendered optimistically: the question the user sees is the
     * one the server recorded, with its id and attribution. Resolves `true`
     * when the exchange landed, so the caller knows whether to clear the
     * box — a failed ask records nothing server-side, which makes asking
     * again the retry, and that only works if the text survives.
     */
    async sendMessage(notebookId: string, threadId: string, content: string): Promise<boolean> {
      patchState(store, { sending: true, error: null });
      try {
        const exchange = (await chatService.sendChatMessage({
          notebookId,
          threadId,
          body: { content },
        })) as { question: ChatMessage; answer: ChatMessage };
        patchState(store, {
          sending: false,
          messages: [...store.messages(), exchange.question, exchange.answer],
        });
        return true;
      } catch (err) {
        patchState(store, { sending: false, error: errorMessage(err, 'Failed to send the message.') });
        return false;
      }
    },

    /** Drops the open conversation, so navigating away doesn't leak it. */
    reset(): void {
      patchState(store, initialState);
    },
  })),
);
