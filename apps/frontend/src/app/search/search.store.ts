import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { SearchService } from '../api/services/search.service';
import { ChunkPin } from '../documents/chunk-link';
import { Document } from '../documents/documents.store';
import { errorMessage } from '../shared/error-message';

/**
 * One search hit. A `Document` — not a Chunk — because the backend rolls
 * Chunk matches up to their parent Document (NBK-9), so the same Document
 * never appears twice however many of its Chunks matched.
 *
 * It is deliberately the same `Document` the Notebook's card list renders:
 * both carry the `abstract`, which per GLOSSARY.md is what belongs in
 * "search results, search-result previews, and document cards".
 */
export interface SearchResult extends Document {
  /**
   * Cosine similarity of this Document's best-matching Chunk to the query,
   * 1 being identical. Results arrive ordered by it, best first.
   */
  score: number;
  /** The title Stage 2 extracted, or null when there is none (NBK-96). */
  title: string | null;
  /**
   * Where the Document's best-matching Chunk sits — the pin a Citation
   * carries — so the result opens at that Chunk (NBK-96). The range is
   * null when the Chunk could not be located.
   */
  match: ChunkPin;
}

/** A run of a message's text, bold when it is one of the query's words. */
export interface TextSegment {
  text: string;
  match: boolean;
}

/**
 * One Exchange of a Chat Thread whose question or answer matches the query
 * by keyword (NBK-97). The question comes whole and the answer as excerpts,
 * both split into segments so the matched words are bold without the page
 * ever rendering markup.
 */
export interface ExchangeResult {
  threadId: string;
  threadTitle: string;
  askedBy: { id: string; email: string };
  askedAt: string;
  questionId: string;
  /** The answer's message id: where the Chat Thread opens. */
  answerId: string;
  question: TextSegment[];
  answer: TextSegment[];
}

interface SearchState {
  /** The Notebook the results belong to; null before any search. */
  notebookId: string | null;
  /** The query the currently-displayed results answer. '' before any search. */
  query: string;
  /** The matching Documents. */
  results: SearchResult[];
  /** The matching Exchanges of the Notebook's Chat Threads (NBK-97). */
  exchanges: ExchangeResult[];
  searching: boolean;
  /** Why the Documents search failed, if it did. */
  error: string | null;
  /**
   * Why the Chat Threads search failed, if it did — apart from `error`, so
   * one search failing never hides the other's results (NBK-97).
   */
  exchangesError: string | null;
  /**
   * Whether a search has completed. Distinguishes "no matches" from "nothing
   * asked yet" — both have empty results, and they need different
   * wording on screen.
   */
  searched: boolean;
}

const initialState: SearchState = {
  notebookId: null,
  query: '',
  results: [],
  exchanges: [],
  searching: false,
  error: null,
  exchangesError: null,
  searched: false,
};

/**
 * Holds one Notebook's search results, fetched through the generated
 * ng-openapi-gen client. Per ADR-0001 there is no ownership check anywhere
 * in this chain — any authenticated user can search any Notebook.
 */
export const SearchStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withMethods((store, searchService = inject(SearchService)) => {
    // The newest search, so an older one answering after it is dropped
    // rather than shown under the newer query — or under another Notebook
    // (NBK-96 review). Plumbing, so outside the state.
    let latest = 0;

    return {
      async search(notebookId: string, query: string): Promise<void> {
        const request = ++latest;
        const trimmed = query.trim();
        // The backend rejects a blank query with 400 and, more to the point,
        // embedding an empty string costs an OpenRouter call to rank nothing.
        if (!trimmed) {
          patchState(store, { ...initialState });
          return;
        }

        patchState(store, {
          notebookId,
          query: trimmed,
          searching: true,
          error: null,
          exchangesError: null,
        });
        // Both at once, each failing on its own: the Documents by meaning,
        // the Chat Threads by keyword (NBK-97).
        const [documents, exchanges] = await Promise.all([
          settle(
            searchService.searchNotebook({ notebookId, q: trimmed }) as Promise<SearchResult[]>,
          ),
          settle(
            searchService.searchChatThreads({ notebookId, q: trimmed }) as Promise<
              ExchangeResult[]
            >,
          ),
        ]);
        if (request !== latest) return;
        patchState(store, {
          searching: false,
          searched: true,
          results: documents.value ?? [],
          error: documents.error,
          exchanges: exchanges.value ?? [],
          exchangesError: exchanges.error,
        });
      },

      /**
       * Whether the results on hand answer this Notebook and query — coming
       * Back from a Document they were opened from (NBK-96) — so they can be
       * shown again rather than paid for twice. A failed search is not kept.
       */
      holds(notebookId: string, query: string): boolean {
        return (
          store.notebookId() === notebookId &&
          store.query() === query.trim() &&
          store.searched() &&
          !store.searching() &&
          store.error() === null &&
          store.exchangesError() === null
        );
      },

      /** Drops the results, so opening a different Notebook starts clean. */
      clear(): void {
        latest++;
        patchState(store, { ...initialState });
      },
    };
  }),
);

/** A search's answer, or why it failed — so one failing never sinks the other. */
async function settle<T>(answer: Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await answer, error: null };
  } catch (err) {
    return { value: null, error: errorMessage(err, 'Search failed.') };
  }
}
