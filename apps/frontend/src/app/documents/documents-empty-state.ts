import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CopycatMark } from '../shared/copycat-mark';

/**
 * What an empty Notebook's Documents panel shows where the list would be
 * (NBK-49, spec 03 "Empty state"): the first step, said in place. It had
 * its own "Add Documents" until NBK-82 (spec 07 story 52) put the panel's
 * one directly above it, so it only says what to do.
 *
 * The cat mark stands where spec 03 had a Documents icon (NBK-62, spec 06
 * "Empty states").
 *
 * "No Documents yet." stays a text node of its own: it is the line the page
 * specs wait on for an empty Notebook to have loaded.
 */
@Component({
  selector: 'app-documents-empty-state',
  imports: [CopycatMark],
  template: `
    <app-copycat-mark />
    <p class="documents-empty-state__text">
      <span>No Documents yet.</span> Add Documents to start asking questions.
    </p>
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
export class DocumentsEmptyState {}
