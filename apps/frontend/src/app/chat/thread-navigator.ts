import { DatePipe } from '@angular/common';
import { Component, inject, input, OnDestroy, OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatStore, ChatThread } from './chat.store';

/**
 * The fixed title a Thread starts with (NBK-43, spec 04 "Default Thread"):
 * the create request requires a non-empty title, and the user renames the
 * Thread from the Thread view's header once they know what it is about.
 */
export const NEW_THREAD_TITLE = 'New Chat Thread';

/**
 * The Chat Threads navigator of a Notebook (NBK-10, split out in NBK-34,
 * redesigned as a list in NBK-43): every Thread in the Notebook, the open one
 * marked, and the one control that starts a new one.
 *
 * Per GLOSSARY.md and ADR-0001 the list is every Thread in the Notebook, not
 * this user's — so each entry names its author. That attribution is the only
 * thing author identity is used for here: nothing is hidden or disabled
 * because someone else started it.
 *
 * This component owns the ChatStore's lifecycle for the Notebook — loading
 * the Threads (which opens the most recent one, see `ChatStore.loadThreads`),
 * opening the live App Event stream and resetting the store on the way out.
 * The Thread view (`ThreadView`) only reads the store. One owner rather than
 * two because `reset` also closes the live connection and clears the open
 * Thread, so two components each resetting would wipe the other's state
 * whenever one of them left first; and it is the navigator rather than the
 * view because the Threads are what has to be loaded for anything to be
 * opened at all. The workspace frame (NBK-35) places the two in different
 * cards, which is why neither relies on the other's position or on being
 * rendered first — only on the shared store.
 */
@Component({
  selector: 'app-thread-navigator',
  standalone: true,
  imports: [DatePipe, MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatTooltipModule],
  templateUrl: './thread-navigator.html',
  styleUrl: './thread-navigator.scss',
})
export class ThreadNavigator implements OnInit, OnDestroy {
  readonly notebookId = input.required<string>();

  protected readonly store = inject(ChatStore);

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

  protected newThread(): void {
    void this.store.createThread(this.notebookId(), NEW_THREAD_TITLE);
  }

  protected openThread(thread: ChatThread): void {
    // Not a reload: the row of the open Thread is marked, not disabled, so a
    // click on it has to be harmless — re-fetching would blank the messages
    // for a moment and drop an answer streaming into them.
    if (this.isOpen(thread)) return;
    void this.store.openThread(this.notebookId(), thread.id);
  }

  protected isOpen(thread: ChatThread): boolean {
    return thread.id === this.store.activeThreadId();
  }
}
