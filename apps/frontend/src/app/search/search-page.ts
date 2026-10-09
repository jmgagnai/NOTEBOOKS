import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, OnDestroy, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, PRIMARY_OUTLET, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { chunkLinkParams } from '../documents/chunk-link';
import { OPENED_FROM_SEARCH } from '../documents/opened-from-search';
import { NotebooksStore } from '../notebooks/notebooks.store';
import { MarkedText } from './marked-text';
import { SearchResult, SearchStore } from './search.store';
import { showPageTitle } from '../shared/page-title';

/**
 * Searching one Notebook (NBK-9), in Copilot's look since NBK-96
 * (`docs/design/copilot-ui/reference/search-page.png`): a header row with ✕
 * back to the Notebook, a pill box searched on Enter, and flat result rows —
 * Chunks of its Documents, opening the Document at that Chunk (NBK-104),
 * then Exchanges of its Chat Threads (NBK-97).
 *
 * The query lives in the URL (`?q=`), so a reload, a shared link and Back
 * from a Document all show the same results. A search runs on Enter, as
 * Copilot's does, not as you type, and coming Back reuses the results the
 * shared store already holds for the same Notebook and query, so they
 * reappear as they were left.
 */
@Component({
  selector: 'app-search-page',
  standalone: true,
  imports: [
    DatePipe,
    MarkedText,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    RouterLink,
  ],
  templateUrl: './search-page.html',
  styleUrl: './search-page.scss',
})
export class SearchPage implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly notebooksStore = inject(NotebooksStore);
  protected readonly store = inject(SearchStore);

  protected readonly notebookId = this.route.snapshot.paramMap.get('notebookId')!;
  protected readonly notebook = computed(
    () => this.notebooksStore.notebooks().find((n) => n.id === this.notebookId) ?? null,
  );

  // NBK-61: the tab names the Notebook being searched, as its own page does.
  private readonly tabTitle = showPageTitle(() => this.notebook()?.title);

  /** The query the URL carries; '' when there is none. */
  private readonly query = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });
  private readonly urlQuery = computed(() => (this.query().get('q') ?? '').trim());

  /**
   * What is in the search box right now — component state, not store state:
   * it is an unsubmitted draft, and the store holds the query the displayed
   * results actually answer. Starts as the URL's query.
   */
  protected readonly draft = signal(this.urlQuery());

  constructor() {
    // Only to put a title on the page; Notebooks have no `GET /notebooks/:id`
    // endpoint, so the title comes from the already-loaded list by route id,
    // the same way the Notebook detail page gets it.
    void this.notebooksStore.loadNotebooks();

    // The URL's query is what is searched: on arrival, and on each Enter.
    effect(() => {
      const q = this.urlQuery();
      untracked(() => {
        this.draft.set(q);
        if (!q) this.store.clear();
        else if (!this.store.holds(this.notebookId, q)) void this.store.search(this.notebookId, q);
      });
    });
  }

  ngOnDestroy(): void {
    // The store is root-provided and outlives this page. Results are kept
    // only for opening one of them — Back comes here with the same `?q=` —
    // and dropped for anything else, so they never reappear over another
    // Notebook or a later visit.
    if (!this.leavingForOneOfItsResults()) this.store.clear();
  }

  protected onDraftInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  /**
   * Enter searches — but not the Enter that confirms an input method's
   * composition (Japanese, Chinese, Korean…), which is still typing, and
   * would otherwise search for half a word (NBK-96 review).
   */
  protected onEnter(event: KeyboardEvent): void {
    event.preventDefault();
    if (event.isComposing) return;
    this.submit();
  }

  /** Searches the box's query: into the URL, which searches; the same query again searches again. */
  protected submit(): void {
    const q = this.draft().trim();
    if (q === this.urlQuery()) {
      if (q) void this.store.search(this.notebookId, q);
      return;
    }
    void this.router.navigate([], { relativeTo: this.route, queryParams: { q: q || null } });
  }

  /** A search that found nothing in either the Documents or the Chat Threads. */
  protected readonly nothingMatches = computed(
    () =>
      !this.store.results().length &&
      !this.store.exchanges().length &&
      !this.store.error() &&
      !this.store.exchangesError(),
  );

  /** Which Document a Chunk is from, and where: "<title or filename> · <heading › heading>". */
  protected whereFrom(result: SearchResult): string {
    return [result.title ?? result.filename, result.headingPath.join(' › ')]
      .filter((part) => part !== '')
      .join(' · ');
  }

  /** A Document result opens the Document at its Chunk, as a Citation does. */
  protected readonly chunkLink = chunkLinkParams;

  /** And says it came from here, so the Document's back arrow returns here (NBK-103). */
  protected readonly openedFromSearch = OPENED_FROM_SEARCH;

  private leavingForOneOfItsResults(): boolean {
    const next = this.router.currentNavigation()?.finalUrl;
    const segments = next?.root.children[PRIMARY_OUTLET]?.segments.map((s) => s.path) ?? [];
    return (
      segments[0] === 'notebooks' && segments[1] === this.notebookId && segments[2] === 'documents'
    );
  }
}
