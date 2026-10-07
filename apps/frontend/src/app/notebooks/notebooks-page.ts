import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { UndoSnackBar } from '../shared/undo-snack-bar';
import { Notebook, NotebooksStore } from './notebooks.store';

/**
 * Lets any authenticated user create, list, rename, delete, and restore
 * Notebooks (NBK-4). Per ADR-0001 there is no ownership restriction in the
 * UI either: every Notebook shown here can be renamed/deleted/restored by
 * whoever is logged in, regardless of who created it.
 */
@Component({
  selector: 'app-notebooks-page',
  standalone: true,
  imports: [
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatListModule,
    MatProgressSpinnerModule,
    RouterLink,
  ],
  templateUrl: './notebooks-page.html',
  styleUrl: './notebooks-page.scss',
})
export class NotebooksPage implements OnInit {
  protected readonly store = inject(NotebooksStore);
  private readonly undoSnackBar = inject(UndoSnackBar);

  protected readonly newTitle = signal('');

  protected readonly editingId = signal<string | null>(null);
  protected readonly editingTitle = signal('');

  ngOnInit(): void {
    void this.store.loadNotebooks();
  }

  protected onNewTitleInput(event: Event): void {
    this.newTitle.set((event.target as HTMLInputElement).value);
  }

  protected submitCreate(event: Event): void {
    event.preventDefault();
    const title = this.newTitle().trim();
    if (!title) return;
    void this.store.createNotebook(title);
    this.newTitle.set('');
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
