import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

/** How long the offer to undo a delete stays on screen (spec 01, "Snack bar for undo"). */
export const UNDO_SNACK_BAR_DURATION_MS = 8000;

/**
 * The "<name> deleted — Undo" offer that follows a delete (NBK-33).
 *
 * It is a snack bar rather than a line in the page so the list underneath
 * does not jump when something is deleted, and it is one service rather than
 * a `MatSnackBar.open` in each page so the Notebooks page and the Notebook
 * page cannot drift on wording, duration or placement. The store state behind
 * undo (`lastDeleted`, the restore methods) is untouched: this is presentation
 * only, and the page decides what `restore` does.
 *
 * Material keeps a single snack bar open, so a second delete replaces the
 * first offer; the first delete can then no longer be undone from here, which
 * matches the stores, each of which remembers only its last deletion.
 */
@Injectable({ providedIn: 'root' })
export class UndoSnackBar {
  private readonly snackBar = inject(MatSnackBar);

  open(name: string, restore: () => void): void {
    this.snackBar
      .open(`${name} deleted`, 'Undo', {
        duration: UNDO_SNACK_BAR_DURATION_MS,
        horizontalPosition: 'center',
        verticalPosition: 'bottom',
      })
      .onAction()
      .subscribe(restore);
  }
}
