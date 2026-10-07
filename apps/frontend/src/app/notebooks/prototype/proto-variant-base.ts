import { computed, Directive, inject, input, OnDestroy, OnInit, signal } from '@angular/core';
import { ChatStore } from '../../chat/chat.store';
import { DocumentsStore } from '../../documents/documents.store';
import { NotebooksStore } from '../notebooks.store';

/**
 * PROTOTYPE — throwaway. What every workspace variant needs regardless of
 * its frame: the stores, the chat lifecycle the real `ChatPanel` runs
 * (load Threads, follow the Notebook's events, reset on leave), and the
 * inline-editable title from spec 02. Layout stays in each variant.
 */
@Directive()
export abstract class ProtoVariantBase implements OnInit, OnDestroy {
  readonly notebookId = input.required<string>();
  /** The host page's drag-over state (NBK-18); the variant decides what lights up. */
  readonly dragOver = input(false);

  protected readonly notebooksStore = inject(NotebooksStore);
  protected readonly documentsStore = inject(DocumentsStore);
  protected readonly chat = inject(ChatStore);

  protected readonly notebook = computed(
    () => this.notebooksStore.notebooks().find((n) => n.id === this.notebookId()) ?? null,
  );
  protected readonly title = computed(() => this.notebook()?.title ?? 'Notebook');
  protected readonly activeThread = computed(
    () => this.chat.threads().find((t) => t.id === this.chat.activeThreadId()) ?? null,
  );
  protected readonly documentCount = computed(() => this.documentsStore.documents().length);
  protected readonly readyCount = computed(
    () => this.documentsStore.documents().filter((d) => d.status === 'ready').length,
  );

  protected readonly editing = signal(false);
  protected readonly titleDraft = signal('');
  protected readonly filter = signal('');

  ngOnInit(): void {
    void this.chat.loadThreads(this.notebookId());
    this.chat.watchNotebook(this.notebookId());
  }

  ngOnDestroy(): void {
    this.chat.reset();
  }

  protected startEdit(): void {
    this.titleDraft.set(this.title());
    this.editing.set(true);
    queueMicrotask(() => document.querySelector<HTMLInputElement>('.proto-title-input')?.select());
  }

  protected commitTitle(): void {
    if (!this.editing()) return;
    const next = this.titleDraft().trim();
    const nb = this.notebook();
    this.editing.set(false);
    if (nb && next && next !== nb.title) void this.notebooksStore.renameNotebook(nb.id, next);
  }

  protected cancelTitle(): void {
    this.editing.set(false);
  }

  protected onTitleInput(event: Event): void {
    this.titleDraft.set((event.target as HTMLInputElement).value);
  }

  protected onFilterInput(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }
}
