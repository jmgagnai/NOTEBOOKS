import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { NotebooksService } from '../api/services/notebooks.service';

export interface Notebook {
  id: string;
  title: string;
  createdAt: string;
}

interface NotebooksState {
  notebooks: Notebook[];
  loading: boolean;
  error: string | null;
}

const initialState: NotebooksState = {
  notebooks: [],
  loading: false,
  error: null,
};

/**
 * Holds the Notebook list fetched through the generated ng-openapi-gen
 * client — the one real seam this walking skeleton proves end to end.
 */
export const NotebooksStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withMethods((store, notebooksService = inject(NotebooksService)) => ({
    async loadNotebooks(): Promise<void> {
      patchState(store, { loading: true, error: null });
      try {
        const notebooks = await notebooksService.listNotebooks();
        patchState(store, { notebooks, loading: false });
      } catch (err) {
        patchState(store, {
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load Notebooks.',
        });
      }
    },
  })),
);
