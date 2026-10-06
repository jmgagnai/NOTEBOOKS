import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { SearchService } from '../api/services/search.service';
import { Document } from '../documents/documents.store';

/**
 * One search hit. A `Document` — not a Chunk — because the backend rolls
 * Chunk matches up to their parent Document (NBK-9), so the same Document
 * never appears twice however many of its passages matched.
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
}

interface SearchState {
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
  query: '',
  results: [],
  searching: false,
  error: null,
  searched: false,
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

      patchState(store, { query: trimmed, searching: true, error: null });
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

    /** Drops the results, so opening a different Notebook starts clean. */
    clear(): void {
      patchState(store, { ...initialState });
    },
  })),
);
