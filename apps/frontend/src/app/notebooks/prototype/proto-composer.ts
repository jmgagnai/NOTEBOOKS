import { Component, computed, inject, input, signal } from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatStore } from '../../chat/chat.store';
import { ProtoIcon } from './proto-icon';

/**
 * PROTOTYPE — throwaway. The question box, Copilot-style: one bordered
 * 8 px box holding a growing textarea and a send button, Enter to send,
 * Shift+Enter for a newline. Wired to the real `ChatStore.sendMessage`
 * (a deliberate deviation from "stub the mutations": asking a real question
 * is the only honest way to judge a pinned composer under a streaming
 * answer, and it is exactly what the production page does).
 */
@Component({
  selector: 'proto-composer',
  standalone: true,
  imports: [MatTooltipModule, ProtoIcon],
  template: `
    <div class="pc" [class.pc--disabled]="!enabled()">
      <textarea
        class="pc__input"
        rows="1"
        aria-label="Ask a question"
        [placeholder]="placeholder()"
        [disabled]="!enabled()"
        [value]="draft()"
        (input)="onInput($event)"
        (keydown.enter)="onEnter($event)"
      ></textarea>
      <div class="pc__bar">
        <span class="pc__hint">{{ hint() }}</span>
        <button
          type="button"
          class="pc__send"
          aria-label="Send"
          matTooltip="Send (Enter)"
          [disabled]="!canSend()"
          (click)="send()"
        >
          <proto-icon name="send" [size]="18" />
        </button>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .pc {
      border: 1px solid #d1d1d1;
      border-radius: 8px;
      background: #fff;
      padding: 8px 8px 6px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      transition:
        border-color 0.12s,
        box-shadow 0.12s;
    }
    .pc:focus-within {
      border-color: #0f6cbd;
      box-shadow: 0 0 0 1px #0f6cbd inset;
    }
    .pc--disabled {
      background: #f5f5f5;
    }
    .pc__input {
      border: 0;
      outline: 0;
      resize: none;
      font: inherit;
      font-size: 14px;
      line-height: 20px;
      color: #242424;
      background: transparent;
      min-height: 40px;
      max-height: 160px;
      padding: 6px 0;
    }
    .pc__input::placeholder {
      color: #707070;
    }
    .pc__bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .pc__hint {
      font-size: 12px;
      color: #616161;
    }
    .pc__send {
      width: 32px;
      height: 32px;
      border-radius: 4px;
      border: 0;
      background: #0f6cbd;
      color: #fff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .pc__send:hover:not(:disabled) {
      background: #115ea3;
    }
    .pc__send:disabled {
      background: #e0e0e0;
      color: #bdbdbd;
      cursor: default;
    }
  `,
})
export class ProtoComposer {
  readonly notebookId = input.required<string>();
  readonly threadId = input<string | null>(null);
  readonly placeholder = input('Ask a question about this Notebook');

  protected readonly store = inject(ChatStore);
  protected readonly draft = signal('');

  protected readonly enabled = computed(() => this.threadId() !== null);
  protected readonly canSend = computed(
    () => this.enabled() && this.draft().trim().length > 0 && !this.store.sending(),
  );
  protected readonly hint = computed(() => {
    if (!this.enabled()) return 'Open or start a Chat Thread to ask';
    if (this.store.sending()) return 'Answering…';
    return 'Enter to send · Shift+Enter for a new line';
  });

  protected onInput(event: Event): void {
    const el = event.target as HTMLTextAreaElement;
    this.draft.set(el.value);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  protected onEnter(event: Event): void {
    const e = event as KeyboardEvent;
    if (e.shiftKey) return;
    e.preventDefault();
    void this.send();
  }

  protected async send(): Promise<void> {
    const threadId = this.threadId();
    const content = this.draft().trim();
    if (!threadId || !content || this.store.sending()) return;
    if (await this.store.sendMessage(this.notebookId(), threadId, content)) this.draft.set('');
  }
}
