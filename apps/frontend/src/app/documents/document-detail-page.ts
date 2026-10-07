import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { DocumentsStore } from './documents.store';
import { StatusBadge } from '../shared/status-badge';
import { MarkdownView } from './markdown-view';

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
    MatCardModule,
    MatProgressSpinnerModule,
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

  protected readonly notebookId = this.route.snapshot.paramMap.get('notebookId')!;
  protected readonly documentId = this.route.snapshot.paramMap.get('documentId')!;

  private readonly query = this.route.snapshot.queryParamMap;

  /**
   * The Document Version a Citation pinned, or null when the page was opened
   * normally. Read once from the link: it is the whole reason an old answer
   * stays checkable, so nothing recomputes it.
   */
  protected readonly citedVersionId = this.query?.get('version') ?? null;

  /** The cited chunk's character range in that Version's Converted Markdown. */
  protected readonly citedFrom = numberParam(this.query?.get('from'));
  protected readonly citedTo = numberParam(this.query?.get('to'));

  /**
   * Whether the reader has expanded past the Executive Summary. Component
   * state rather than store state: it is this view's disclosure, and the
   * fetched content itself (which is what's worth keeping) lives in the
   * store.
   *
   * Starts expanded when a Citation was followed: that reader asked for a
   * specific Chunk, and making them click "Show full content" to reach it
   * would be asking them to find it themselves.
   */
  protected readonly expanded = signal(this.citedVersionId !== null);

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

  /** Which Version's Converted Markdown this page shows. */
  private targetVersionId(): string | null {
    return this.citedVersionId ?? this.store.openDocument()?.version.id ?? null;
  }

  protected readonly metadataEntries = computed(() => {
    const metadata = this.store.openDocument()?.metadata;
    if (!metadata) return [];
    // Empty values are dropped rather than rendered as blanks: per NBK-7 the
    // extractor says null for anything the document doesn't state, and a row
    // reading "Authors: —" tells a reader nothing.
    return Object.entries(metadata)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .filter(([, value]) => !(Array.isArray(value) && value.length === 0))
      .map(([key, value]) => ({
        label: key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()),
        value: Array.isArray(value) ? value.join(', ') : String(value),
      }));
  });

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    if (this.citedVersionId === null) {
      await this.store.loadDocument(this.notebookId, this.documentId);
      return;
    }

    // A followed Citation names its Version, so the whole page is read for
    // that Version — not the Document's current one with the old content
    // slotted in. The latest-Version detail is not fetched at all: there is
    // nothing on this page it could correctly fill in.
    await this.store.loadDocumentVersion(this.notebookId, this.documentId, this.citedVersionId);
    // And the content follows without waiting for the reader to ask, since
    // they already asked by clicking a Citation.
    if (this.store.openDocument()) {
      await this.store.loadDocumentContent(this.notebookId, this.documentId, this.citedVersionId);
    }
  }

  ngOnDestroy(): void {
    // The store is root-provided and outlives this page, so an opened
    // Document — and especially its up-to-200-page content — has to be
    // dropped explicitly rather than held until the next one replaces it.
    this.store.clearOpenDocument();
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
    void this.store.loadDocumentContent(this.notebookId, this.documentId, versionId);
  }
}

/** A query parameter as a number, or null when absent or not a number. */
function numberParam(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
