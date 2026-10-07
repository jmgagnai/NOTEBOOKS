import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ChatPanel } from '../chat/chat-panel';
import { Document, DocumentsStore, UploadItemStatus } from '../documents/documents.store';
import { UPLOAD_ACCEPT } from '../documents/upload-rules';
import { NotebooksStore } from './notebooks.store';

/**
 * What a drop carried (NBK-18): every entry as a File, in drop order, and
 * which of those Files are really folders.
 *
 * A file manager hands a directory over like any file — a File with the
 * folder's name, no type and (usually) no size — so `dataTransfer.files`
 * alone cannot tell the two apart, and a size-0 typeless *file* is a
 * perfectly good upload. What does tell them apart is the entry behind each
 * `DataTransferItem`: `webkitGetAsEntry()` returns a FileSystemEntry whose
 * `isDirectory` is the answer. The folder keeps its File so it can be listed
 * in the batch under its own name. A browser without `webkitGetAsEntry`
 * (none current) simply has everything treated as a file, and the backend
 * refuses the folder's typeless File as unsupported.
 */
function droppedEntries(dataTransfer: DataTransfer | null): {
  files: File[];
  folders: Set<File>;
} {
  const files: File[] = [];
  const folders = new Set<File>();
  const items = Array.from(dataTransfer?.items ?? []);
  if (items.length === 0) {
    return { files: Array.from(dataTransfer?.files ?? []), folders };
  }
  items.forEach((item, index) => {
    if (item.kind !== 'file') return;
    const entry = item.webkitGetAsEntry?.();
    // `getAsFile()` and `files[index]` are the same File in a real drop;
    // the second is a fallback for a DataTransfer that only filled one.
    const file =
      item.getAsFile() ?? dataTransfer?.files?.[index] ?? new File([], entry?.name ?? 'folder');
    files.push(file);
    if (entry?.isDirectory) folders.add(file);
  });
  return { files, folders };
}

/**
 * A Notebook's detail view (NBK-5): shows its Documents as cards, with
 * upload, open, delete, restore, and download actions. Notebooks have no
 * dedicated `GET /notebooks/:id` endpoint, so the Notebook itself (just its
 * title, for the page heading) is looked up from `NotebooksStore`'s
 * already-loaded list by route id, the same list the top-level Notebooks page
 * uses.
 *
 * Each card carries that Document's Abstract (NBK-7) — the summary
 * GLOSSARY.md writes "to be skimmed in a list" — and links to the Document
 * itself, where the Executive Summary and the full converted content live.
 *
 * While open, it also follows this Notebook's live app events (NBK-6) so a
 * Document's status badge tracks the background pipeline without a refresh.
 *
 * Below the Documents sits the chat panel (NBK-10) — the Notebook's Chat
 * Threads and the open Thread. Per NBK-1 a Notebook's detail page is
 * "composed of a sources panel ... [and] a chat panel", so the two live on
 * one page; the chat panel owns its own store and data loading.
 */
@Component({
  selector: 'app-notebook-detail-page',
  standalone: true,
  imports: [ChatPanel, MatButtonModule, MatCardModule, MatProgressSpinnerModule, RouterLink],
  templateUrl: './notebook-detail-page.html',
  styleUrl: './notebook-detail-page.scss',
  // The whole page is the drop target (NBK-18), so the drag events are
  // listened for on the host rather than on one box inside it.
  host: {
    '(dragenter)': 'onDragEnter($event)',
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'onDragLeave($event)',
    '(drop)': 'onDrop($event)',
  },
})
export class NotebookDetailPage implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);

  protected readonly notebooksStore = inject(NotebooksStore);
  protected readonly store = inject(DocumentsStore);

  protected readonly notebookId = this.route.snapshot.paramMap.get('notebookId')!;
  protected readonly notebook = computed(
    () => this.notebooksStore.notebooks().find((n) => n.id === this.notebookId) ?? null,
  );

  ngOnInit(): void {
    void this.notebooksStore.loadNotebooks();
    void this.store.loadDocuments(this.notebookId);
    this.store.watchNotebook(this.notebookId);
  }

  ngOnDestroy(): void {
    // The store is root-provided and outlives this page, so the live
    // connection has to be closed explicitly or it would leak across
    // navigations.
    this.store.stopWatching();
  }

  /** The picker only offers the accepted document types (NBK-16). */
  protected readonly accept = UPLOAD_ACCEPT;

  /** The upload batch, if the one in the store belongs to this Notebook. */
  protected readonly batch = computed(() => {
    const batch = this.store.batch();
    return batch?.notebookId === this.notebookId ? batch : null;
  });

  /** The end-of-batch summary line, once nothing is waiting or in flight. */
  protected readonly batchSummaryLine = computed(() => {
    const summary = this.store.batchSummary();
    if (!summary || !this.batch() || this.store.batchRunning()) return null;
    const uploaded =
      summary.newVersions > 0
        ? `${summary.uploaded} uploaded (${summary.newVersions} as new Versions)`
        : `${summary.uploaded} uploaded`;
    return `${uploaded}, ${summary.skipped} skipped, ${summary.failed} failed`;
  });

  protected onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;
    void this.store.uploadDocuments(this.notebookId, files);
    input.value = '';
  }

  /**
   * How many elements of the page the dragged files are currently "inside"
   * (NBK-18). A drag fires `dragenter` on each element it moves over and
   * `dragleave` on the one it left, in that order, so a single boolean would
   * flicker off at every boundary; counting enters against leaves makes the
   * state hold until the drag leaves the page altogether.
   */
  private dragDepth = 0;

  /** True while files are being dragged over the page. */
  protected readonly dragOver = signal(false);

  /** Whether a drag carries files at all — text or links dragged over the page are not a drop. */
  private carriesFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }

  protected onDragEnter(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.dragOver.set(true);
  }

  protected onDragOver(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    // Cancelling `dragover` is what tells the browser the drop is allowed.
    event.preventDefault();
  }

  protected onDragLeave(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dragOver.set(false);
  }

  /**
   * A drop goes through the same `uploadDocuments` as the picker, so the
   * skipping rules and the cap apply unchanged (NBK-18).
   */
  protected onDrop(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    // Cancelled, or the browser would navigate to the dropped file.
    event.preventDefault();
    this.dragDepth = 0;
    this.dragOver.set(false);
    const { files, folders } = droppedEntries(event.dataTransfer);
    if (files.length === 0) return;
    void this.store.uploadDocuments(this.notebookId, files, { folders });
  }

  /** How an item's status reads in the progress panel. */
  protected statusLabel(status: UploadItemStatus): string {
    return status === 'new-version' ? 'new version' : status;
  }

  protected delete(document: Document): void {
    void this.store.deleteDocument(this.notebookId, document.id);
  }

  protected restore(document: Document): void {
    void this.store.restoreDocument(this.notebookId, document.id);
  }

  protected download(document: Document): void {
    void this.store.downloadDocumentVersion(this.notebookId, document);
  }
}
