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
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatStore, ChatThread, PendingQuestion } from './chat.store';
import { Avatar } from '../shared/avatar';
import { SparkleAvatar } from '../shared/sparkle-avatar';
import { Composer } from './composer';
import { AnswerBody } from './answer-body';
import { CitationGroups } from './citation-groups';
import { EditableTitle } from '../shared/editable-title';
import { NotebooksStore } from '../notebooks/notebooks.store';

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
 * With no Thread open it is the Notebook landing instead (NBK-81, spec 07
 * "Middle pane: landing or Thread"): the Notebook's title, renamed in place
 * through the Notebooks store, over the same composer, which then starts a
 * Thread to ask in. An open Thread's back arrow closes it and returns here.
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
 * This component loads nothing: loading the Threads, watching the
 * Notebook's App Events and resetting the store belong to the Notebook page
 * (`NotebookDetailPage`, since NBK-79), which outlives both this view and
 * the sidebar's Thread navigator; and the Notebook list the landing's title
 * comes from is the page's to load too.
 */
@Component({
  selector: 'app-thread-view',
  standalone: true,
  imports: [
    AnswerBody,
    CitationGroups,
    Composer,
    EditableTitle,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    NgTemplateOutlet,
    Avatar,
    SparkleAvatar,
  ],
  templateUrl: './thread-view.html',
  styleUrl: './thread-view.scss',
})
export class ThreadView {
  readonly notebookId = input.required<string>();

  /**
   * The Thread view as the Document page's chat pane (spec 08): with no
   * Thread open it is the question box alone — no Notebook landing, whose
   * folder and title would compete with the Document's own headline in a
   * third of the page — and its back arrow closes the Thread rather than
   * returning to a landing.
   */
  readonly compact = input(false);

  protected readonly backLabel = computed(() =>
    this.compact() ? 'Close Chat Thread' : 'Back to Notebook',
  );

  protected readonly store = inject(ChatStore);

  private readonly notebooks = inject(NotebooksStore);

  private readonly injector = inject(Injector);

  /** The Thread card's scrolling region (NBK-53); absent while loading or empty. */
  private readonly messageList = viewChild<ElementRef<HTMLElement>>('messageList');

  /** The row of the question in flight, while there is one (NBK-70). */
  private readonly pendingRow = viewChild<ElementRef<HTMLElement>>('pendingQuestion');

  constructor() {
    // NBK-53, rule 1 (story 15b): opening or switching to a Thread lands at
    // its end, once — after its messages are in, since scrolling the list
    // of the Thread being left (or the spinner) would be lost on the swap.
    // Opened at an Exchange by a search result instead (NBK-97), it lands
    // with that Exchange's question at the top, where reading it starts.
    let landed: string | null = null;
    effect(() => {
      const threadId = this.store.activeThreadId();
      const found = this.foundExchange();
      const landing = `${threadId}/${this.store.foundAnswerId()}`;
      if (this.store.messagesLoading() || landing === landed) return;
      landed = landing;
      if (found) {
        this.afterRender((list) =>
          list
            .querySelector<HTMLElement>(`[data-message-id="${found.questionId}"]`)
            ?.scrollIntoView?.({ block: 'start' }),
        );
        return;
      }
      // Optional call: jsdom has no scrollTo, and since NBK-81 an open
      // Thread with no messages renders its (empty) list too.
      this.afterRender((list) => list.scrollTo?.({ top: list.scrollHeight }));
    });

    // Rule 3 (story 15d, amended): the list follows an answer to its end —
    // each block as it streams in, and the recorded exchange taking the
    // preview's place, or arriving unstreamed — so the newest text, its
    // Citations and the question box stay in view. Keyed on the open Thread:
    // its messages arriving on open or switch are rule 1's landing, not a
    // follow, and a count that drops (the Thread swapped) starts afresh.
    let followedThread: string | null = null;
    let followedMessages = 0;
    let followedBlocks = 0;
    effect(() => {
      const threadId = this.store.activeThreadId();
      const messages = this.store.messages().length;
      const blocks = this.streamingBlocks().length;
      // Counted apart: the recorded exchange replacing a preview adds
      // messages as it drops blocks, and either growing is news.
      const grew =
        threadId === followedThread && (messages > followedMessages || blocks > followedBlocks);
      followedThread = threadId;
      followedMessages = messages;
      followedBlocks = blocks;
      if (!grew || this.store.messagesLoading()) return;
      this.afterRender((list) => list.scrollTo?.({ top: list.scrollHeight, behavior: 'smooth' }));
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

  /**
   * The Exchange a search result opened the Thread at (NBK-97): the named
   * answer and the question it answers. Null when the Thread was opened any
   * other way, or the answer is not among its messages.
   */
  protected readonly foundExchange = computed(() => {
    const answerId = this.store.foundAnswerId();
    const messages = this.store.messages();
    const at = messages.findIndex((m) => m.id === answerId && m.role === 'assistant');
    if (at < 1 || messages[at - 1].role !== 'user') return null;
    return { questionId: messages[at - 1].id, answerId: messages[at].id };
  });

  /** Whether a message is half of the Exchange a search result opened (NBK-97). */
  protected isFound(messageId: string): boolean {
    const found = this.foundExchange();
    return found !== null && (found.questionId === messageId || found.answerId === messageId);
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

  /** The Notebook as the page's Notebooks store holds it; the page loads the list. */
  private readonly notebook = computed(() => this.notebooks.byId(this.notebookId()));

  /**
   * The landing's title (NBK-81), under the name the Notebook page falls
   * back to while the list loads.
   */
  protected readonly notebookTitle = computed(() => this.notebook()?.title ?? 'Notebook');

  /**
   * Whether to open the landing's title for editing on arrival: the page
   * says so after "Create Notebook" (spec 05 story 3), whose title is a
   * placeholder. An input rather than this view reading the navigation
   * itself, because the page is what the router activates — the moment the
   * navigation's state is at hand — and the landing title has been the only
   * one on the page since NBK-82 removed the header.
   */
  readonly editTitleOnArrival = input(false);

  private readonly landingTitle = viewChild<EditableTitle>('landingTitle');

  // Once the Notebook has loaded and the landing has rendered its title, so
  // the box opens on the real title rather than the "Notebook" placeholder;
  // once only, so a later rename, list reload or return to the landing does
  // not reopen it.
  private titleOpenedOnArrival = false;
  private readonly openTitleOnArrival = effect(() => {
    const title = this.landingTitle();
    if (this.titleOpenedOnArrival || !this.editTitleOnArrival()) return;
    if (!title || !this.notebook()) return;
    this.titleOpenedOnArrival = true;
    afterNextRender(() => title.edit(), { injector: this.injector });
  });

  /** The landing title hands over only a changed, non-blank title (NBK-41). */
  protected renameNotebook(title: string): void {
    void this.notebooks.renameNotebook(this.notebookId(), title);
  }

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
}
