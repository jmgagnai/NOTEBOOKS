import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { Subscription } from 'rxjs';
import { DocumentsService } from '../api/services/documents.service';
import { AppEvent, AppEventsService } from '../events/app-events.service';
import { errorMessage } from '../shared/error-message';
import { DocumentTransferService } from './document-transfer.service';
import {
  FOLDER_SKIP_REASON,
  MAX_UPLOAD_BATCH_FILES,
  uploadCapExceededMessage,
  uploadSkipReason,
} from './upload-rules';

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
  if (
    typeof documentId !== 'string' ||
    typeof versionId !== 'string' ||
    typeof status !== 'string'
  ) {
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

// One *named* Document Version opened on its own, as
// `GET .../documents/:documentId/versions/:versionId` returns it — what
// following a Citation reads. Every artifact here belongs to the Version
// named in the path, which is the whole point: per GLOSSARY.md a Citation
// "opens that exact Version at that location, even after newer Versions
// exist", and an Executive Summary or a version badge from the *current*
// Version would be describing a different document than the content beside
// it.
export interface DocumentVersionDetail {
  documentId: string;
  notebookId: string;
  filename: string;
  documentCreatedAt: string;
  version: DocumentVersion;
  status: DocumentStatus;
  abstract: string | null;
  chatSnippet: string | null;
  executiveSummary: string | null;
  metadata: Record<string, unknown> | null;
  isLatestVersion: boolean;
  latestVersionNumber: number;
}

/**
 * The Document an opened page is showing, whichever way it was opened.
 *
 * One view model for both reads, deliberately. The page renders the same
 * things either way — a filename, a status badge, a version number, the
 * extracted metadata, the Executive Summary, and an action to expand to the
 * content — and the only question that ever differs is *which Version* all of
 * that describes. Making that a field (`version`) rather than two shapes is
 * what stops a template from reaching for `latestVersion` on a page that is
 * deliberately not showing the latest Version, which is exactly how the
 * blended page happened.
 *
 * `isLatestVersion` and `latestVersionNumber` let the page say where the
 * reader is standing in the Document's history without a second request.
 */
export interface OpenDocument {
  id: string;
  notebookId: string;
  filename: string;
  /** The ingestion status of `version` — not of the Document's latest. */
  status: DocumentStatus;
  abstract: string | null;
  chatSnippet: string | null;
  executiveSummary: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  /** The Version every other field on this object describes. */
  version: DocumentVersion;
  isLatestVersion: boolean;
  latestVersionNumber: number;
}

/** The latest-Version read, as the page's view model. */
function fromDocumentDetail(detail: DocumentDetail): OpenDocument {
  return {
    id: detail.id,
    notebookId: detail.notebookId,
    filename: detail.filename,
    status: detail.status,
    abstract: detail.abstract,
    chatSnippet: detail.chatSnippet,
    executiveSummary: detail.executiveSummary,
    metadata: detail.metadata,
    createdAt: detail.createdAt,
    version: detail.latestVersion,
    // This read is *defined* as "the latest Version", so it is by
    // construction, not a claim needing a second lookup.
    isLatestVersion: true,
    latestVersionNumber: detail.latestVersion.versionNumber,
  };
}

/** The Version-scoped read, as the same view model. */
function fromVersionDetail(detail: DocumentVersionDetail): OpenDocument {
  return {
    id: detail.documentId,
    notebookId: detail.notebookId,
    filename: detail.filename,
    status: detail.status,
    abstract: detail.abstract,
    chatSnippet: detail.chatSnippet,
    executiveSummary: detail.executiveSummary,
    metadata: detail.metadata,
    createdAt: detail.documentCreatedAt,
    version: detail.version,
    isLatestVersion: detail.isLatestVersion,
    latestVersionNumber: detail.latestVersionNumber,
  };
}

// The Converted Markdown of one Version, fetched only when a reader expands
// past the Executive Summary. Held separately from the Document because it
// can run past 200 pages — nothing should load it by accident.
export interface DocumentContent {
  versionId: string;
  markdown: string | null;
}

/**
 * Where one file of an upload batch is (NBK-16). `uploaded` and
 * `new-version` are both successes — per GLOSSARY.md a filename that already
 * exists in the Notebook "creates a new Version of that Document rather than
 * a separate one", and the summary counts the two apart. `skipped` is decided
 * in the browser before anything is sent; `failed` is a request that was sent
 * and did not land.
 */
export type UploadItemStatus =
  'waiting' | 'uploading' | 'uploaded' | 'new-version' | 'failed' | 'skipped';

/** One file of an upload batch, in selection order. */
export interface UploadItem {
  /** Stable within the batch, for rendering; not a Document id. */
  id: string;
  file: File;
  status: UploadItemStatus;
  /** Why it was skipped or failed; null otherwise. */
  reason: string | null;
  /**
   * Set once the user has answered this file's conflict dialog with New
   * Version (NBK-19). Until then a `waiting` file whose name is an existing
   * Document is not taken by an upload worker.
   */
  confirmedNewVersion?: boolean;
}

/** What the user chose in the conflict dialog (NBK-19). */
export type ConflictChoice = 'new-version' | 'skip';

/** The conflict dialog currently open, if any (NBK-19). */
export interface UploadConflict {
  itemId: string;
  filename: string;
}

/** The reason on a file skipped from the conflict dialog (NBK-19). */
export const NAME_ALREADY_EXISTS_REASON = 'Name already exists in this Notebook; not uploaded.';

/**
 * One multi-file upload (NBK-16). Held in this root-provided store rather
 * than the page so it survives in-app navigation. A batch is *running* while
 * any item is still `waiting` or `uploading` — see `batchRunning`.
 */
export interface UploadBatch {
  notebookId: string;
  items: UploadItem[];
  /**
   * The answer to apply to every later conflict in this batch without
   * asking, once the user ticked "apply to all remaining conflicts" (NBK-19).
   */
  conflictAnswer?: ConflictChoice;
}

/** The counts the end-of-batch summary line reports. */
export interface UploadBatchSummary {
  uploaded: number;
  newVersions: number;
  skipped: number;
  failed: number;
}

/** How many upload requests the browser keeps in flight at once. */
const UPLOAD_CONCURRENCY = 3;

interface DocumentsState {
  documents: Document[];
  // Which Notebook `documents` is the list of, once a load has landed. The
  // store is root-provided and holds one list, but an upload batch outlives
  // the page that started it (NBK-17), so a file can land while another
  // Notebook's list is in here — and must not be added to it.
  documentsNotebookId: string | null;
  loading: boolean;
  batch: UploadBatch | null;
  // The conflict dialog currently open for a file of `batch` (NBK-19); at
  // most one at a time.
  conflict: UploadConflict | null;
  // Why the last selection was refused outright (over the file cap), if it
  // was. Separate from `error` because it is about a selection, not a call.
  uploadRefused: string | null;
  error: string | null;
  // The currently open Document, and its content once expanded.
  openDocument: OpenDocument | null;
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
  documentsNotebookId: null,
  loading: false,
  batch: null,
  conflict: null,
  uploadRefused: null,
  error: null,
  openDocument: null,
  openDocumentLoading: false,
  openContent: null,
  openContentLoading: false,
  lastDeleted: null,
};

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
  withComputed(({ batch }) => ({
    /** True while any file of the current batch is still waiting or in flight. */
    batchRunning: computed(
      () =>
        batch()?.items.some((item) => item.status === 'waiting' || item.status === 'uploading') ??
        false,
    ),
    /** The counts behind the summary line, or null when there is no batch. */
    batchSummary: computed((): UploadBatchSummary | null => {
      const items = batch()?.items;
      if (!items) return null;
      const count = (status: UploadItemStatus) =>
        items.filter((item) => item.status === status).length;
      const newVersions = count('new-version');
      return {
        uploaded: count('uploaded') + newVersions,
        newVersions,
        skipped: count('skipped'),
        failed: count('failed'),
      };
    }),
  })),
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

      /** Rewrites one item of the current batch. */
      function patchItem(id: string, change: Partial<UploadItem>): void {
        const batch = store.batch();
        if (!batch) return;
        patchState(store, {
          batch: {
            ...batch,
            items: batch.items.map((item) => (item.id === id ? { ...item, ...change } : item)),
          },
        });
      }

      // The filenames the current batch's files are checked against for a
      // conflict (NBK-19): the Notebook's undeleted Documents as they were
      // when the batch started, plus the batch's own files as they land.
      // Snapshotted per batch rather than read from `documents`, because
      // that list is whichever Notebook was opened last while the batch
      // kept running (NBK-17) — another Notebook's names are no conflict.
      let batchNames = new Set<string>();

      /** Sends one item's file and records how it landed. */
      async function uploadItem(notebookId: string, item: UploadItem): Promise<void> {
        patchItem(item.id, { status: 'uploading' });
        try {
          const document = await transferService.uploadDocument(notebookId, item.file);
          batchNames.add(document.filename);
          // A re-upload of an existing filename comes back as a new Version
          // of the same Document (same id, incremented versionNumber) rather
          // than a new Document — replace the existing card instead of
          // appending a duplicate, and say so in the panel. Only this
          // Notebook's list is touched: while another Notebook is open the
          // landed Document is left for its next load to bring in.
          const listIsThisNotebooks = store.documentsNotebookId() === notebookId;
          const existing =
            listIsThisNotebooks && store.documents().some((d) => d.id === document.id);
          if (listIsThisNotebooks) {
            patchState(store, {
              documents: existing
                ? store.documents().map((d) => (d.id === document.id ? document : d))
                : [...store.documents(), document],
            });
          }
          patchItem(item.id, {
            status:
              existing || document.latestVersion.versionNumber > 1 ? 'new-version' : 'uploaded',
          });
        } catch (err) {
          patchItem(item.id, {
            status: 'failed',
            reason: errorMessage(err, 'Failed to upload Document.'),
          });
        }
      }

      /**
       * Whether sending `item` now would make a new Version of an existing
       * Document (NBK-19). Decided in the browser against `batchNames` —
       * taken from the Document list, which `GET .../documents` fills
       * without soft-deleted Documents, so a name that only a deleted
       * Document had is no conflict. The race with another user's concurrent
       * upload is accepted: the backend versions silently in that case.
       */
      function conflicts(item: UploadItem): boolean {
        return batchNames.has(item.file.name);
      }

      /** A `waiting` item an upload worker may take: no conflict, or one the user answered. */
      function nextSendable(): UploadItem | undefined {
        return store
          .batch()
          ?.items.find(
            (item) => item.status === 'waiting' && (item.confirmedNewVersion || !conflicts(item)),
          );
      }

      /** A `waiting` item that still needs an answer before it can be sent. */
      function nextUnanswered(): UploadItem | undefined {
        return store
          .batch()
          ?.items.find(
            (item) => item.status === 'waiting' && !item.confirmedNewVersion && conflicts(item),
          );
      }

      // How many upload workers are running right now, across every call to
      // `runWorkers` — so an answered conflict can start a worker without
      // ever exceeding `UPLOAD_CONCURRENCY`.
      let activeWorkers = 0;

      /**
       * Starts upload workers, up to `UPLOAD_CONCURRENCY` running at once, as
       * long as there is a sendable item for each. Each worker takes the next
       * sendable item, in selection order, as soon as its own request
       * settles, so a slow file never holds the others back. Resolves when
       * the workers it started are done.
       */
      async function runWorkers(): Promise<void> {
        const notebookId = store.batch()?.notebookId;
        if (!notebookId) return;
        async function worker(): Promise<void> {
          activeWorkers += 1;
          try {
            for (;;) {
              const next = nextSendable();
              if (!next) return;
              await uploadItem(notebookId!, next);
            }
          } finally {
            activeWorkers -= 1;
          }
        }
        const started: Promise<void>[] = [];
        while (activeWorkers < UPLOAD_CONCURRENCY && nextSendable()) {
          started.push(worker());
        }
        await Promise.all(started);
      }

      // The open dialog's answer is delivered through here (NBK-19); null
      // while no dialog is open. Only one asker runs at a time, hence only
      // one dialog.
      let deliverAnswer:
        ((answer: { choice: ConflictChoice; applyToAll: boolean }) => void) | null = null;
      let asking = false;

      /**
       * Walks the batch's unanswered conflicts one at a time (NBK-19): opens
       * the dialog for the next one, waits for the answer, applies it, and
       * moves on. It is not an upload worker — a file waiting on its dialog
       * holds no upload slot, and the workers keep sending the other files
       * meanwhile. A New Version answer makes the file sendable and starts a
       * worker for it if a slot is free; once "apply to all" is ticked the
       * rest of the batch's conflicts are answered without a dialog.
       */
      async function askConflicts(): Promise<void> {
        if (asking) return;
        asking = true;
        const followUps: Promise<void>[] = [];
        try {
          for (;;) {
            const next = nextUnanswered();
            if (!next) return;
            let choice = store.batch()?.conflictAnswer;
            if (!choice) {
              patchState(store, { conflict: { itemId: next.id, filename: next.file.name } });
              const answer = await new Promise<{ choice: ConflictChoice; applyToAll: boolean }>(
                (resolve) => (deliverAnswer = resolve),
              );
              deliverAnswer = null;
              patchState(store, { conflict: null });
              choice = answer.choice;
              const batch = store.batch();
              if (answer.applyToAll && batch) {
                patchState(store, { batch: { ...batch, conflictAnswer: choice } });
              }
              // The batch may have been cancelled while the dialog was open
              // (NBK-17): its item is then already skipped as cancelled, and
              // the answer that withdrew the dialog is not one to apply.
              const current = batch?.items.find((item) => item.id === next.id);
              if (current?.status !== 'waiting') continue;
            }
            if (choice === 'skip') {
              patchItem(next.id, { status: 'skipped', reason: NAME_ALREADY_EXISTS_REASON });
            } else {
              patchItem(next.id, { confirmedNewVersion: true });
              followUps.push(runWorkers());
            }
          }
        } finally {
          asking = false;
          await Promise.all(followUps);
        }
      }

      /**
       * Sends the current batch: `UPLOAD_CONCURRENCY` upload workers over the
       * sendable items, and beside them the conflict dialogs, one at a time
       * (NBK-19). Resolves when the batch is no longer running.
       */
      async function drainBatch(): Promise<void> {
        if (!store.batch()) return;
        await Promise.all([runWorkers(), askConflicts()]);
      }

      return {
        async loadDocuments(notebookId: string): Promise<void> {
          patchState(store, { loading: true, error: null });
          try {
            const documents = await documentsService.listDocuments({ notebookId });
            patchState(store, { documents, documentsNotebookId: notebookId, loading: false });
          } catch (err) {
            patchState(store, {
              loading: false,
              error: errorMessage(err, 'Failed to load Documents.'),
            });
          }
        },

        /**
         * Loads one Document's *latest* Version with its metadata and summaries
         * (NBK-7) — what opening a Document from the Notebook shows.
         * Deliberately a separate call from `loadDocuments`: the Executive
         * Summary runs to 1-2 pages, so it belongs on an opened Document and
         * not on every card in a list.
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
            const detail = (await documentsService.getDocument({
              notebookId,
              documentId,
            })) as DocumentDetail;
            patchState(store, {
              openDocument: fromDocumentDetail(detail),
              openDocumentLoading: false,
            });
          } catch (err) {
            patchState(store, {
              openDocumentLoading: false,
              error: errorMessage(err, 'Failed to load Document.'),
            });
          }
        },

        /**
         * Loads one *named* Document Version with its own metadata and
         * summaries — what following a Citation opens (NBK-12).
         *
         * A different endpoint, not the same one with a parameter, because what
         * it answers is a different question: `loadDocument` says what this
         * Document says *now*, and this says what that Version said. Mixing the
         * two is what produced a page showing a pinned Version's Converted
         * Markdown beneath the latest Version's Executive Summary, metadata and
         * version badge — and GLOSSARY.md's promise that a Citation "opens that
         * exact Version at that location" is about the page a reader lands on,
         * not only about which bytes of Markdown it fetched.
         */
        async loadDocumentVersion(
          notebookId: string,
          documentId: string,
          versionId: string,
        ): Promise<void> {
          patchState(store, {
            openDocumentLoading: true,
            error: null,
            openDocument: null,
            openContent: null,
          });
          try {
            const detail = (await documentsService.getDocumentVersion({
              notebookId,
              documentId,
              versionId,
            })) as DocumentVersionDetail;
            patchState(store, {
              openDocument: fromVersionDetail(detail),
              openDocumentLoading: false,
            });
          } catch (err) {
            patchState(store, {
              openDocumentLoading: false,
              error: errorMessage(err, 'Failed to load this Document Version.'),
            });
          }
        },

        /**
         * Fetches a Version's Converted Markdown — the "expand past the
         * Executive Summary" step (NBK-7). Never called on open: this is the
         * payload that can run past 200 pages, so it is only ever fetched
         * because a reader asked for it, and only once per Version.
         */
        async loadDocumentContent(
          notebookId: string,
          documentId: string,
          versionId: string,
        ): Promise<void> {
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

        /**
         * Uploads `files` into a Notebook as one batch (NBK-16): one request
         * per file to the single-file route, at most `UPLOAD_CONCURRENCY` in
         * flight, in selection order. Each file lands or fails on its own.
         * Resolves when nothing is left waiting or in flight.
         *
         * `options.folders` names the entries of `files` that are dropped
         * folders (NBK-18) — a file manager hands a directory over as a File
         * too, which is why they arrive in the same list. They are listed as
         * skipped with the folder message and count toward nothing else:
         * not the cap, and not the names a later duplicate is checked against.
         */
        async uploadDocuments(
          notebookId: string,
          files: File[],
          options: { folders?: ReadonlySet<File> } = {},
        ): Promise<void> {
          // Filtered in the browser before anything is sent, so a stray file
          // costs no request and blocks nothing (see upload-rules.ts).
          const accepted = new Set<string>();
          const items: UploadItem[] = files.map((file, index) => {
            const reason = options.folders?.has(file)
              ? FOLDER_SKIP_REASON
              : uploadSkipReason(file, accepted);
            if (!reason) accepted.add(file.name);
            return {
              id: `${index}`,
              file,
              status: reason ? 'skipped' : 'waiting',
              reason,
            };
          });
          const uploadable = accepted.size;
          if (uploadable > MAX_UPLOAD_BATCH_FILES) {
            // The whole selection is refused, not trimmed: silently sending
            // the first 100 would leave the user guessing which ones went.
            patchState(store, {
              batch: null,
              uploadRefused: uploadCapExceededMessage(uploadable),
            });
            return;
          }
          // The names conflicts are judged against, fixed now: the list is
          // this Notebook's unless a load is still on its way, in which case
          // there is nothing known to conflict with yet.
          batchNames = new Set(
            store.documentsNotebookId() === notebookId
              ? store.documents().map((document) => document.filename)
              : [],
          );
          patchState(store, { batch: { notebookId, items }, uploadRefused: null, error: null });
          await drainBatch();
        },

        /**
         * Re-queues every `failed` item of the current batch and sends them
         * again (NBK-17), through the same 3-at-a-time flow and without the
         * user re-selecting anything. Items that landed or were skipped are
         * untouched. Resolves when the batch is no longer running.
         */
        async retryFailed(): Promise<void> {
          const batch = store.batch();
          if (!batch) return;
          patchState(store, {
            batch: {
              ...batch,
              items: batch.items.map((item): UploadItem =>
                item.status === 'failed' ? { ...item, status: 'waiting', reason: null } : item,
              ),
            },
          });
          await drainBatch();
        },

        /**
         * Stops the files of the current batch that have not been sent yet
         * (NBK-17): every `waiting` item becomes `skipped` with a cancelled
         * reason. Requests already in flight are left to finish — nothing is
         * aborted, and nothing already stored is removed. The workers in
         * `drainBatch` find no `waiting` item afterwards and stop by
         * themselves.
         *
         * A file waiting on its conflict dialog (NBK-19) is a `waiting` file
         * too, so it is cancelled with the rest — and its open dialog is
         * withdrawn: the question is moot, and the asker loop is parked on
         * that answer, so settling it is what lets the batch finish.
         */
        cancelBatch(): void {
          const batch = store.batch();
          if (!batch) return;
          patchState(store, {
            batch: {
              ...batch,
              items: batch.items.map((item): UploadItem =>
                item.status === 'waiting'
                  ? { ...item, status: 'skipped', reason: 'Cancelled before it was sent.' }
                  : item,
              ),
            },
            conflict: null,
          });
          // After the items above are cancelled, so the asker finds the
          // dialog's item no longer waiting and nothing further to ask.
          deliverAnswer?.({ choice: 'skip', applyToAll: false });
        },

        /**
         * Drops a finished batch from the panel (NBK-17). A running one stays:
         * the panel is where its Cancel lives, and the Documents it has
         * stored are in the list regardless.
         */
        dismissBatch(): void {
          if (store.batchRunning()) return;
          patchState(store, { batch: null });
        },

        /**
         * Answers the open conflict dialog (NBK-19): New Version sends the
         * file as a new Version of the existing Document, Skip lists it as
         * skipped. With `applyToAll`, the same answer settles every later
         * conflict of this batch without asking.
         */
        answerConflict(choice: ConflictChoice, applyToAll = false): void {
          deliverAnswer?.({ choice, applyToAll });
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
              .find(
                (document) =>
                  document.id === change.documentId &&
                  document.latestVersion.id === change.versionId,
              );
            // The badge shows the *latest* Version's status, so a late event
            // about a Version that has since been superseded by a re-upload
            // must not drag it backwards.
            if (!target) return;

            patchState(store, {
              documents: store
                .documents()
                .map((document) =>
                  document === target ? { ...document, status: change.status } : document,
                ),
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
                      .map((document) =>
                        document.id === fresh.id ? { ...document, ...fresh } : document,
                      ),
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
  // The tab-close warning (NBK-17). It lives here, on the root-provided
  // store, and not on the Notebook page: a batch keeps running while the
  // user browses to another page of the app, and closing the tab from there
  // would lose it just the same. The browser shows its leave-page dialog
  // only when `beforeunload` is cancelled, so cancelling it while the batch
  // runs is the whole mechanism — the wording is the browser's, not ours.
  withHooks((store) => {
    const warnBeforeUnload = (event: Event): void => {
      if (store.batchRunning()) event.preventDefault();
    };
    return {
      onInit() {
        window.addEventListener('beforeunload', warnBeforeUnload);
      },
      onDestroy() {
        window.removeEventListener('beforeunload', warnBeforeUnload);
      },
    };
  }),
);
