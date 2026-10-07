import { Component, inject, input, OnDestroy, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ChatStore, ChatThread } from './chat.store';

/**
 * The Chat Threads navigator of a Notebook (NBK-10, split out in NBK-34):
 * every Thread in the Notebook, and the box that starts a new one.
 *
 * Per GLOSSARY.md and ADR-0001 the list is every Thread in the Notebook, not
 * this user's — so each entry names its author. That attribution is the only
 * thing author identity is used for here: nothing is hidden or disabled
 * because someone else started it.
 *
 * This component owns the ChatStore's lifecycle for the Notebook — loading
 * the Threads, opening the live App Event stream and resetting the store on
 * the way out. The Thread view (`ThreadView`) only reads the store. One
 * owner rather than two because `reset` also closes the live connection and
 * clears the open Thread, so two components each resetting would wipe the
 * other's state whenever one of them left first; and it is the navigator
 * rather than the view because the Threads are what has to be loaded for
 * anything to be opened at all. The workspace frame (NBK-35) places the two
 * in different cards, which is why neither relies on the other's position
 * or on being rendered first — only on the shared store.
 */
@Component({
  selector: 'app-thread-navigator',
  standalone: true,
  imports: [MatButtonModule, MatProgressSpinnerModule],
  templateUrl: './thread-navigator.html',
  styleUrl: './thread-navigator.scss',
})
export class ThreadNavigator implements OnInit, OnDestroy {
  readonly notebookId = input.required<string>();

  protected readonly store = inject(ChatStore);

  /** The "start a Thread" box. Local: it is never read back from the server. */
  protected readonly newThreadTitle = signal('');

  ngOnInit(): void {
    void this.store.loadThreads(this.notebookId());
    // The same stream the Document status badges follow (NBK-6): an answer's
    // chunks are App Events like any other, so no second connection is
    // opened for them.
    this.store.watchNotebook(this.notebookId());
  }

  ngOnDestroy(): void {
    // The store is root-provided and outlives this panel, so a stale Chat
    // Thread would otherwise show up on the next Notebook opened.
    // `reset` also closes the live connection, so a panel that is gone stops
    // costing one.
    this.store.reset();
  }

  protected startThread(): void {
    const title = this.newThreadTitle().trim();
    if (!title) return;
    void this.store.createThread(this.notebookId(), title);
    this.newThreadTitle.set('');
  }

  protected openThread(thread: ChatThread): void {
    void this.store.openThread(this.notebookId(), thread.id);
  }
}
