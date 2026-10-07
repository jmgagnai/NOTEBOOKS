import { Component, inject, input } from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DocumentsStore } from '../../documents/documents.store';
import { UPLOAD_ACCEPT } from '../../documents/upload-rules';
import { ProtoIcon } from './proto-icon';

/**
 * PROTOTYPE — throwaway. The single "Add Documents" control (spec 03 story
 * 11) wrapping a hidden multi-select file input. `kind` picks the Fluent
 * button variant the host pane wants: primary, secondary, or icon-only.
 */
@Component({
  selector: 'proto-add-documents-button',
  standalone: true,
  imports: [MatTooltipModule, ProtoIcon],
  template: `
    <button
      type="button"
      class="pab"
      [class.pab--primary]="kind() === 'primary'"
      [class.pab--icon]="kind() === 'icon'"
      aria-label="Add Documents"
      [matTooltip]="kind() === 'icon' ? 'Add Documents' : ''"
      [disabled]="store.batchRunning()"
      (click)="input.click()"
    >
      <proto-icon name="add" [size]="16" />
      @if (kind() !== 'icon') {
        <span>Add Documents</span>
      }
    </button>
    <input #input type="file" multiple hidden [accept]="accept" (change)="onPicked($event)" />
  `,
  styles: `
    :host {
      display: inline-flex;
    }
    .pab {
      height: 32px;
      padding: 0 12px 0 8px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid #d1d1d1;
      border-radius: 4px;
      background: #fff;
      color: #242424;
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .pab:hover:not(:disabled) {
      background: #f5f5f5;
    }
    .pab:disabled {
      color: #bdbdbd;
      border-color: #e0e0e0;
      cursor: default;
    }
    .pab--primary {
      background: #0f6cbd;
      border-color: #0f6cbd;
      color: #fff;
    }
    .pab--primary:hover:not(:disabled) {
      background: #115ea3;
    }
    .pab--primary:disabled {
      background: #e0e0e0;
      border-color: #e0e0e0;
    }
    .pab--icon {
      width: 32px;
      padding: 0;
      justify-content: center;
      border-color: transparent;
    }
  `,
})
export class ProtoAddDocumentsButton {
  readonly notebookId = input.required<string>();
  readonly kind = input<'primary' | 'secondary' | 'icon'>('secondary');
  protected readonly store = inject(DocumentsStore);
  protected readonly accept = UPLOAD_ACCEPT;

  protected onPicked(event: Event): void {
    const el = event.target as HTMLInputElement;
    const files = Array.from(el.files ?? []);
    if (files.length > 0) void this.store.uploadDocuments(this.notebookId(), files);
    el.value = '';
  }
}
