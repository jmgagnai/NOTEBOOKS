import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { Subscription } from 'rxjs';
import { DocumentsService } from '../api/services/documents.service';
import { AppEvent, AppEventsService } from '../events/app-events.service';
import { DocumentTransferService } from './document-transfer.service';

export interface DocumentVersion {
  id: string;
  versionNumber: number;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * Where a Document's latest Version is in the ingestion pipeline (NBK-6).
 * Mirrors the backend's `documentStatusSchema`.
 */
export type DocumentStatus = 'queued' | 'converting' | 'converted' | 'failed';

// A Document as returned over the API. See GLOSSARY.md: "a source file
// uploaded into a Notebook, tracked through successive Document Versions."
// `status` is its latest Version's ingestion status, which the background
// pipeline (NBK-6) advances — so it changes under the UI's feet, which is
// what `watchNotebook` below is for.
export interface Document {
  id: string;
  notebookId: string;
  filename: string;
  status: DocumentStatus;
  createdAt: string;
  latestVersion: DocumentVersion;
}

/**
 * The payload of a `document-version-status-changed` app event (NBK-6).
 * Mirrors what `apps/backend/src/ingestion/convert-to-markdown.ts` publishes.
 */
interface DocumentVersionStatusChanged {
  documentId: string;
  versionId: string;
  status: DocumentStatus;
}

const DOCUMENT_VERSION_STATUS_CHANGED = 'document-version-status-changed';

/** Narrows a generic app event to a Document Version status change, or null. */
function asStatusChange(event: AppEvent): DocumentVersionStatusChanged | null {
  if (event.type !== DOCUMENT_VERSION_STATUS_CHANGED) return null;
  const { documentId, versionId, status } = event.data as Partial<DocumentVersionStatusChanged>;
  if (typeof documentId !== 'string' || typeof versionId !== 'string' || typeof status !== 'string') {
    return null;
  }
  return { documentId, versionId, status: status as DocumentStatus };
}

interface DocumentsState {
  documents: Document[];
  loading: boolean;
  uploading: boolean;
  error: string | null;
  // The most recently deleted Document, kept around so the UI can offer an
  // "Undo" action that restores it (mirrors NotebooksStore's lastDeleted,
  // NBK-4) — `GET .../documents` never returns soft-deleted Documents, so
  // this is the only way back to one.
  lastDeleted: Document | null;
}

const initialState: DocumentsState = {
  documents: [],
  loading: false,
  uploading: false,
  error: null,
  lastDeleted: null,
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
 * Holds the Document list for one Notebook, fetched through the generated
 * ng-openapi-gen client for list/delete/restore and through
 * `DocumentTransferService` for upload/download (NBK-5). Per ADR-0001 there
 * is no ownership check anywhere in this chain — any authenticated user can
 * upload, delete, or restore any Document in any Notebook.
 */
export const DocumentsStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withMethods(
    (
      store,
      documentsService = inject(DocumentsService),
      transferService = inject(DocumentTransferService),
      appEvents = inject(AppEventsService),
    ) => {
      // The live subscription for whichever Notebook is currently being
      // watched. Held outside the state because it is plumbing, not something
      // a template renders.
      let watching: Subscription | null = null;

      return {
      async loadDocuments(notebookId: string): Promise<void> {
        patchState(store, { loading: true, error: null });
        try {
          const documents = await documentsService.listDocuments({ notebookId });
          patchState(store, { documents, loading: false });
        } catch (err) {
          patchState(store, {
            loading: false,
            error: errorMessage(err, 'Failed to load Documents.'),
          });
        }
      },

      async uploadDocument(notebookId: string, file: File): Promise<void> {
        patchState(store, { uploading: true, error: null });
        try {
          const document = await transferService.uploadDocument(notebookId, file);
          patchState(store, {
            uploading: false,
            // A re-upload of an existing filename comes back as a new
            // Version of the same Document (same id, incremented
            // versionNumber) rather than a new Document — replace the
            // existing entry instead of appending a duplicate.
            documents: store.documents().some((d) => d.id === document.id)
              ? store.documents().map((d) => (d.id === document.id ? document : d))
              : [...store.documents(), document],
          });
        } catch (err) {
          patchState(store, { uploading: false, error: errorMessage(err, 'Failed to upload Document.') });
        }
      },

      async deleteDocument(notebookId: string, documentId: string): Promise<void> {
        patchState(store, { error: null });
        const deleted = store.documents().find((d) => d.id === documentId) ?? null;
        try {
          await documentsService.deleteDocument({ notebookId, documentId });
          patchState(store, {
            documents: store.documents().filter((d) => d.id !== documentId),
            lastDeleted: deleted,
          });
        } catch (err) {
          patchState(store, { error: errorMessage(err, 'Failed to delete Document.') });
        }
      },

      async restoreDocument(notebookId: string, documentId: string): Promise<void> {
        patchState(store, { error: null });
        try {
          const restored = await documentsService.restoreDocument({ notebookId, documentId });
          patchState(store, {
            documents: [...store.documents(), restored],
            lastDeleted: store.lastDeleted()?.id === documentId ? null : store.lastDeleted(),
          });
        } catch (err) {
          patchState(store, { error: errorMessage(err, 'Failed to restore Document.') });
        }
      },

      async downloadDocumentVersion(notebookId: string, document: Document): Promise<void> {
        patchState(store, { error: null });
        try {
          await transferService.downloadDocumentVersion(
            notebookId,
            document.id,
            document.latestVersion.id,
            document.filename,
          );
        } catch (err) {
          patchState(store, { error: errorMessage(err, 'Failed to download Document.') });
        }
      },

      /**
       * Follows one Notebook's live app events so a Document's status badge
       * tracks the background pipeline with no page refresh (NBK-6).
       *
       * Only this Notebook's topic is requested, and only the event types
       * this store understands are acted on — the stream itself carries
       * everything, including event types belonging to other features.
       */
      watchNotebook(notebookId: string): void {
        this.stopWatching();
        watching = appEvents.stream([`notebook:${notebookId}`]).subscribe((event) => {
          const change = asStatusChange(event);
          if (!change) return;
          patchState(store, {
            documents: store.documents().map((document) => {
              if (document.id !== change.documentId) return document;
              // The badge shows the *latest* Version's status, so a late
              // event about a Version that has since been superseded by a
              // re-upload must not drag it backwards.
              if (document.latestVersion.id !== change.versionId) return document;
              return { ...document, status: change.status };
            }),
          });
        });
      },

      /** Closes the live connection opened by `watchNotebook`. */
      stopWatching(): void {
        watching?.unsubscribe();
        watching = null;
      },
      };
    },
  ),
);
