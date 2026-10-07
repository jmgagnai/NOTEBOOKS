import { Component, computed, effect, ElementRef, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { marked } from 'marked';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ChatMessage, ChatStore, Citation } from '../../chat/chat.store';
import { ProtoIcon } from './proto-icon';
/** Minimal escaping for a value placed in a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

import {
  protoCitationLink,
  protoCitationName,
  protoCitationParams,
  protoInitials,
  protoSegments,
} from './proto-chat-helpers';

interface Block {
  index: number;
  html: string;
}

/**
 * PROTOTYPE — throwaway. The open Chat Thread's messages in the Copilot
 * idiom: the user's question as a right-aligned grey bubble, the answer as
 * plain prose next to a sparkle avatar (the one gradient the design allows),
 * Citations as small chips under it. Shared by all three variants because
 * what differs between them is the frame, not the message rendering.
 */
@Component({
  selector: 'proto-message-list',
  standalone: true,
  imports: [RouterLink, MatProgressSpinnerModule, ProtoIcon],
  template: `
    @if (store.messagesLoading()) {
      <div class="pml__loading"><mat-progress-spinner mode="indeterminate" diameter="24" /></div>
    } @else if (store.messages().length === 0 && blocks().length === 0) {
      <div class="pml__empty">
        <span class="pml__spark"><proto-icon name="sparkle" [size]="22" /></span>
        <p class="pml__empty-title">Ask anything about this Notebook</p>
        <p class="pml__empty-hint">
          Answers are grounded in its Documents and cite where they came from.
        </p>
      </div>
    } @else {
      <ol class="pml">
        @for (m of store.messages(); track m.id) {
          <li class="pml__row" [class.pml__row--user]="m.role === 'user'">
            @if (m.role === 'assistant') {
              <span class="pml__spark pml__spark--sm"
                ><proto-icon name="sparkle" [size]="14"
              /></span>
            }
            <div class="pml__msg" [class.pml__msg--user]="m.role === 'user'">
              <span class="pml__author">{{ author(m) }}</span>
              @if (m.role === 'assistant') {
                <div
                  class="pml__content pml__md"
                  [innerHTML]="html(m.content, m.citations)"
                  (click)="onContentClick($event)"
                ></div>
              } @else {
                <p class="pml__content pml__plain">{{ m.content }}</p>
              }
              @if (m.citations.length > 0) {
                <ul class="pml__cites">
                  @for (c of m.citations; track c.id) {
                    <li>
                      <a class="pml__cite" [routerLink]="link(c)" [queryParams]="params(c)">
                        <span class="pml__cite-n">{{ c.marker }}</span>
                        <span class="pml__cite-name">{{ name(c) }}</span>
                        <span class="pml__cite-v">v{{ c.versionNumber }}</span>
                      </a>
                    </li>
                  }
                </ul>
              }
            </div>
            @if (m.role === 'user') {
              <span class="pml__avatar">{{ initials(m.askedBy.email) }}</span>
            }
          </li>
        }
        @if (blocks().length > 0) {
          <li class="pml__row">
            <span class="pml__spark pml__spark--sm pml__spark--live"
              ><proto-icon name="sparkle" [size]="14"
            /></span>
            <div class="pml__msg pml__msg--streaming">
              <span class="pml__author">Assistant, answering…</span>
              @for (b of blocks(); track b.index) {
                <div
                  class="pml__content pml__md"
                  [innerHTML]="b.html"
                  (click)="onContentClick($event)"
                ></div>
              }
            </div>
          </li>
        }
      </ol>
    }
    @if (store.error(); as error) {
      <p class="pml__error">{{ error }}</p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .pml {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .pml__row {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .pml__row--user {
      justify-content: flex-end;
    }
    .pml__msg {
      min-width: 0;
      max-width: 100%;
    }
    .pml__msg--user {
      background: #f0f0f0;
      border-radius: 12px 12px 2px 12px;
      padding: 8px 12px;
      max-width: 72%;
    }
    .pml__msg--streaming .pml__content + .pml__content {
      margin-top: 8px;
    }
    .pml__author {
      display: block;
      font-size: 12px;
      color: #616161;
      margin-bottom: 2px;
    }
    .pml__content {
      margin: 0;
      font-size: 14px;
      line-height: 20px;
      color: #242424;
    }
    .pml__plain {
      white-space: pre-wrap;
    }
    .pml__md {
      overflow-wrap: break-word;
    }
    .pml__msg--streaming .pml__md + .pml__md {
      margin-top: 8px;
    }
    .pml__md ::ng-deep > :first-child {
      margin-top: 0;
    }
    .pml__md ::ng-deep > :last-child {
      margin-bottom: 0;
    }
    .pml__md ::ng-deep h1,
    .pml__md ::ng-deep h2,
    .pml__md ::ng-deep h3,
    .pml__md ::ng-deep h4 {
      margin: 16px 0 6px;
      line-height: 1.3;
      font-weight: 600;
      color: #242424;
    }
    .pml__md ::ng-deep h1 {
      font-size: 20px;
    }
    .pml__md ::ng-deep h2 {
      font-size: 18px;
    }
    .pml__md ::ng-deep h3 {
      font-size: 16px;
    }
    .pml__md ::ng-deep h4 {
      font-size: 14px;
    }
    .pml__md ::ng-deep p,
    .pml__md ::ng-deep ul,
    .pml__md ::ng-deep ol {
      margin: 8px 0;
    }
    .pml__md ::ng-deep li + li {
      margin-top: 2px;
    }
    .pml__md ::ng-deep table {
      display: block;
      max-width: 100%;
      overflow-x: auto;
      border-collapse: collapse;
      margin: 10px 0;
      font-size: 13px;
    }
    .pml__md ::ng-deep th,
    .pml__md ::ng-deep td {
      border: 1px solid #e0e0e0;
      padding: 5px 8px;
      text-align: left;
      vertical-align: top;
    }
    .pml__md ::ng-deep th {
      background: #f5f5f5;
      font-weight: 600;
      white-space: nowrap;
    }
    .pml__md ::ng-deep code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.9em;
      background: #f5f5f5;
      border-radius: 3px;
      padding: 0 4px;
    }
    .pml__md ::ng-deep pre {
      overflow-x: auto;
      padding: 10px 12px;
      border-radius: 6px;
      background: #f5f5f5;
    }
    .pml__md ::ng-deep pre code {
      background: none;
      padding: 0;
    }
    .pml__md ::ng-deep blockquote {
      margin: 8px 0;
      padding-left: 12px;
      border-left: 3px solid #e0e0e0;
      color: #616161;
    }
    .pml__md ::ng-deep a:not(.pml__marker) {
      color: #0f6cbd;
    }
    .pml__md ::ng-deep .pml__marker,
    .pml__marker {
      color: #0f6cbd;
      font-size: 11px;
      vertical-align: super;
      font-weight: 600;
      text-decoration: none;
    }
    .pml__md ::ng-deep .pml__marker:hover,
    .pml__marker:hover {
      text-decoration: underline;
    }
    .pml__cites {
      list-style: none;
      margin: 8px 0 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .pml__cite {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 320px;
      padding: 2px 8px 2px 2px;
      border: 1px solid #e0e0e0;
      border-radius: 4px;
      background: #fff;
      color: #242424;
      font-size: 12px;
      text-decoration: none;
    }
    .pml__cite:hover {
      background: #f5f5f5;
      border-color: #d1d1d1;
    }
    .pml__cite-n {
      width: 18px;
      height: 18px;
      border-radius: 3px;
      background: #ebf3fc;
      color: #0f6cbd;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
    }
    .pml__cite-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pml__cite-v {
      color: #616161;
      flex: none;
    }
    .pml__spark {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      flex: none;
      background: linear-gradient(135deg, #0f6cbd 0%, #7a5af8 60%, #e3008c 100%);
    }
    .pml__spark--sm {
      width: 24px;
      height: 24px;
      margin-top: 14px;
    }
    .pml__spark--live {
      animation: pml-pulse 1.4s ease-in-out infinite;
    }
    @keyframes pml-pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.45;
      }
    }
    .pml__avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: #0f6cbd;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      margin-top: 10px;
    }
    .pml__empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 48px 16px;
      gap: 8px;
    }
    .pml__empty-title {
      margin: 8px 0 0;
      font-size: 20px;
      font-weight: 600;
      color: #242424;
    }
    .pml__empty-hint {
      margin: 0;
      font-size: 14px;
      color: #616161;
      max-width: 360px;
    }
    .pml__loading {
      display: flex;
      justify-content: center;
      padding: 24px;
    }
    .pml__error {
      color: #c50f1f;
      background: #fde7e9;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 13px;
      margin: 12px 0 0;
    }
  `,
})
export class ProtoMessageList {
  readonly notebookId = input.required<string>();
  protected readonly store = inject(ChatStore);

  protected readonly blocks = computed<Block[]>(() => {
    const s = this.store.streamingAnswer();
    if (!s) return [];
    return s.chunks.map((text, index) => ({ index, html: this.html(text, s.citations) }));
  });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // Two scroll behaviours, one effect so they cannot fight:
    // - Switching Thread (or opening the first) scrolls to the bottom once
    //   its messages are in, so the latest exchange is what you land on.
    // - An answer starting to stream, and the recorded message replacing the
    //   preview, scroll so the answer's first line sits at the top.
    let seenThread: string | null | undefined;
    let seenBlocks = 0;
    let seenMessages = 0;
    effect(() => {
      const thread = this.store.activeThreadId();
      const loading = this.store.messagesLoading();
      const messages = this.store.messages();
      const blocks = this.blocks().length;

      if (thread !== seenThread) {
        if (loading) return; // wait for the switch to finish loading
        seenThread = thread;
        seenBlocks = blocks;
        seenMessages = messages.length;
        setTimeout(() => this.scrollToBottom());
        return;
      }

      const lastIsAnswer = messages.at(-1)?.role === 'assistant';
      const answerStarted = seenBlocks === 0 && blocks > 0;
      const answerLanded = blocks === 0 && messages.length > seenMessages && lastIsAnswer;
      seenBlocks = blocks;
      seenMessages = messages.length;
      if (!answerStarted && !answerLanded) return;
      setTimeout(() => {
        const rows = this.host.nativeElement.querySelectorAll<HTMLElement>('.pml__row');
        rows[rows.length - 1]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    });
  }

  /** The nearest scrollable ancestor is the pane; drop it to its end. */
  private scrollToBottom(): void {
    let el: HTMLElement | null = this.host.nativeElement.parentElement;
    while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  protected author(m: ChatMessage): string {
    return m.role === 'assistant' ? `Copilot · for ${m.askedBy.email}` : m.askedBy.email;
  }
  private readonly router = inject(Router);

  /**
   * An answer as HTML (spec 04: answers are Markdown). Each source marker
   * whose Citation exists is swapped for a real link *before* parsing, so it
   * survives inside headings, list items and table cells; markers with no
   * Citation stay plain text. The HTML goes through Angular's `[innerHTML]`
   * sanitizer, which keeps `href`, `class` and `title` and drops the rest.
   * Pulls `marked` into the main bundle — acceptable for the prototype only.
   */
  protected html(content: string, citations: Citation[]): string {
    const marked_up = protoSegments(content, citations)
      .map((seg) =>
        seg.citation
          ? `<a class="pml__marker" href="${this.href(seg.citation)}" title="${escapeAttr(protoCitationName(seg.citation))}">${seg.text}</a>`
          : seg.text,
      )
      .join('');
    return marked.parse(marked_up, { async: false, gfm: true }) as string;
  }

  private href(c: Citation): string {
    return this.router.serializeUrl(
      this.router.createUrlTree(protoCitationLink(this.notebookId(), c), {
        queryParams: protoCitationParams(c),
      }),
    );
  }

  /** In-app links inside the rendered HTML go through the router, not a reload. */
  protected onContentClick(event: MouseEvent): void {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor || event.metaKey || event.ctrlKey) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!href.startsWith('/')) return;
    event.preventDefault();
    void this.router.navigateByUrl(href);
  }
  protected name(c: Citation): string {
    return protoCitationName(c);
  }
  protected link(c: Citation): (string | number)[] {
    return protoCitationLink(this.notebookId(), c);
  }
  protected params(c: Citation): Record<string, string | number> {
    return protoCitationParams(c);
  }
  protected initials(email: string): string {
    return protoInitials(email);
  }
}
