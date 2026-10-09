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
import { canRetry, failureSentence } from './failure-reason';

/** What the type icon at the start of a row says: which icon, and its accessible name. */
export interface DocumentKind {
  icon: FluentIconName;
  label: string;
}

/**
 * The type icon per MIME type (NBK-42, spec 03 "Row anatomy"). Purely a
 * presentation map, not a mirrored backend constant: it decides nothing
 * about what may be uploaded (that mirror is `ACCEPTED_UPLOAD_EXTENSIONS` in
 * ./upload-rules.ts), and a MIME type missing from it only falls back to the
 * plain Document icon. Keyed by the latest Version's MIME type because that
 * is the canonical type the backend recorded, not whatever the browser
 * guessed on upload; the keys are the MIME values of `ACCEPTED_EXTENSIONS` in
 * apps/backend/src/documents/file-types.ts, so a type added there wants a row
 * here, or it shows the plain icon.
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

/** What the Abstract popover says until stage 2 has written the Abstract (spec 03). */
export const NO_ABSTRACT = 'Abstract not generated yet.';

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
  /** A failed Document's Retry (NBK-110), offered only when it could help. */
  readonly retry = output<Document>();

  protected readonly kind = documentKind;
  protected readonly inProgress = isInProgress;
  protected readonly stage = statusLabel;
  protected readonly failureSentence = failureSentence;
  protected readonly canRetry = canRetry;

  /** The Abstract popover's text: the full filename, then the Abstract. */
  protected popover(document: Document): string {
    return `${document.filename}\n${document.abstract ?? NO_ABSTRACT}`;
  }

  /** The row holding the list's one Tab stop: the last one focused, else the first. */
  protected readonly activeIndex = signal(0);
  // Clamped, so deleting the last row never leaves the list without a Tab stop.
  protected readonly tabStop = computed(() =>
    Math.min(this.activeIndex(), this.documents().length - 1),
  );
  private readonly rowLinks = viewChildren<ElementRef<HTMLElement>>('rowLink');
  private readonly rowMores = viewChildren('rowMore', { read: ElementRef<HTMLElement> });

  /**
   * Up/Down/Home/End between the rows' links, and Right/Left between a
   * row's link and its "…" button, which has no Tab stop of its own. Only
   * from those two, so the arrow keys inside an open menu keep their own
   * meaning.
   */
  protected onKeydown(event: KeyboardEvent): void {
    const links = this.rowLinks().map((ref) => ref.nativeElement);
    const mores = this.rowMores().map((ref) => ref.nativeElement as HTMLElement);
    const target = event.target as HTMLElement;
    const onMore = mores.indexOf(target);
    if (onMore !== -1 && event.key === 'ArrowLeft') {
      event.preventDefault();
      links[onMore].focus();
      return;
    }
    const current = links.indexOf(target);
    if (current === -1) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      mores[current].focus();
      return;
    }
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
