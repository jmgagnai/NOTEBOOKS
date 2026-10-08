import { ChangeDetectionStrategy, Component, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { CopycatMark } from '../shared/copycat-mark';

/**
 * What an empty Notebook's Documents panel shows where the list would be
 * (NBK-49, spec 03 "Empty state"): the first step, said and offered in
 * place. Its "Add Documents" is a second, secondary-styled way to the one
 * picker the page header owns, so it only asks — `add` — and the page opens
 * that same input; a second file input here would have to duplicate the
 * accepted types and the disabled-while-a-batch-runs rule.
 *
 * The cat mark stands where spec 03 had a Documents icon (NBK-62, spec 06
 * "Empty states").
 *
 * "No Documents yet." stays a text node of its own: it is the line the page
 * specs wait on for an empty Notebook to have loaded.
 */
@Component({
  selector: 'app-documents-empty-state',
  imports: [MatButtonModule, MatIconModule, CopycatMark],
  template: `
    <app-copycat-mark />
    <p class="documents-empty-state__text">
      <span>No Documents yet.</span> Add Documents to start asking questions.
    </p>
    <button mat-stroked-button type="button" (click)="add.emit()">
      <mat-icon svgIcon="add" />
      Add Documents
    </button>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      padding: 32px 16px;
      text-align: center;
    }

    .documents-empty-state__text {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DocumentsEmptyState {
  /** The user asked to pick files; the page opens its picker. */
  readonly add = output<void>();
}
