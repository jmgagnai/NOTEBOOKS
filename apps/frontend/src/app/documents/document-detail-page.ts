import {
  Component,
  computed,
  effect,
  inject,
  OnDestroy,
  OnInit,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { Location } from '@angular/common';
import { ActivatedRoute, NavigationSkipped, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DocumentsStore } from './documents.store';
import { injectLeaveChat } from '../chat/leave-chat';
import { StatusBadge } from '../shared/status-badge';
import { MarkdownView } from './markdown-view';
import { showPageTitle } from '../shared/page-title';
import { failureSentence } from './failure-reason';
import { withoutExecutiveSummaryTitle } from './executive-summary-title';

/**
 * One Document, opened (NBK-7).
 *
 * The order of what it shows is the point, and it comes straight from
 * GLOSSARY.md: the Executive Summary is "shown first when a user opens a
 * document, before they choose to view the full converted content (which may
 * run past 200 pages)". So this page leads with the Executive Summary and the
 * extracted metadata, and the full Converted Markdown is behind an explicit
 * action — which is also what keeps a 200-page payload from being downloaded
 * by anyone who merely clicked into a Document.
 *
 * Both the Executive Summary and the full content are rendered as real
 * Markdown (see `MarkdownView`), so headings and tables survive: NBK-1's
 * story 23 is specifically that long documents must not appear as a wall of
 * text.
 *
 * It is also where a Citation lands (NBK-12). Following one arrives with
 * `?version=&chunk=&from=&to=` — the Document Version the answer was grounded
 * in, the Chunk it cited, and that Chunk's character range in the Version's
 * Converted Markdown. The page then opens *that* Version rather than the
 * latest, expanded straight to the content and marked at the cited Chunk,
 * because GLOSSARY.md requires that following a Citation open "that exact
 * Version at that location, even after newer Versions exist". The Version id
 * is read off the link rather than resolved here precisely so a newer upload
 * cannot move it.
 *
 * And "that exact Version" means the whole page, not only the Markdown. A
 * Version-scoped read (`loadDocumentVersion`) supplies the pinned Version's
 * own Executive Summary, extracted metadata and version number, so everything
 * a reader sees describes the same Version. Loading the latest Version's
 * detail and swapping in the pinned Version's content — which is what this
 * page used to do — presents two Versions as one document: the summary says
 * one thing, the text says another, and the badge sides with the wrong one.
 * No notice can repair that, because the reader still cannot tell which half
 * belongs to the answer they followed.
 */
@Component({
  selector: 'app-document-detail-page',
  standalone: true,
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MarkdownView,
    RouterLink,
    StatusBadge,
  ],
  templateUrl: './document-detail-page.html',
  styleUrl: './document-detail-page.scss',
})
export class DocumentDetailPage implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);

  protected readonly store = inject(DocumentsStore);

  private readonly location = inject(Location);

  protected readonly notebookId = this.route.snapshot.paramMap.get('notebookId')!;

  /**
   * The page shows no Chat Thread (NBK-103), but the open one is still the
   * Notebook's: kept for the way back to the Notebook page, dropped on
   * leaving the Notebook. See `injectLeaveChat`.
   */
  private readonly leaveChat = injectLeaveChat(this.notebookId);

  /**
   * Whether a search result opened this page (NBK-103), read while the
   * router is still activating it — the only moment the navigation's state
   * is at hand. Its back arrow then returns to those results; any other
   * arrival, a pasted link included, goes back to the Notebook.
   */
  protected readonly openedFromSearch =
    inject(Router).currentNavigation()?.extras.state?.['openedFromSearch'] === true;

  /**
   * The route as signals, not a snapshot: a link to this same route — a
   * Citation's, or one browser history returns to — is answered by the
   * router reusing this page rather than creating another, so the Document,
   * the pinned Version and the cited range can all change under it. The
   * Notebook cannot: the page's links never leave it.
   */
  private readonly params = toSignal(this.route.paramMap, {
    initialValue: this.route.snapshot.paramMap,
  });
  private readonly query = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  protected readonly documentId = computed(() => this.params().get('documentId')!);

  // NBK-61: the tab names the open Document, so several are distinguishable.
  private readonly tabTitle = showPageTitle(() => this.store.openDocument()?.filename);

  /**
   * The Document Version a Citation pinned, or null when the page was opened
   * normally. Taken from the link and never resolved here: it is the whole
   * reason an old answer stays checkable.
   */
  protected readonly citedVersionId = computed(() => this.query().get('version'));

  /** The cited chunk's character range in that Version's Converted Markdown. */
  protected readonly citedFrom = computed(() => numberParam(this.query().get('from')));
  protected readonly citedTo = computed(() => numberParam(this.query().get('to')));

  /**
   * Whether the reader has expanded past the Executive Summary. Component
   * state rather than store state: it is this view's disclosure, and the
   * fetched content itself (which is what's worth keeping) lives in the
   * store.
   *
   * Opened whenever a Citation is followed: that reader asked for a
   * specific Chunk, and making them click "Read the full Document" to reach
   * it would be asking them to find it themselves.
   */
  protected readonly expanded = signal(false);

  /**
   * Follows the route: on arrival, and on every link to it after that. Keyed on the Document and the whole query — Version,
   * Chunk, range — so any other Citation is followed even when it shares the
   * Version or the start of its range.
   */
  private readonly followRoute = effect(() => {
    const documentId = this.documentId();
    this.query();
    const versionId = this.citedVersionId();
    untracked(() => void this.show(documentId, versionId));
  });

  /**
   * A Citation followed again to the URL already on screen is a navigation
   * the router skips, so the route never changes; the reader still asked to
   * see the cited Chunk, which they may have hidden since.
   */
  private readonly followAgain = inject(Router)
    .events.pipe(
      filter((event) => event instanceof NavigationSkipped),
      takeUntilDestroyed(),
    )
    .subscribe(() => {
      if (this.citedVersionId() !== null) this.expanded.set(true);
    });

  /**
   * True when this page is showing a Version the Document has since moved
   * past.
   *
   * Read off the Version-scoped payload rather than compared here, because
   * only the server knows which Version is currently latest. Worth saying out
   * loud even now that every field on the page agrees with every other: a
   * reader who followed an old answer needs to know they are reading history,
   * and how far back — which is why the notice names both version numbers.
   */
  protected readonly viewingSupersededVersion = computed(
    () => this.store.openDocument()?.isLatestVersion === false,
  );

  /**
   * The sentence saying why this Version failed Ingestion, or null when it
   * has not failed (NBK-68). Keyed on the status, not on `failure`, so a
   * failed Version without a reason still says something — the same
   * fallback the Documents panel's warning uses.
   */
  protected readonly failureSentence = computed(() =>
    this.versionFailed() ? failureSentence(this.store.openDocument()!.failure) : null,
  );

  /**
   * Whether the Version on screen failed Ingestion: what it lacks then will
   * never come, so the page says so rather than that it is on its way
   * (NBK-90).
   */
  protected readonly versionFailed = computed(() => this.store.openDocument()?.status === 'failed');

  /** Which Version's Converted Markdown this page shows. */
  private targetVersionId(): string | null {
    return this.citedVersionId() ?? this.store.openDocument()?.version.id ?? null;
  }

  /**
   * The Executive Summary as the page shows it, under its own heading:
   * without the title the model may have given it (NBK-89).
   */
  protected readonly executiveSummary = computed(() => {
    const summary = this.store.openDocument()?.executiveSummary;
    return summary ? withoutExecutiveSummaryTitle(summary) : null;
  });

  // The metadata keys read below (`title`, `authors`, `publishedOn`,
  // `documentType`, `language`, `subject`, `keywords`) mirror
  // `documentMetadataSchema` in apps/backend/src/ingestion/generated-artifacts.ts,
  // their source of truth: the generated client types metadata as an open
  // record, so a renamed key there would silently blank it here.

  /**
   * The title extracted at Ingestion (NBK-7), or null when the Document did
   * not state one or is not summarised yet. Spec 08: it is the page's
   * headline when present, since a filename makes a poor one; the filename
   * then follows as a small line so the reader can still tell which upload
   * this is.
   */
  protected readonly extractedTitle = computed(() => {
    const title = this.store.openDocument()?.metadata?.['title'];
    return typeof title === 'string' && title.trim() !== '' ? title : null;
  });

  /**
   * The byline under the headline (spec 08): authors, publication date,
   * document type and the Version on screen, joined like an article's — in
   * place of the labelled metadata grid this page used to show. Anything the
   * Document does not state is left out rather than shown blank: per NBK-7
   * the extractor says null for it, and "— · — · v1" tells a reader nothing.
   */
  protected readonly byline = computed(() => {
    const document = this.store.openDocument();
    if (!document) return '';
    const metadata = document.metadata ?? {};
    return [
      text(metadata['authors']),
      text(metadata['publishedOn']),
      text(metadata['documentType']),
      `v${document.version.versionNumber}`,
    ]
      .filter((part) => part !== null)
      .join(' · ');
  });

  /**
   * What the byline leaves out, behind a closed "Details": still there for
   * the reader who wants it, without making the top of the page a form.
   * Empty when the Document states none of it, which hides "Details".
   */
  protected readonly details = computed(() => {
    const metadata = this.store.openDocument()?.metadata ?? {};
    return [
      { label: 'Language', value: text(metadata['language']) },
      { label: 'Subject', value: text(metadata['subject']) },
      { label: 'Keywords', value: text(metadata['keywords']) },
    ].filter((entry): entry is { label: string; value: string } => entry.value !== null);
  });

  ngOnInit(): void {
    // The Version on screen follows Ingestion while the page is open
    // (NBK-93), from the same Notebook stream the Notebook page follows;
    // the router has destroyed that page, and closed its watch, by now.
    this.store.watchNotebook(this.notebookId);
  }

  /**
   * Shows `documentId`, at the pinned Version when a Citation named one.
   *
   * The Version already on screen is not read again: a Citation to the
   * Version the reader is looking at only has to open its full Converted
   * Markdown and move the mark, which is what makes checking an answer
   * instant. Anything else — another Document, another Version of this
   * one — is a fresh read, as on arrival. A link naming no Version means
   * the latest, so a superseded Version on screen is read again for it
   * (back from a Citation to an old Version, say).
   */
  private async show(documentId: string, versionId: string | null): Promise<void> {
    const open = this.store.openDocument();
    const onScreen =
      open !== null &&
      open.id === documentId &&
      (versionId === null ? open.isLatestVersion : open.version.id === versionId);
    if (versionId !== null) this.expanded.set(true);
    if (onScreen) {
      if (versionId !== null) {
        await this.store.loadDocumentContent(this.notebookId, documentId, versionId);
      }
      return;
    }
    if (versionId === null) {
      this.expanded.set(false);
      await this.store.loadDocument(this.notebookId, documentId);
      return;
    }

    // A followed Citation names its Version, so the whole page is read for
    // that Version — not the Document's current one with the old content
    // slotted in. The latest-Version detail is not fetched at all: there is
    // nothing on this page it could correctly fill in.
    await this.store.loadDocumentVersion(this.notebookId, documentId, versionId);
    // And the content follows without waiting for the reader to ask, since
    // they already asked by clicking a Citation.
    if (this.store.openDocument()) {
      await this.store.loadDocumentContent(this.notebookId, documentId, versionId);
    }
  }

  ngOnDestroy(): void {
    // The store is root-provided and outlives this page, so an opened
    // Document — and especially its up-to-200-page content — has to be
    // dropped explicitly rather than held until the next one replaces it.
    this.store.stopWatching();
    this.store.clearOpenDocument();
    this.leaveChat();
  }

  /** Back to the search results, through history, so they are shown as they were left. */
  protected backToSearch(): void {
    this.location.back();
  }

  protected toggleFullContent(): void {
    if (this.expanded()) {
      this.expanded.set(false);
      return;
    }
    const versionId = this.targetVersionId();
    if (!versionId) return;
    this.expanded.set(true);
    // A no-op if this Version's content is already loaded, so collapsing and
    // re-expanding doesn't re-download it.
    void this.store.loadDocumentContent(this.notebookId, this.documentId(), versionId);
  }
}

/**
 * An extracted metadata value as display text, or null when it is absent or
 * empty — lists comma-joined, so authors and keywords read as a phrase.
 */
function text(value: unknown): string | null {
  const joined = Array.isArray(value) ? value.join(', ') : value;
  if (joined === null || joined === undefined) return null;
  const trimmed = String(joined).trim();
  return trimmed === '' ? null : trimmed;
}

/** A query parameter as a number, or null when absent or not a number. */
function numberParam(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
