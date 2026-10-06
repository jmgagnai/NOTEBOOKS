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
 * Where a Document's latest Version is in the ingestion pipeline. Mirrors the
 * backend's `documentStatusSchema`: stage 1 is conversion (NBK-6), stage 2 is
 * metadata extraction and the three generated summaries (NBK-7), and stage 3
 * is chunking and embeddings (NBK-8). 'ready' is the end of the pipeline —
 * the point at which a Document is safe to rely on for chat.
 */
export type DocumentStatus =
  | 'queued'
  | 'converting'
  | 'converted'
  | 'summarizing'
  | 'summarized'
  | 'indexing'
  | 'ready'
  | 'failed';

// A Document as returned over the API. See GLOSSARY.md: "a source file
// uploaded into a Notebook, tracked through successive Document Versions."
// `status` is its latest Version's ingestion status, which the background
// pipeline (NBK-6, NBK-7) advances — so it changes under the UI's feet, which
// is what `watchNotebook` below is for.
//
// `abstract` is the 50-100 word artifact GLOSSARY.md assigns to "search
// results, search-result previews, and document cards" — the only one of the
// three summaries the list payload carries, because the Executive Summary
// (1-2 pages) and the Converted Markdown (up to 200+ pages) would make
// browsing a Notebook download every document in it. Null until ingestion
// stage 2 has run.
export interface Document {
  id: string;
  notebookId: string;
  filename: string;
  status: DocumentStatus;
  abstract: string | null;
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

// A Document opened on its own (NBK-7): the Document plus its latest
// Version's extracted metadata and the two summaries that don't belong in a
// list. Per GLOSSARY.md the Executive Summary is what a reader sees first,
// "before they choose to view the full converted content".
export interface DocumentDetail extends Document {
  metadata: Record<string, unknown> | null;
  chatSnippet: string | null;
  executiveSummary: string | null;
}

// The Converted Markdown of one Version, fetched only when a reader expands
// past the Executive Summary. Held separately from the Document because it
// can run past 200 pages — nothing should load it by accident.
export interface DocumentContent {
  versionId: string;
  markdown: string | null;
}

interface DocumentsState {
  documents: Document[];
  loading: boolean;
  uploading: boolean;
  error: string | null;
  // The currently open Document, and its content once expanded.
  openDocument: DocumentDetail | null;
  openDocumentLoading: boolean;
  openContent: DocumentContent | null;
  openContentLoading: boolean;
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
  openDocument: null,
  openDocumentLoading: false,
  openContent: null,
  openContentLoading: false,
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

      /** Closes the live connection, if one is open. */
      function stopWatching(): void {
        watching?.unsubscribe();
        watching = null;
      }

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

      /**
       * Loads one Document with its metadata and summaries (NBK-7) — what a
       * Document's own page shows. Deliberately a separate call from
       * `loadDocuments`: the Executive Summary runs to 1-2 pages, so it
       * belongs on an opened Document and not on every card in a list.
       */
      async loadDocument(notebookId: string, documentId: string): Promise<void> {
        // Any previously expanded content belongs to a different Document.
        patchState(store, {
          openDocumentLoading: true,
          error: null,
          openDocument: null,
          openContent: null,
        });
        try {
          const openDocument = (await documentsService.getDocument({
            notebookId,
            documentId,
          })) as DocumentDetail;
          patchState(store, { openDocument, openDocumentLoading: false });
        } catch (err) {
          patchState(store, {
            openDocumentLoading: false,
            error: errorMessage(err, 'Failed to load Document.'),
          });
        }
      },

      /**
       * Fetches a Version's Converted Markdown — the "expand past the
       * Executive Summary" step (NBK-7). Never called on open: this is the
       * payload that can run past 200 pages, so it is only ever fetched
       * because a reader asked for it, and only once per Version.
       */
      async loadDocumentContent(notebookId: string, documentId: string, versionId: string): Promise<void> {
        if (store.openContent()?.versionId === versionId) return;
        patchState(store, { openContentLoading: true, error: null });
        try {
          const openContent = await documentsService.getDocumentVersionContent({
            notebookId,
            documentId,
            versionId,
          });
          patchState(store, { openContent, openContentLoading: false });
        } catch (err) {
          patchState(store, {
            openContentLoading: false,
            error: errorMessage(err, 'Failed to load the Document content.'),
          });
        }
      },

      /** Drops the open Document, so navigating away doesn't leak it. */
      clearOpenDocument(): void {
        patchState(store, { openDocument: null, openContent: null, error: null });
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
        stopWatching();
        watching = appEvents.stream([`notebook:${notebookId}`]).subscribe((event) => {
          const change = asStatusChange(event);
          if (!change) return;
          const target = store
            .documents()
            .find((document) => document.id === change.documentId && document.latestVersion.id === change.versionId);
          // The badge shows the *latest* Version's status, so a late event
          // about a Version that has since been superseded by a re-upload
          // must not drag it backwards.
          if (!target) return;

          patchState(store, {
            documents: store
              .documents()
              .map((document) => (document === target ? { ...document, status: change.status } : document)),
          });

          // An app event carries *what changed*, never bulk data — per
          // ADR-0004 a NOTIFY payload must stay well inside Postgres's
          // 8000-byte cap — so the newly generated Abstract is not in it.
          // Reaching "summarized" (NBK-7) is therefore the cue to re-read
          // this one Document over the normal API, which is exactly the
          // "an event is a hint; re-read the truth" contract the ADR sets.
          if (change.status === 'summarized') {
            void documentsService
              .getDocument({ notebookId, documentId: change.documentId })
              .then((fresh) => {
                patchState(store, {
                  documents: store
                    .documents()
                    .map((document) => (document.id === fresh.id ? { ...document, ...fresh } : document)),
                });
              })
              .catch(() => {
                // The badge is already correct; failing to enrich it with an
                // Abstract is not worth an error banner over a background
                // event the user never asked for.
              });
          }
        });
      },

      /** Closes the live connection opened by `watchNotebook`. */
      stopWatching,
      };
    },
  ),
);
