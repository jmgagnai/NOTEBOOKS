import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';

/** What the dialog is asked about. */
export interface DeleteThreadDialogData {
  title: string;
}

/**
 * Confirms deleting a Chat Thread (NBK-95). There is no Undo — only an
 * Administrator can restore a deleted Thread, through the API — so this is
 * the one guard against a slip. Closes with `true` when the user confirms.
 */
@Component({
  selector: 'app-delete-thread-dialog',
  imports: [MatButtonModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title>Delete "{{ data.title }}"?</h2>
    <mat-dialog-content>
      <p>Its messages will no longer be shown to anyone in this Notebook. This can't be undone.</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" [mat-dialog-close]="false">Cancel</button>
      <button
        mat-flat-button
        type="button"
        class="delete-thread-dialog__delete"
        [mat-dialog-close]="true"
      >
        Delete
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    // The destructive action in the error colour (NBK-95), over the primary
    // fill a flat button has by default.
    .delete-thread-dialog__delete {
      --mat-button-filled-container-color: var(--mat-sys-error);
      --mat-button-filled-label-text-color: var(--mat-sys-on-error);
    }
  `,
})
export class DeleteThreadDialog {
  protected readonly data = inject<DeleteThreadDialogData>(MAT_DIALOG_DATA);
}
