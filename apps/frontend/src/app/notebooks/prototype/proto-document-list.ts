import { Component, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  ConflictChoice,
  Document,
  DocumentsStore,
  UploadItemStatus,
} from '../../documents/documents.store';
import { ProtoIcon } from './proto-icon';

const STAGE_LABEL: Record<string, string> = {
  queued: 'Queued',
  converting: 'Converting',
  converted: 'Converted',
  summarizing: 'Summarizing',
  summarized: 'Summarized',
  indexing: 'Indexing',
};

/**
 * PROTOTYPE — throwaway. The Documents list as spec 03 draws it: one 40 px
 * row per Document (type icon, filename, quiet secondary line, "…" menu),
 * the upload batch and the conflict question in a compact panel at the top,
 * "deleted — Undo" as a snack bar. Shared by the variants because each of
 * them has to show the same list at the same density for the frame to be
 * judged fairly.
 */
@Component({
  selector: 'proto-document-list',
  standalone: true,
  imports: [
    RouterLink,
    MatCheckboxModule,
    MatMenuModule,
    MatProgressBarModule,
    MatSnackBarModule,
    MatTooltipModule,
    ProtoIcon,
  ],
  template: `
    @if (store.uploadRefused(); as refused) {
      <p class="pdl__error">{{ refused }}</p>
    }

    @if (batch(); as batch) {
      <section class="pdl__batch" aria-label="Upload batch">
        <div class="pdl__batch-head">
          <span>{{ store.batchRunning() ? 'Uploading…' : 'Upload finished' }}</span>
          <span class="pdl__batch-actions">
            @if (store.batchRunning()) {
              <button type="button" class="pdl__link" (click)="store.cancelBatch()">Cancel</button>
            } @else {
              @if ((store.batchSummary()?.failed ?? 0) > 0) {
                <button type="button" class="pdl__link" (click)="store.retryFailed()">
                  Retry failed
                </button>
              }
              <button type="button" class="pdl__link" (click)="store.dismissBatch()">
                Dismiss
              </button>
            }
          </span>
        </div>
        @if (store.batchRunning()) {
          <mat-progress-bar mode="indeterminate" class="pdl__bar" />
        }
        <ul class="pdl__batch-items" aria-label="Upload progress">
          @for (item of batch.items; track item.id) {
            <li class="pdl__batch-item">
              <span class="pdl__batch-name">{{ item.file.name }}</span>
              <span class="pdl__badge" [class]="'pdl__badge pdl__badge--' + item.status">{{
                label(item.status)
              }}</span>
              @if (item.reason) {
                <span class="pdl__batch-reason">{{ item.reason }}</span>
              }
            </li>
          }
        </ul>
        @if (store.conflict(); as conflict) {
          <div class="pdl__conflict" role="dialog" aria-labelledby="proto-conflict-title">
            <p id="proto-conflict-title" class="pdl__conflict-title">Document already exists</p>
            <p class="pdl__conflict-text">
              "{{ conflict.filename }}" is already in this Notebook. Upload it as a new Version, or
              skip it?
            </p>
            <mat-checkbox [checked]="applyToAll" (change)="applyToAll = $event.checked"
              >Apply to all remaining conflicts</mat-checkbox
            >
            <div class="pdl__conflict-actions">
              <button type="button" class="pdl__btn" (click)="answer('skip')">Skip</button>
              <button
                type="button"
                class="pdl__btn pdl__btn--primary"
                (click)="answer('new-version')"
              >
                New Version
              </button>
            </div>
          </div>
        }
      </section>
    }

    @if (store.loading()) {
      <mat-progress-bar mode="indeterminate" class="pdl__bar" />
    } @else if (store.error(); as error) {
      <p class="pdl__error">{{ error }}</p>
    } @else if (filtered().length === 0) {
      <div class="pdl__empty">
        <proto-icon name="document" [size]="28" />
        <p>
          {{
            store.documents().length === 0
              ? 'No Documents yet. Add Documents to start asking questions.'
              : 'No Document matches the filter.'
          }}
        </p>
      </div>
    } @else {
      <ul class="pdl" aria-label="Documents">
        @for (d of filtered(); track d.id) {
          <li class="pdl__row" [class.pdl__row--failed]="d.status === 'failed'">
            <a
              class="pdl__open"
              [routerLink]="['/notebooks', notebookId(), 'documents', d.id]"
              [attr.aria-label]="'Open ' + d.filename"
              [matTooltip]="d.abstract ?? 'Abstract not generated yet.'"
              matTooltipPosition="right"
              matTooltipShowDelay="500"
            >
              <span class="pdl__type" [class]="'pdl__type pdl__type--' + kind(d)">{{
                kindLabel(d)
              }}</span>
              <span class="pdl__text">
                <span class="pdl__name">{{ d.filename }}</span>
                @if (d.status !== 'ready' && d.status !== 'failed') {
                  <span class="pdl__sub pdl__sub--busy">{{ stage(d) }}…</span>
                } @else if (d.status === 'failed') {
                  <span class="pdl__sub pdl__sub--failed">Ingestion failed</span>
                } @else if (d.latestVersion.versionNumber > 1) {
                  <span class="pdl__sub">v{{ d.latestVersion.versionNumber }}</span>
                }
              </span>
            </a>
            @if (d.status === 'failed') {
              <span class="pdl__warn" matTooltip="Ingestion failed for the latest Version"
                ><proto-icon name="warning" [size]="16"
              /></span>
            }
            <button
              type="button"
              class="pdl__more"
              [matMenuTriggerFor]="menu"
              [attr.aria-label]="'Actions for ' + d.filename"
            >
              <proto-icon name="more-horizontal" [size]="16" />
            </button>
            <mat-menu #menu="matMenu">
              <a mat-menu-item [routerLink]="['/notebooks', notebookId(), 'documents', d.id]"
                >Open</a
              >
              <button mat-menu-item (click)="store.downloadDocumentVersion(notebookId(), d)">
                Download
              </button>
              <button mat-menu-item (click)="store.deleteDocument(notebookId(), d.id)">
                Delete
              </button>
            </mat-menu>
            @if (d.status !== 'ready' && d.status !== 'failed') {
              <mat-progress-bar mode="indeterminate" class="pdl__row-bar" />
            }
          </li>
        }
      </ul>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .pdl {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .pdl__row {
      position: relative;
      display: flex;
      align-items: center;
      min-height: 40px;
      border-radius: 4px;
      padding-right: 4px;
    }
    .pdl__row:hover,
    .pdl__row:focus-within {
      background: #f5f5f5;
    }
    .pdl__open {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      color: inherit;
      text-decoration: none;
    }
    .pdl__type {
      width: 20px;
      height: 24px;
      border-radius: 3px;
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.02em;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      background: #8a8a8a;
      flex: none;
    }
    .pdl__type--pdf {
      background: #d13438;
    }
    .pdl__type--docx {
      background: #2b579a;
    }
    .pdl__type--xlsx {
      background: #217346;
    }
    .pdl__type--csv {
      background: #217346;
    }
    .pdl__type--md {
      background: #5c2d91;
    }
    .pdl__text {
      display: flex;
      flex-direction: column;
      min-width: 0;
      line-height: 1.25;
    }
    .pdl__name {
      font-size: 14px;
      color: #242424;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pdl__sub {
      font-size: 12px;
      color: #616161;
    }
    .pdl__sub--busy {
      color: #0f6cbd;
    }
    .pdl__sub--failed {
      color: #c50f1f;
    }
    .pdl__warn {
      color: #c50f1f;
      display: inline-flex;
      margin-right: 4px;
    }
    .pdl__more {
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: #616161;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      opacity: 0;
    }
    .pdl__row:hover .pdl__more,
    .pdl__row:focus-within .pdl__more,
    .pdl__more:focus-visible {
      opacity: 1;
    }
    .pdl__more:hover {
      background: #e0e0e0;
      color: #242424;
    }
    .pdl__row-bar {
      position: absolute;
      left: 8px;
      right: 8px;
      bottom: 0;
      height: 2px;
    }
    .pdl__bar {
      height: 2px;
      margin: 4px 0;
    }
    .pdl__empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 32px 16px;
      color: #616161;
      text-align: center;
      font-size: 13px;
    }
    .pdl__empty p {
      margin: 0;
      max-width: 240px;
    }
    .pdl__error {
      color: #c50f1f;
      background: #fde7e9;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 13px;
      margin: 0 0 8px;
    }
    .pdl__batch {
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      padding: 8px 10px;
      margin-bottom: 8px;
      background: #fafafa;
      font-size: 13px;
    }
    .pdl__batch-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
    }
    .pdl__batch-actions {
      display: flex;
      gap: 8px;
    }
    .pdl__link {
      border: 0;
      background: none;
      color: #0f6cbd;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      padding: 0;
    }
    .pdl__link:hover {
      text-decoration: underline;
    }
    .pdl__batch-items {
      list-style: none;
      margin: 6px 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .pdl__batch-item {
      display: flex;
      align-items: baseline;
      gap: 6px;
      flex-wrap: wrap;
    }
    .pdl__batch-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pdl__batch-reason {
      flex-basis: 100%;
      font-size: 12px;
      color: #616161;
    }
    .pdl__badge {
      font-size: 12px;
      padding: 1px 8px;
      border-radius: 4px;
      background: #f0f0f0;
      color: #424242;
    }
    .pdl__badge--uploaded,
    .pdl__badge--new-version {
      background: #e7f5e7;
      color: #0e700e;
    }
    .pdl__badge--failed {
      background: #fde7e9;
      color: #c50f1f;
    }
    .pdl__conflict {
      margin-top: 8px;
      padding: 8px 10px;
      border: 1px solid #d1d1d1;
      border-radius: 8px;
      background: #fff;
    }
    .pdl__conflict-title {
      margin: 0 0 4px;
      font-weight: 600;
    }
    .pdl__conflict-text {
      margin: 0 0 6px;
      color: #424242;
    }
    .pdl__conflict-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 6px;
    }
    .pdl__btn {
      height: 32px;
      padding: 0 12px;
      border: 1px solid #d1d1d1;
      border-radius: 4px;
      background: #fff;
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .pdl__btn--primary {
      background: #0f6cbd;
      border-color: #0f6cbd;
      color: #fff;
    }
  `,
})
export class ProtoDocumentList {
  readonly notebookId = input.required<string>();
  /** Filename filter (spec 03 story 13); the variants' header boxes feed it. */
  readonly filter = input('');

  protected readonly store = inject(DocumentsStore);
  private readonly snackBar = inject(MatSnackBar);
  protected applyToAll = false;

  constructor() {
    // Spec 01's undo snack bar: the store state is unchanged, only the
    // "deleted — Undo" presentation moves off the page.
    effect(() => {
      const deleted = this.store.lastDeleted();
      if (!deleted) return;
      const ref = this.snackBar.open(`"${deleted.filename}" deleted`, 'Undo', { duration: 8000 });
      ref
        .onAction()
        .subscribe(() => void this.store.restoreDocument(this.notebookId(), deleted.id));
    });
  }

  protected batch() {
    const b = this.store.batch();
    return b?.notebookId === this.notebookId() ? b : null;
  }

  protected filtered(): Document[] {
    const q = this.filter().trim().toLowerCase();
    const docs = this.store.documents();
    return q ? docs.filter((d) => d.filename.toLowerCase().includes(q)) : docs;
  }

  protected kind(d: Document): string {
    const ext = d.filename.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'pdf') return 'pdf';
    if (ext === 'docx') return 'docx';
    if (ext === 'xlsx') return 'xlsx';
    if (ext === 'csv') return 'csv';
    if (ext === 'md' || ext === 'markdown') return 'md';
    return 'txt';
  }
  protected kindLabel(d: Document): string {
    const k = this.kind(d);
    return k === 'docx' ? 'W' : k === 'xlsx' ? 'X' : k.toUpperCase();
  }
  protected stage(d: Document): string {
    return STAGE_LABEL[d.status] ?? d.status;
  }
  protected label(s: UploadItemStatus): string {
    return s === 'new-version' ? 'new version' : s;
  }
  protected answer(choice: ConflictChoice): void {
    this.store.answerConflict(choice, this.applyToAll);
    this.applyToAll = false;
  }
}
