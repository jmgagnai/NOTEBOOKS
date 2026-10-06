import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { DocumentsStore } from './documents.store';
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
 * in, the chunk it cited, and that chunk's character range in the Version's
 * Converted Markdown. The page then opens *that* Version rather than the
 * latest, expanded straight to the content and marked at the cited passage,
 * because GLOSSARY.md requires that following a Citation open "that exact
 * Version at that location, even after newer Versions exist". The Version id
 * is read off the link rather than resolved here precisely so a newer upload
 * cannot move it.
 */
@Component({
  selector: 'app-document-detail-page',
  standalone: true,
  imports: [MatButtonModule, MatCardModule, MatProgressSpinnerModule, MarkdownView, RouterLink],
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
   * specific passage, and making them click "Show full content" to reach it
   * would be asking them to find it themselves.
   */
  protected readonly expanded = signal(this.citedVersionId !== null);

  /**
   * True when the Citation points at a Version that is no longer the
   * Document's latest. Worth saying out loud: the page's own badge shows the
   * latest Version's number, so a reader comparing the two needs to be told
   * that the difference is deliberate.
   */
  protected readonly viewingSupersededVersion = computed(() => {
    const document = this.store.openDocument();
    return (
      this.citedVersionId !== null &&
      document !== null &&
      document.latestVersion.id !== this.citedVersionId
    );
  });

  /** Which Version's Converted Markdown this page shows. */
  private targetVersionId(): string | null {
    return this.citedVersionId ?? this.store.openDocument()?.latestVersion.id ?? null;
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
    await this.store.loadDocument(this.notebookId, this.documentId);
    // A followed Citation names its Version, so the content can be fetched
    // without waiting for the reader to ask — and fetched for the pinned
    // Version, not the Document's current one.
    if (this.citedVersionId !== null && this.store.openDocument()) {
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
