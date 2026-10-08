import { Component, computed, inject, input } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatMessage, ChatStore, ChatThread } from './chat.store';
import { Avatar } from '../shared/avatar';
import { SparkleAvatar } from '../shared/sparkle-avatar';
import { Composer } from './composer';
import { AnswerBody } from './answer-body';
import { CitationGroups } from './citation-groups';
import { EditableTitle } from '../shared/editable-title';

/** One block of a streamed answer: a chunk, as received. */
interface AnswerBlock {
  /** Stable across re-renders, so appending a chunk doesn't re-create earlier ones. */
  index: number;
  text: string;
}

/**
 * The open Chat Thread of a Notebook (NBK-10, split out in NBK-34): its
 * editable title, its messages, the answer being streamed into it,
 * and, through `Composer` (NBK-45), the question box.
 *
 * Every message names who asked it (GLOSSARY.md): a Thread is shared, so a
 * Chat Thread is unreadable without the attribution.
 *
 * An answer arrives twice over (NBK-11): first as paragraph/heading-sized
 * chunks on the live app-event stream, rendered as a preview the moment each
 * one lands, and then as the recorded `ChatMessage` the ask returns, which
 * replaces it. The preview is never a message — it has no id, no author and
 * no `createdAt`, because the backend writes the row only once the answer is
 * complete — which is why it renders beside `messages` rather than inside it.
 *
 * Every answer also carries its Citations (NBK-12), rendered twice over: as a
 * chip on each source marker in the Markdown prose (`AnswerBody`), and as
 * rows grouped by Document Version under it (`CitationGroups`, NBK-52). Both
 * links carry the Citation's pinned Document Version and chunk, so
 * following one opens the Version the answer was actually grounded in rather
 * than whatever is latest — which is the guarantee GLOSSARY.md makes about a
 * Citation and the reason an old answer stays checkable.
 *
 * This component only reads the ChatStore: loading the Threads, watching the
 * Notebook's App Events and resetting the store belong to the Thread
 * navigator (`ThreadNavigator`), so that the two can sit in different cards
 * (NBK-35) without either depending on the other being rendered first.
 */
@Component({
  selector: 'app-thread-view',
  standalone: true,
  imports: [
    AnswerBody,
    CitationGroups,
    Composer,
    EditableTitle,
    MatProgressSpinnerModule,
    MatTooltipModule,
    Avatar,
    SparkleAvatar,
  ],
  templateUrl: './thread-view.html',
  styleUrl: './thread-view.scss',
})
export class ThreadView {
  readonly notebookId = input.required<string>();

  protected readonly store = inject(ChatStore);

  protected readonly activeThread = computed<ChatThread | null>(
    () => this.store.threads().find((t) => t.id === this.store.activeThreadId()) ?? null,
  );

  /**
   * The streaming answer as blocks to render, one per chunk received.
   *
   * One element per chunk rather than one joined string, because a chunk *is*
   * a block of Markdown — a heading or a paragraph — and rendering them as
   * separate elements is both what a reader expects and what keeps appending
   * the next one from re-rendering the ones already on screen.
   */
  protected readonly streamingBlocks = computed<AnswerBlock[]>(() => {
    const streaming = this.store.streamingAnswer();
    if (!streaming) return [];
    return streaming.chunks.map((text, index) => ({ index, text }));
  });

  /**
   * The visible attribution (NBK-44): the asker's short name — the e-mail's
   * local part — or "Assistant". The full e-mail is the avatar's tooltip
   * instead, so a shared Thread stays attributed without "@example.com" on
   * every line; an answer no longer names its asker, since the question it
   * follows already does.
   */
  protected author(message: ChatMessage): string {
    return message.role === 'assistant' ? 'Assistant' : message.askedBy.email.split('@')[0];
  }

  /**
   * The header title (NBK-51) hands over only a changed, non-blank title, so
   * this just commits it. The Thread's id comes from the template rather than
   * `activeThread()` so a commit on blur still renames the Thread that was
   * being edited.
   */
  protected rename(threadId: string, title: string): void {
    void this.store.renameThread(this.notebookId(), threadId, title);
  }
}
