import { Component, computed, inject, input, OnDestroy, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { RouterLink } from '@angular/router';
import { Citation, ChatMessage, ChatStore, ChatThread } from './chat.store';

/**
 * One piece of an answer's prose: either plain text, or a source marker that
 * resolved to a Citation.
 *
 * Splitting the answer rather than rewriting it is what keeps the prose
 * exactly as the model wrote it — a marker the backend dropped (because it
 * named a passage that was never retrieved) stays visible as the plain text
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
 *
 * Every answer also carries its Citations (NBK-12), rendered twice over: as a
 * link on each source marker in the prose, and as a named source list under
 * it. Both links carry the Citation's pinned Document Version and chunk, so
 * following one opens the Version the answer was actually grounded in rather
 * than whatever is latest — which is the guarantee GLOSSARY.md makes about a
 * Citation and the reason an old answer stays checkable.
 */
@Component({
  selector: 'app-chat-panel',
  standalone: true,
  imports: [MatButtonModule, MatProgressSpinnerModule, RouterLink],
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

  /**
   * Splits a message's prose on its source markers, pairing each marker with
   * the Citation it refers to.
   *
   * A marker with no Citation stays a plain-text segment: the backend only
   * records Citations for markers that named a passage the answer was
   * actually grounded in, so an unmatched marker is one it deliberately
   * dropped and must not be made clickable.
   */
  protected segments(message: ChatMessage): AnswerSegment[] {
    const byMarker = new Map(message.citations.map((c) => [c.marker, c]));
    const segments: AnswerSegment[] = [];
    let from = 0;

    for (const match of message.content.matchAll(MARKER)) {
      const citation = byMarker.get(Number(match[1]));
      if (!citation) continue;
      const at = match.index!;
      if (at > from) segments.push({ text: message.content.slice(from, at), citation: null });
      segments.push({ text: match[0], citation });
      from = at + match[0].length;
    }
    if (from < message.content.length) {
      segments.push({ text: message.content.slice(from), citation: null });
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
   * shared, it still scrolls to the cited passage, because the range is fixed
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
    // Omitted rather than sent as null when the passage could not be located
    // in the Converted Markdown: the Version still opens, just not scrolled.
    if (citation.charStart !== null) params['from'] = citation.charStart;
    if (citation.charEnd !== null) params['to'] = citation.charEnd;
    return params;
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
