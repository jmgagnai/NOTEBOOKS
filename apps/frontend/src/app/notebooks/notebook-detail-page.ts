import { Component, computed, inject, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Document, DocumentsStore } from '../documents/documents.store';
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
 */
@Component({
  selector: 'app-notebook-detail-page',
  standalone: true,
  imports: [MatButtonModule, MatCardModule, MatProgressSpinnerModule, RouterLink],
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

  protected onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void this.store.uploadDocument(this.notebookId, file);
    input.value = '';
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
