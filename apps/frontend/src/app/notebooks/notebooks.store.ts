import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { NotebooksService } from '../api/services/notebooks.service';
import { errorMessage } from '../shared/error-message';

export interface Notebook {
  id: string;
  title: string;
  createdAt: string;
}

interface NotebooksState {
  notebooks: Notebook[];
  loading: boolean;
  error: string | null;
  // The most recently deleted Notebook, kept around so the UI can offer an
  // "Undo" action that restores it (NBK-4). `GET /notebooks` never returns
  // soft-deleted Notebooks, so this is the only way to get back to one.
  lastDeleted: Notebook | null;
}

const initialState: NotebooksState = {
  notebooks: [],
  loading: false,
  error: null,
  lastDeleted: null,
};

/**
 * Holds the Notebook list fetched through the generated ng-openapi-gen
 * client, and every create/rename/delete/restore mutation (NBK-4). Per
 * ADR-0001 there is no ownership check anywhere in this chain — any
 * authenticated user can mutate any Notebook, including ones listed here
 * that someone else created.
 */
export const NotebooksStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withMethods((store, notebooksService = inject(NotebooksService)) => {
    /**
     * The loaded Notebook with this id, or `null` (not loaded yet, or gone).
     * There is no "get one Notebook" endpoint, so a page showing one looks
     * it up here; reactive, since it reads the list signal.
     */
    function byId(id: string): Notebook | null {
      return store.notebooks().find((notebook) => notebook.id === id) ?? null;
    }

    return {
      byId,

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

      /**
       * Resolves to the created Notebook's id, or `null` when the create failed
       * (and `error` says why), so the home page can open it (NBK-55). It is in
       * the list before this resolves, which is what lets the Notebook page —
       * with no "get one Notebook" endpoint — find its title straight away.
       */
      async createNotebook(title: string): Promise<string | null> {
        patchState(store, { error: null });
        try {
          const notebook = await notebooksService.createNotebook({ body: { title } });
          patchState(store, { notebooks: [...store.notebooks(), notebook] });
          return notebook.id;
        } catch (err) {
          patchState(store, { error: errorMessage(err, 'Failed to create Notebook.') });
          return null;
        }
      },

      async renameNotebook(id: string, title: string): Promise<void> {
        patchState(store, { error: null });
        try {
          const renamed = await notebooksService.renameNotebook({ id, body: { title } });
          patchState(store, {
            notebooks: store
              .notebooks()
              .map((notebook) => (notebook.id === id ? renamed : notebook)),
          });
        } catch (err) {
          patchState(store, { error: errorMessage(err, 'Failed to rename Notebook.') });
        }
      },

      async deleteNotebook(id: string): Promise<void> {
        patchState(store, { error: null });
        const deleted = byId(id);
        try {
          await notebooksService.deleteNotebook({ id });
          patchState(store, {
            notebooks: store.notebooks().filter((notebook) => notebook.id !== id),
            lastDeleted: deleted,
          });
        } catch (err) {
          patchState(store, { error: errorMessage(err, 'Failed to delete Notebook.') });
        }
      },

      async restoreNotebook(id: string): Promise<void> {
        patchState(store, { error: null });
        try {
          const restored = await notebooksService.restoreNotebook({ id });
          patchState(store, {
            notebooks: [...store.notebooks(), restored],
            lastDeleted: store.lastDeleted()?.id === id ? null : store.lastDeleted(),
          });
        } catch (err) {
          patchState(store, { error: errorMessage(err, 'Failed to restore Notebook.') });
        }
      },
    };
  }),
);
