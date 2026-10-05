import { Component, computed, inject, OnInit } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Document, DocumentsStore } from '../documents/documents.store';
import { NotebooksStore } from './notebooks.store';

/**
 * A Notebook's detail view (NBK-5): shows its Documents, with upload,
 * delete, restore, and download actions. Notebooks have no dedicated
 * `GET /notebooks/:id` endpoint, so the Notebook itself (just its title,
 * for the page heading) is looked up from `NotebooksStore`'s already-loaded
 * list by route id, the same list the top-level Notebooks page uses.
 */
@Component({
  selector: 'app-notebook-detail-page',
  standalone: true,
  imports: [MatButtonModule, MatCardModule, MatListModule, MatProgressSpinnerModule, RouterLink],
  templateUrl: './notebook-detail-page.html',
  styleUrl: './notebook-detail-page.scss',
})
export class NotebookDetailPage implements OnInit {
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
