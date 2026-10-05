import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { DocumentsService } from '../api/services/documents.service';
import { DocumentTransferService } from './document-transfer.service';

export interface DocumentVersion {
  id: string;
  versionNumber: number;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

// A Document as returned over the API. See GLOSSARY.md: "a source file
// uploaded into a Notebook, tracked through successive Document Versions."
// `status` is always 'uploaded' for now (NBK-5) — there's no ingestion
// pipeline yet to report any further-along status.
export interface Document {
  id: string;
  notebookId: string;
  filename: string;
  status: 'uploaded';
  createdAt: string;
  latestVersion: DocumentVersion;
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
    ) => ({
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
    }),
  ),
);
