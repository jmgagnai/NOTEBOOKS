import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { UndoSnackBar } from '../shared/undo-snack-bar';
import { Notebook, NotebooksStore } from './notebooks.store';

/**
 * What "Create Notebook" names a new Notebook (spec 05 "Create"): the create
 * request needs a non-empty title, and the user renames it in place in the
 * Notebook header it opens on.
 */
const UNTITLED_NOTEBOOK = 'Untitled Notebook';

/**
 * The Notebooks home (NBK-4, re-laid out as a grid of cards by NBK-55): lets
 * any authenticated user create, open, rename, delete and restore Notebooks.
 * Per ADR-0001 there is no ownership restriction in the UI either: every
 * Notebook shown here can be renamed/deleted/restored by whoever is logged
 * in, regardless of who created it.
 */
@Component({
  selector: 'app-notebooks-page',
  standalone: true,
  imports: [
    DatePipe,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    NgTemplateOutlet,
    RouterLink,
  ],
  templateUrl: './notebooks-page.html',
  styleUrl: './notebooks-page.scss',
})
export class NotebooksPage implements OnInit {
  protected readonly store = inject(NotebooksStore);
  private readonly router = inject(Router);
  private readonly undoSnackBar = inject(UndoSnackBar);

  // The empty state carries the Create button itself (spec 05), so the
  // header's copy steps aside rather than offering it twice.
  protected readonly isEmpty = computed(
    () => !this.store.loading() && !this.store.error() && this.store.notebooks().length === 0,
  );

  // Guards against a double click creating two Untitled Notebooks.
  protected readonly creating = signal(false);

  protected readonly editingId = signal<string | null>(null);
  protected readonly editingTitle = signal('');

  ngOnInit(): void {
    void this.store.loadNotebooks();
  }

  protected async create(): Promise<void> {
    if (this.creating()) return;
    this.creating.set(true);
    try {
      const id = await this.store.createNotebook(UNTITLED_NOTEBOOK);
      if (id) await this.router.navigate(['/notebooks', id]);
    } finally {
      this.creating.set(false);
    }
  }

  protected startRename(notebook: Notebook): void {
    this.editingId.set(notebook.id);
    this.editingTitle.set(notebook.title);
  }

  protected onEditTitleInput(event: Event): void {
    this.editingTitle.set((event.target as HTMLInputElement).value);
  }

  protected cancelRename(): void {
    this.editingId.set(null);
  }

  protected saveRename(id: string): void {
    const title = this.editingTitle().trim();
    this.editingId.set(null);
    if (!title) return;
    void this.store.renameNotebook(id, title);
  }

  protected async delete(id: string): Promise<void> {
    await this.store.deleteNotebook(id);
    // `lastDeleted` holding this Notebook is the store's own signal that the
    // delete went through; a failure leaves it as it was and sets `error`.
    const deleted = this.store.lastDeleted();
    if (deleted?.id !== id) return;
    this.undoSnackBar.open(deleted.title, () => this.restore(deleted.id));
  }

  protected restore(id: string): void {
    void this.store.restoreNotebook(id);
  }
}
