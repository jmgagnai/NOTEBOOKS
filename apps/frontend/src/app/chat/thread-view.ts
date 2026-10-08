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
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { Citation, ChatMessage, ChatStore, ChatThread } from './chat.store';
import { Avatar } from '../shared/avatar';
import { SparkleAvatar } from '../shared/sparkle-avatar';
import { Composer } from './composer';
import { EditableTitle } from '../shared/editable-title';
import { ThreadEmptyState } from './thread-empty-state';
import { NEW_THREAD_TITLE } from './thread-navigator';

/** One rendered block of a streamed answer: a chunk, split on its markers. */
interface AnswerBlock {
  /** Stable across re-renders, so appending a chunk doesn't re-create earlier ones. */
  index: number;
  segments: AnswerSegment[];
}

/**
 * One piece of an answer's prose: either plain text, or a source marker that
 * resolved to a Citation.
 *
 * Splitting the answer rather than rewriting it is what keeps the prose
 * exactly as the model wrote it — a marker the backend dropped (because it
 * named a Chunk that was never retrieved) stays visible as the plain text
 * it is instead of becoming a link to nowhere.
 */
interface AnswerSegment {
  text: string;
  /** The Citation this segment links to, or null for ordinary prose. */
  citation: Citation | null;
}

/** The marker notation the backend asks the model for, read back here. */
const MARKER = /\[(\d{1,3})\]/g;

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
 * link on each source marker in the prose, and as a named source list under
 * it. Both links carry the Citation's pinned Document Version and chunk, so
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
    Composer,
    EditableTitle,
    MatProgressSpinnerModule,
    MatTooltipModule,
    RouterLink,
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

    // Rule 2 (story 15c): the question just sent comes into view at the
    // bottom. The store renders nothing optimistically, so the question is
    // on screen only once the exchange is recorded — and if its answer
    // streamed meanwhile, rule 3 has already placed the view, which the
    // recorded exchange must not move.
    let askedAt: { streamSeen: string | null; messageCount: number } | null = null;
    effect(() => {
      const sending = this.store.sending();
      const messageCount = this.store.messages().length;
      if (sending) {
        askedAt ??= { streamSeen: seenStream, messageCount };
        return;
      }
      if (!askedAt) return;
      const streamed = seenStream !== askedAt.streamSeen;
      const recorded = messageCount > askedAt.messageCount;
      askedAt = null;
      if (streamed || !recorded) return;
      this.afterRender((list) => {
        const questions = list.querySelectorAll<HTMLElement>('.thread-view__message--user');
        questions[questions.length - 1]?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
      });
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
    return streaming.chunks.map((text, index) => ({
      index,
      segments: this.segments(text, streaming.citations),
    }));
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
   * Splits prose on its source markers, pairing each marker with the
   * Citation it refers to.
   *
   * A marker with no Citation stays a plain-text segment: the backend only
   * records Citations for markers that named a Chunk the answer was
   * actually grounded in, so an unmatched marker is one it deliberately
   * dropped and must not be made clickable.
   *
   * Takes the text and the Citations rather than a `ChatMessage` so a
   * streaming answer's chunks go through the same code (NBK-11). That is
   * worth the extra parameter: a chunk whose markers rendered differently
   * from the recorded message's would make the preview visibly swap for
   * something else at the end. It also means a marker in a chunk is plain
   * text until the completion event brings the Citations, which is correct —
   * they cannot be resolved from a half-written answer.
   */
  protected segments(content: string, citations: Citation[]): AnswerSegment[] {
    const byMarker = new Map(citations.map((c) => [c.marker, c]));
    const segments: AnswerSegment[] = [];
    let from = 0;

    for (const match of content.matchAll(MARKER)) {
      const citation = byMarker.get(Number(match[1]));
      if (!citation) continue;
      const at = match.index!;
      if (at > from) segments.push({ text: content.slice(from, at), citation: null });
      segments.push({ text: match[0], citation });
      from = at + match[0].length;
    }
    if (from < content.length) {
      segments.push({ text: content.slice(from), citation: null });
    }
    return segments;
  }

  /**
   * What a reader sees a source called. Per NBK-12 the name derives from the
   * chunk's heading path — the Document says *which* file, the path says
   * where in it — so no label is stored or sent.
   */
  protected citationName(citation: Citation): string {
    return citation.headingPath.length > 0
      ? `${citation.filename} — ${citation.headingPath.join(' > ')}`
      : citation.filename;
  }

  /**
   * The route a Citation opens: its Document, with the pinned Version, the
   * pinned chunk and that chunk's character range as query parameters.
   *
   * The Version id travels in the link rather than being looked up on arrival
   * because the Document's latest Version may well have moved on — and
   * GLOSSARY.md requires that following a Citation still open "that exact
   * Version at that location, even after newer Versions exist". The character
   * range rides along so the link is self-sufficient: copied, bookmarked or
   * shared, it still scrolls to the cited Chunk, because the range is fixed
   * to a Version whose content can never change.
   */
  protected citationLink(citation: Citation): (string | number)[] {
    return ['/notebooks', this.notebookId(), 'documents', citation.documentId];
  }

  protected citationParams(citation: Citation): Record<string, string | number> {
    const params: Record<string, string | number> = {
      version: citation.documentVersionId,
      chunk: citation.chunkId,
    };
    // Omitted rather than sent as null when the Chunk could not be located
    // in the Converted Markdown: the Version still opens, just not scrolled.
    if (citation.charStart !== null) params['from'] = citation.charStart;
    if (citation.charEnd !== null) params['to'] = citation.charEnd;
    return params;
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
