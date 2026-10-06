import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { NotebooksStore } from '../notebooks/notebooks.store';
import { SearchStore } from './search.store';

/**
 * Searching one Notebook's Documents (NBK-9).
 *
 * Every result is a Document shown with its Abstract — per GLOSSARY.md the
 * 50-100 word artifact "used in search results, search-result previews, and
 * document cards", written "to be skimmed in a list". That is the whole
 * purpose of the page: NBK-1's story is to "judge which result is relevant
 * before opening it", so the Abstract is what the reader gets, not a raw
 * matching passage.
 *
 * Searching is explicit (a button, or Enter) rather than as-you-type: every
 * search embeds the query through OpenRouter, so a keystroke-per-request
 * page would be both slow and billable.
 */
@Component({
  selector: 'app-search-page',
  standalone: true,
  imports: [MatButtonModule, MatCardModule, MatProgressSpinnerModule, RouterLink],
  templateUrl: './search-page.html',
  styleUrl: './search-page.scss',
})
export class SearchPage implements OnDestroy {
  private readonly route = inject(ActivatedRoute);

  protected readonly notebooksStore = inject(NotebooksStore);
  protected readonly store = inject(SearchStore);

  protected readonly notebookId = this.route.snapshot.paramMap.get('notebookId')!;
  protected readonly notebook = computed(
    () => this.notebooksStore.notebooks().find((n) => n.id === this.notebookId) ?? null,
  );

  /**
   * What is in the search box right now — component state, not store state:
   * it is an unsubmitted draft, and the store holds the query the displayed
   * results actually answer.
   */
  protected readonly draft = signal('');

  constructor() {
    // Only to put a title on the page; Notebooks have no `GET /notebooks/:id`
    // endpoint, so the title comes from the already-loaded list by route id,
    // the same way the Notebook detail page gets it.
    void this.notebooksStore.loadNotebooks();
  }

  ngOnDestroy(): void {
    // The store is root-provided and outlives this page, so results have to
    // be dropped explicitly or they would reappear over a different
    // Notebook.
    this.store.clear();
  }

  protected onDraftInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  protected submit(): void {
    void this.store.search(this.notebookId, this.draft());
  }
}
