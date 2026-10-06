import { Component, computed, inject, input, OnDestroy, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ChatMessage, ChatStore, ChatThread } from './chat.store';

/**
 * The chat panel of a Notebook (NBK-10): the Notebook's Chat Threads on one
 * side, the open conversation on the other.
 *
 * Per GLOSSARY.md and ADR-0001 the list is every Thread in the Notebook, not
 * this user's — so each entry names its author, and every message names who
 * asked it. That attribution is the only thing author identity is used for
 * here: nothing is hidden or disabled because someone else started it.
 *
 * The answer arrives as one complete message (NBK-10 is deliberately not
 * streamed). NBK-11 upgrades the delivery to SSE paragraph/heading chunks,
 * which changes how `messages` grows, not what this renders.
 */
@Component({
  selector: 'app-chat-panel',
  standalone: true,
  imports: [MatButtonModule, MatProgressSpinnerModule],
  templateUrl: './chat-panel.html',
  styleUrl: './chat-panel.scss',
})
export class ChatPanel implements OnInit, OnDestroy {
  readonly notebookId = input.required<string>();

  protected readonly store = inject(ChatStore);

  /** The "start a Thread" box. Local: it is never read back from the server. */
  protected readonly newThreadTitle = signal('');
  /** The rename box for the open Thread. */
  protected readonly renameTitle = signal('');
  /** The question being typed. Survives a failed send so asking again works. */
  protected readonly draft = signal('');

  protected readonly activeThread = computed<ChatThread | null>(
    () => this.store.threads().find((t) => t.id === this.store.activeThreadId()) ?? null,
  );

  ngOnInit(): void {
    void this.store.loadThreads(this.notebookId());
  }

  ngOnDestroy(): void {
    // The store is root-provided and outlives this panel, so a stale
    // conversation would otherwise show up on the next Notebook opened.
    this.store.reset();
  }

  /** Who to credit a message to. An answer is attributed to the asker it replies to. */
  protected author(message: ChatMessage): string {
    return message.role === 'assistant'
      ? `Assistant, for ${message.askedBy.email}`
      : message.askedBy.email;
  }

  protected startThread(): void {
    const title = this.newThreadTitle().trim();
    if (!title) return;
    void this.store.createThread(this.notebookId(), title);
    this.newThreadTitle.set('');
  }

  protected openThread(thread: ChatThread): void {
    this.renameTitle.set(thread.title);
    this.draft.set('');
    void this.store.openThread(this.notebookId(), thread.id);
  }

  protected rename(): void {
    const thread = this.activeThread();
    const title = this.renameTitle().trim();
    if (!thread || !title || title === thread.title) return;
    void this.store.renameThread(this.notebookId(), thread.id, title);
  }

  protected async send(): Promise<void> {
    const thread = this.activeThread();
    const content = this.draft().trim();
    if (!thread || !content || this.store.sending()) return;
    // Cleared only on success: a failed ask records nothing on the server,
    // so re-sending is the retry and the text has to still be here.
    if (await this.store.sendMessage(this.notebookId(), thread.id, content)) {
      this.draft.set('');
    }
  }
}
