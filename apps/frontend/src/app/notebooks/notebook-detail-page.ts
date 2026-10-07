import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ChatPanel } from '../chat/chat-panel';
import {
  ConflictChoice,
  Document,
  DocumentsStore,
  UploadItemStatus,
} from '../documents/documents.store';
import { UPLOAD_ACCEPT } from '../documents/upload-rules';
import { NotebooksStore } from './notebooks.store';

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
  imports: [
    ChatPanel,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatProgressSpinnerModule,
    RouterLink,
  ],
  templateUrl: './notebook-detail-page.html',
  styleUrl: './notebook-detail-page.scss',
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
   * The conflict dialog's "apply to all remaining conflicts" tick (NBK-19).
   * Page state, not store state: it is part of the answer being composed,
   * and is sent with it.
   */
  protected readonly applyToAll = signal(false);

  /** Answers the open conflict dialog, with the tick as it stands. */
  protected answerConflict(choice: ConflictChoice): void {
    this.store.answerConflict(choice, this.applyToAll());
    this.applyToAll.set(false);
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
