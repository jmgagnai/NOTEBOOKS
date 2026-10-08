import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  output,
  signal,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { FluentIconName } from '../shared/fluent-icons';
import { statusLabel } from '../shared/status-badge';
import type { Document, DocumentStatus } from './documents.store';

/** What the type icon at the start of a row says: which icon, and its accessible name. */
export interface DocumentKind {
  icon: FluentIconName;
  label: string;
}

/**
 * The type icon per MIME type (NBK-42, spec 03 "Row anatomy"). Keyed by the
 * latest Version's MIME type because that is the canonical type the backend
 * recorded, not whatever the browser guessed on upload. The keys mirror the
 * values of `ACCEPTED_EXTENSIONS` in apps/backend/src/documents/file-types.ts,
 * the source of truth for what a Version can be; a type not listed there
 * (none today) falls back to the plain Document icon.
 */
const DOCUMENT_KINDS: Record<string, DocumentKind> = {
  'application/pdf': { icon: 'document-pdf', label: 'PDF' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    icon: 'document-text',
    label: 'Word',
  },
  'text/plain': { icon: 'document-one-page', label: 'Text' },
  'text/markdown': { icon: 'document-one-page', label: 'Text' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    icon: 'document-table',
    label: 'Spreadsheet',
  },
  'text/csv': { icon: 'document-table', label: 'Spreadsheet' },
};

const OTHER_KIND: DocumentKind = { icon: 'document', label: 'Document' };

/** The type icon for a Document, from its latest Version's MIME type. */
export function documentKind(document: Document): DocumentKind {
  return DOCUMENT_KINDS[document.latestVersion.mimeType] ?? OTHER_KIND;
}

/**
 * Whether a status is still on its way to `ready` (spec 03 "Status
 * mapping"): the six pipeline stages collapse into one "in progress" look,
 * `ready` shows nothing and `failed` shows the warning.
 */
export function isInProgress(status: DocumentStatus): boolean {
  return status !== 'ready' && status !== 'failed';
}

/**
 * What the warning on a `failed` row says. Generic on purpose: the list
 * payload carries no reason (the backend keeps `ingestion_error` on the
 * Version and does not expose it), so this names what failed and where to
 * look rather than inventing a cause.
 */
export const FAILURE_REASON = 'Ingestion failed for the latest Version of this Document.';

/**
 * The Documents panel's list (NBK-42, spec 03): one 40 px row per Document
 * — type icon, filename on one line, a quiet secondary line (the ingestion
 * stage while it runs, the version once there is more than one), a warning
 * when ingestion failed, and a "…" menu with Open, Download and Delete — in
 * place of the cards that gave each Document a paragraph.
 *
 * Presentational: it is handed the Documents to show, so the page can narrow
 * them (the filter box of spec 03) without the list knowing about the store,
 * and it hands Download and Delete back up, so the page keeps the delete
 * that offers the undo snack bar (NBK-33).
 */
@Component({
  selector: 'app-document-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatProgressBarModule,
    MatTooltipModule,
    RouterLink,
  ],
  templateUrl: './document-list.html',
  styleUrl: './document-list.scss',
})
export class DocumentList {
  readonly notebookId = input.required<string>();
  readonly documents = input.required<readonly Document[]>();

  readonly download = output<Document>();
  readonly delete = output<Document>();

  protected readonly kind = documentKind;
  protected readonly inProgress = isInProgress;
  protected readonly stage = statusLabel;
  protected readonly failureReason = FAILURE_REASON;

  /** The row holding the list's one Tab stop: the last one focused, else the first. */
  protected readonly activeIndex = signal(0);
  // Clamped, so deleting the last row never leaves the list without a Tab stop.
  protected readonly tabStop = computed(() =>
    Math.min(this.activeIndex(), this.documents().length - 1),
  );
  private readonly rowLinks = viewChildren<ElementRef<HTMLElement>>('rowLink');

  /**
   * Up/Down/Home/End between the rows' links. Only when a row link has the
   * focus, so the arrow keys inside an open menu or on the "…" button keep
   * their own meaning.
   */
  protected onKeydown(event: KeyboardEvent): void {
    const links = this.rowLinks().map((ref) => ref.nativeElement);
    const current = links.indexOf(event.target as HTMLElement);
    if (current === -1) return;
    const last = links.length - 1;
    const next =
      event.key === 'ArrowDown'
        ? Math.min(current + 1, last)
        : event.key === 'ArrowUp'
          ? Math.max(current - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    // Arrows would otherwise also scroll the panel under the focus.
    event.preventDefault();
    this.activeIndex.set(next);
    links[next].focus();
  }
}
