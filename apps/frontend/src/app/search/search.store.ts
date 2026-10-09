import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { SearchService } from '../api/services/search.service';
import { ChunkPin } from '../documents/chunk-link';
import { errorMessage } from '../shared/error-message';

/**
 * One Documents search hit (NBK-104): a Chunk, not a Document — a reader
 * looks for the places a word occurs, so a Document appears once per Chunk
 * that holds it. Shown as its Excerpt, with the Document and the heading it
 * sits under. The generated client's shape, from `documentSearchResultSchema`
 * in apps/backend/src/search/schema.ts, which is the source of truth.
 */
export interface ChunkResult {
  documentId: string;
  filename: string;
  /** The title Stage 2 extracted, or null when there is none. */
  title: string | null;
  /** The Markdown headings the Chunk sits under, outermost first. */
  headingPath: string[];
  /**
   * Where the Chunk sits — the pin a Citation carries — so the result opens
   * at it (NBK-96). The range is null when the Chunk could not be located.
   */
  match: ChunkPin;
  /** About two lines of the Chunk around the matches (GLOSSARY.md: Excerpt). */
  excerpt: TextSegment[];
}

/** A run of an Excerpt, bold when it is one of the query's words. */
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
  /** The matching Chunks of the Notebook's Documents (NBK-104). */
  chunks: ChunkResult[];
  /** The matching Exchanges of the Notebook's Chat Threads (NBK-97). */
  exchanges: ExchangeResult[];
  searching: boolean;
  /** Why the Documents search failed, if it did. */
  chunksError: string | null;
  /**
   * Why the Chat Threads search failed, if it did — apart from `chunksError`, so
   * one search failing never hides the other's results (NBK-97).
   */
  exchangesError: string | null;
  /**
   * Whether a search has completed. Distinguishes "no matches" from "nothing
   * asked yet" — both have empty results, and they need different
   * wording on screen.
   */
  searched: boolean;
  /** Whether the query was searched exactly as typed, with no correction (NBK-105). */
  exact: boolean;
  /**
   * The query actually searched when its misspelt words were corrected
   * (NBK-105); null when it was searched as typed.
   */
  correctedQuery: string | null;
  /**
   * The words searched for, as the backend read the query — corrected,
   * without `or` or excluded words — for the results' links to carry, so
   * the opened page marks them.
   */
  words: string[];
}

const initialState: SearchState = {
  notebookId: null,
  query: '',
  exact: false,
  correctedQuery: null,
  words: [],
  chunks: [],
  exchanges: [],
  searching: false,
  chunksError: null,
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
      /**
       * Searches the Notebook's Documents and Chat Threads, correcting
       * misspelt words unless `exact` (NBK-105).
       */
      async search(notebookId: string, query: string, exact = false): Promise<void> {
        const request = ++latest;
        const trimmed = query.trim();
        // A blank query finds nothing (the backend answers no results), so it
        // is not sent at all.
        if (!trimmed) {
          patchState(store, { ...initialState });
          return;
        }

        patchState(store, {
          notebookId,
          query: trimmed,
          exact,
          searching: true,
          chunksError: null,
          exchangesError: null,
        });
        // Both at once, each failing on its own: the Documents' Chunks and
        // the Chat Threads' Exchanges, both by keyword (NBK-97, NBK-104).
        // The API's spelling of the flag ('true'), not the page URL's ('1').
        const params = { notebookId, q: trimmed, ...(exact ? { exact: 'true' as const } : {}) };
        const [foundChunks, foundExchanges] = await Promise.all([
          settle(searchService.searchNotebook(params) as Promise<Found<ChunkResult>>),
          settle(searchService.searchChatThreads(params) as Promise<Found<ExchangeResult>>),
        ]);
        if (request !== latest) return;
        patchState(store, {
          searching: false,
          searched: true,
          chunks: foundChunks.value?.results ?? [],
          chunksError: foundChunks.error,
          exchanges: foundExchanges.value?.results ?? [],
          exchangesError: foundExchanges.error,
          // Both correct against the same Notebook's words, so either says it.
          correctedQuery:
            foundChunks.value?.correctedQuery ?? foundExchanges.value?.correctedQuery ?? null,
          words: foundChunks.value?.words ?? foundExchanges.value?.words ?? [],
        });
      },

      /**
       * Whether the results on hand answer this Notebook and query — coming
       * Back from a Document they were opened from (NBK-96) — so they are
       * shown again as they were left rather than fetched again. A failed
       * search is not kept.
       */
      holds(notebookId: string, query: string, exact = false): boolean {
        return (
          store.notebookId() === notebookId &&
          store.query() === query.trim() &&
          store.exact() === exact &&
          store.searched() &&
          !store.searching() &&
          store.chunksError() === null &&
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

/**
 * What either search answers with (NBK-105): the generated client's shape,
 * from `searchResponse` in apps/backend/src/search/schema.ts, which is the
 * source of truth.
 */
interface Found<T> {
  correctedQuery: string | null;
  words: string[];
  results: T[];
}

/** A search's answer, or why it failed — so one failing never sinks the other. */
async function settle<T>(answer: Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await answer, error: null };
  } catch (err) {
    return { value: null, error: errorMessage(err, 'Search failed.') };
  }
}
