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

  /**
   * Whether the reader has expanded past the Executive Summary. Component
   * state rather than store state: it is this view's disclosure, and the
   * fetched content itself (which is what's worth keeping) lives in the
   * store.
   */
  protected readonly expanded = signal(false);

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
    void this.store.loadDocument(this.notebookId, this.documentId);
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
    const document = this.store.openDocument();
    if (!document) return;
    this.expanded.set(true);
    // A no-op if this Version's content is already loaded, so collapsing and
    // re-expanding doesn't re-download it.
    void this.store.loadDocumentContent(this.notebookId, this.documentId, document.latestVersion.id);
  }
}
