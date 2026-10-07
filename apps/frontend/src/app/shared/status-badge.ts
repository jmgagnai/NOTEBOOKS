import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { DocumentStatus, UploadItemStatus } from '../documents/documents.store';

/** Every status the badge knows how to read: a Version's ingestion status or an upload step. */
export type BadgeStatus = DocumentStatus | UploadItemStatus;

/**
 * What a status means, which is what the badge colours. The status *word*
 * is informative; the tone answers the glance: done, broken, or still going.
 */
export type BadgeTone = 'neutral' | 'success' | 'error' | 'progress';

/**
 * The one status badge (NBK-32, spec 01 "Status badge"): the Documents list,
 * the upload progress panel and the Document page all render a status
 * through it, so the two per-page copies of the badge style are gone and a
 * status reads the same wherever it appears.
 *
 * The host element is the badge. Keeping the markup to one element means a
 * `findByText` on the label lands on the element that carries the tone
 * class, the way the existing badge tests already query it.
 */
@Component({
  selector: 'app-status-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `{{ label() }}`,
  host: {
    class: 'app-badge',
    '[class.app-badge--success]': 'tone() === "success"',
    '[class.app-badge--error]': 'tone() === "error"',
    '[class.app-badge--progress]': 'tone() === "progress"',
  },
  styles: `
    :host {
      display: inline-block;
      padding: 2px 8px;
      border-radius: var(--mat-sys-corner-extra-small);
      font: var(--mat-sys-label-medium);
      white-space: nowrap;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    :host(.app-badge--success) {
      background: var(--mat-sys-tertiary-container);
      color: var(--mat-sys-on-tertiary-container);
    }

    :host(.app-badge--error) {
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }

    :host(.app-badge--progress) {
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }
  `,
})
export class StatusBadge {
  readonly status = input.required<BadgeStatus>();

  protected readonly label = computed(() => statusLabel(this.status()));
  protected readonly tone = computed(() => statusTone(this.status()));
}

/** The status in sentence case: "Ready", "Converting", "New version". */
export function statusLabel(status: BadgeStatus): string {
  const words = status.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Only `ready` is success for a Document: `converted` and `summarized` are
 * stage boundaries, not the end of ingestion, and the earlier badge's
 * finished-a-step green on them made a half-ingested Document look done. For
 * an upload step the landed outcomes (`uploaded`, or `new-version` per
 * GLOSSARY.md's "creates a new Version of that Document") are the success;
 * `waiting`, `uploading` and `skipped` stay neutral because the panel's
 * spinner already says the batch is moving.
 */
export function statusTone(status: BadgeStatus): BadgeTone {
  switch (status) {
    case 'ready':
    case 'uploaded':
    case 'new-version':
      return 'success';
    case 'failed':
      return 'error';
    case 'queued':
    case 'converting':
    case 'converted':
    case 'summarizing':
    case 'summarized':
    case 'indexing':
      return 'progress';
    case 'waiting':
    case 'uploading':
    case 'skipped':
      return 'neutral';
  }
}
