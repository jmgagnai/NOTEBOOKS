import { Component, computed, inject, input } from '@angular/core';
import { MatMenuModule } from '@angular/material/menu';
import { ChatStore, ChatThread } from '../../chat/chat.store';
import { ProtoIcon } from './proto-icon';

/**
 * PROTOTYPE — throwaway. The Chat Thread switcher used where a variant has no
 * room for a thread list: a text-like button naming the open Thread, opening
 * a menu of every Thread in the Notebook plus "New Chat Thread". The new
 * Thread's title comes from a `prompt()` — prototype shortcut, not a design.
 */
@Component({
  selector: 'proto-thread-menu',
  standalone: true,
  imports: [MatMenuModule, ProtoIcon],
  template: `
    <button type="button" class="ptm" [matMenuTriggerFor]="menu" aria-label="Chat Threads">
      <proto-icon name="chat" [size]="16" />
      <span class="ptm__title">{{ title() }}</span>
      <proto-icon name="chevron-down" [size]="14" />
    </button>
    <mat-menu #menu="matMenu" class="proto-menu">
      @for (t of store.threads(); track t.id) {
        <button
          mat-menu-item
          [class.ptm__active]="t.id === store.activeThreadId()"
          (click)="open(t)"
        >
          <span class="ptm__item">
            <span class="ptm__item-title">{{ t.title }}</span>
            <span class="ptm__item-sub">Started by {{ t.author.email }}</span>
          </span>
        </button>
      }
      @if (store.threads().length > 0) {
        <div class="ptm__sep"></div>
      }
      <button mat-menu-item (click)="create()">
        <span class="ptm__item ptm__item--new"
          ><proto-icon name="add" [size]="16" /> New Chat Thread</span
        >
      </button>
    </mat-menu>
  `,
  styles: `
    :host {
      display: inline-flex;
      min-width: 0;
    }
    .ptm {
      height: 32px;
      max-width: 100%;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 8px;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: #242424;
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .ptm:hover {
      background: #f0f0f0;
    }
    .ptm__title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ptm__item {
      display: flex;
      flex-direction: column;
      line-height: 1.2;
    }
    .ptm__item--new {
      flex-direction: row;
      align-items: center;
      gap: 8px;
      color: #0f6cbd;
      font-weight: 600;
    }
    .ptm__item-title {
      font-size: 14px;
    }
    .ptm__item-sub {
      font-size: 12px;
      color: #616161;
    }
    .ptm__active {
      background: #ebf3fc;
    }
    .ptm__sep {
      height: 1px;
      background: #e0e0e0;
      margin: 4px 0;
    }
  `,
})
export class ProtoThreadMenu {
  readonly notebookId = input.required<string>();
  protected readonly store = inject(ChatStore);

  protected readonly title = computed(() => {
    const active = this.store.threads().find((t) => t.id === this.store.activeThreadId());
    if (active) return active.title;
    return this.store.threads().length === 0 ? 'No Chat Threads yet' : 'Choose a Chat Thread';
  });

  protected open(t: ChatThread): void {
    void this.store.openThread(this.notebookId(), t.id);
  }

  protected async create(): Promise<void> {
    const title = window.prompt('New Chat Thread title', 'New Chat Thread')?.trim();
    if (!title) return;
    await this.store.createThread(this.notebookId(), title);
    const created = this.store.threads().find((t) => t.title === title);
    if (created) void this.store.openThread(this.notebookId(), created.id);
  }
}
