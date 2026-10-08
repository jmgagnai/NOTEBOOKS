import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatStore, ChatThread, PendingQuestion } from './chat.store';
import { Avatar } from '../shared/avatar';
import { SparkleAvatar } from '../shared/sparkle-avatar';
import { Composer } from './composer';
import { AnswerBody } from './answer-body';
import { CitationGroups } from './citation-groups';
import { EditableTitle } from '../shared/editable-title';
import { ThreadEmptyState } from './thread-empty-state';
import { NEW_THREAD_TITLE } from './thread-navigator';

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
 * chip on each Citation marker in the Markdown prose (`AnswerBody`), and as
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
    NgTemplateOutlet,
    Avatar,
    SparkleAvatar,
    ThreadEmptyState,
  ],
  templateUrl: './thread-view.html',
  styleUrl: './thread-view.scss',
})
export class ThreadView {
  readonly notebookId = input.required<string>();

  protected readonly store = inject(ChatStore);

  private readonly composer = viewChild.required(Composer);

  private readonly injector = inject(Injector);

  /** The Thread card's scrolling region (NBK-53); absent while loading or empty. */
  private readonly messageList = viewChild<ElementRef<HTMLElement>>('messageList');

  /** The row of the question in flight, while there is one (NBK-70). */
  private readonly pendingRow = viewChild<ElementRef<HTMLElement>>('pendingQuestion');

  /** The row of the answer being streamed, while there is one. */
  private readonly streamingRow = viewChild<ElementRef<HTMLElement>>('streamingAnswer');

  constructor() {
    // NBK-53, rule 1 (story 15b): opening or switching to a Thread lands at
    // its end, once — after its messages are in, since scrolling the list
    // of the Thread being left (or the spinner) would be lost on the swap.
    let landedThread: string | null = null;
    effect(() => {
      const threadId = this.store.activeThreadId();
      if (this.store.messagesLoading() || threadId === landedThread) return;
      landedThread = threadId;
      this.afterRender((list) => list.scrollTo({ top: list.scrollHeight }));
    });

    // Rule 3 (story 15d): an answer's first block brings its start to the
    // top, and that is the only move it makes. Keyed on the stream, not on
    // the chunk count, so later blocks — and the recorded answer replacing
    // the preview — find the stream already seen. There is deliberately no
    // "follow the bottom": the reader reads a long answer from its start.
    let seenStream: string | null = null;
    effect(() => {
      const streamId = this.store.streamingAnswer()?.streamId ?? null;
      if (streamId === null || streamId === seenStream) return;
      seenStream = streamId;
      this.afterRender(() =>
        // Optional call: jsdom, for one, has no scrollIntoView.
        this.streamingRow()?.nativeElement.scrollIntoView?.({ block: 'start', behavior: 'smooth' }),
      );
    });

    // Rule 2 (story 15c, NBK-71): the question just sent comes into view at
    // the bottom, the moment its pending row appears. Keyed on the pending
    // question itself, so returning to its Thread mid-ask (rule 1 already
    // lands at the end) and the recorded question replacing it are not moves:
    // the recorded one sits where the preview was, already in view.
    let seenPending: PendingQuestion | null = null;
    effect(() => {
      const pending = this.pendingQuestion();
      if (pending === null || pending === seenPending) return;
      seenPending = pending;
      this.afterRender(() =>
        this.pendingRow()?.nativeElement.scrollIntoView?.({ block: 'end', behavior: 'smooth' }),
      );
    });
  }

  /**
   * Runs a scroll once the change that called for it is on screen: the rows
   * it measures or brings into view do not exist until the next render.
   */
  private afterRender(scroll: (list: HTMLElement) => void): void {
    afterNextRender(
      {
        write: () => {
          const list = this.messageList()?.nativeElement;
          if (list) scroll(list);
        },
      },
      { injector: this.injector },
    );
  }

  protected readonly activeThread = computed<ChatThread | null>(
    () => this.store.threads().find((t) => t.id === this.store.activeThreadId()) ?? null,
  );

  /**
   * The question in flight (NBK-70), while its Thread is the open one: the
   * store keeps it across a Thread switch, since the ask is still out, but
   * it belongs only to the Thread it was asked in.
   */
  protected readonly pendingQuestion = computed<PendingQuestion | null>(() => {
    const pending = this.store.pendingQuestion();
    return pending?.threadId === this.store.activeThreadId() ? pending : null;
  });

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

  /** The e-mail's local part: how a question's author line names its asker (NBK-44). */
  protected shortName(email: string): string {
    return email.split('@')[0];
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

  /**
   * Asks a starter prompt (NBK-54), starting a Chat Thread first when none
   * is open — titled as the navigator's "New Chat Thread" button titles one,
   * so a Thread is the same thing however it was started. `createThread`
   * makes the new Thread the open one, which is what the composer asks into;
   * if it failed, nothing is open and the store's error is already showing.
   */
  protected async askStarter(prompt: string): Promise<void> {
    if (this.store.activeThreadId() === null) {
      await this.store.createThread(this.notebookId(), NEW_THREAD_TITLE);
    }
    await this.composer().ask(prompt);
  }
}
