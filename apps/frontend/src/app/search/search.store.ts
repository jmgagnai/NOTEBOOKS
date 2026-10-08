import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { SearchService } from '../api/services/search.service';
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
   * carries — so the result opens at that passage (NBK-96). The range is
   * null when the Chunk could not be located.
   */
  match: { versionId: string; chunkId: string; charStart: number | null; charEnd: number | null };
}

interface SearchState {
  /** The Notebook the results belong to; null before any search. */
  notebookId: string | null;
  /** The query the currently-displayed results answer. '' before any search. */
  query: string;
  results: SearchResult[];
  searching: boolean;
  error: string | null;
  /**
   * Whether a search has completed. Distinguishes "no matches" from "nothing
   * asked yet" — both have an empty `results`, and they need different
   * wording on screen.
   */
  searched: boolean;
}

const initialState: SearchState = {
  notebookId: null,
  query: '',
  results: [],
  searching: false,
  error: null,
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
  withMethods((store, searchService = inject(SearchService)) => ({
    async search(notebookId: string, query: string): Promise<void> {
      const trimmed = query.trim();
      // The backend rejects a blank query with 400 and, more to the point,
      // embedding an empty string costs an OpenRouter call to rank nothing.
      if (!trimmed) {
        patchState(store, { ...initialState });
        return;
      }

      patchState(store, { notebookId, query: trimmed, searching: true, error: null });
      try {
        const results = (await searchService.searchNotebook({
          notebookId,
          q: trimmed,
        })) as SearchResult[];
        patchState(store, { results, searching: false, searched: true });
      } catch (err) {
        patchState(store, {
          searching: false,
          searched: true,
          results: [],
          error: errorMessage(err, 'Search failed.'),
        });
      }
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
        store.error() === null
      );
    },

    /** Drops the results, so opening a different Notebook starts clean. */
    clear(): void {
      patchState(store, { ...initialState });
    },
  })),
);
