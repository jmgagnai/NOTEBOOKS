import { Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatThread } from '../../chat/chat.store';
import { ProtoAddDocumentsButton } from './proto-add-documents-button';
import { ProtoComposer } from './proto-composer';
import { ProtoDocumentList } from './proto-document-list';
import { ProtoIcon } from './proto-icon';
import { ProtoMessageList } from './proto-message-list';
import { ProtoVariantBase } from './proto-variant-base';

/**
 * PROTOTYPE — throwaway. Variant B, "Threads navigator": three columns on a
 * grey canvas, each pane a white 8 px-cornered card. Chat Threads become a
 * first-class left navigator (the way Copilot shows chat history), the open
 * Thread sits in the middle, Documents move to the right as the grounding
 * panel. Opposite hierarchy to A: Threads first, Documents last.
 */
@Component({
  selector: 'proto-workspace-b',
  standalone: true,
  imports: [
    RouterLink,
    MatTooltipModule,
    ProtoAddDocumentsButton,
    ProtoComposer,
    ProtoDocumentList,
    ProtoIcon,
    ProtoMessageList,
  ],
  templateUrl: './workspace-variant-b.html',
  styleUrl: './workspace-variant-b.scss',
})
export class WorkspaceVariantB extends ProtoVariantBase {
  static readonly variantName = 'Threads navigator';
  /** Documents panel slid out to the right (verdict: collapsible, with a restore control). */
  protected readonly docsCollapsed = signal(false);

  protected open(t: ChatThread): void {
    void this.chat.openThread(this.notebookId(), t.id);
  }

  protected async create(): Promise<void> {
    const title = window.prompt('New Chat Thread title', 'New Chat Thread')?.trim();
    if (!title) return;
    await this.chat.createThread(this.notebookId(), title);
    const created = this.chat.threads().find((t) => t.title === title);
    if (created) void this.chat.openThread(this.notebookId(), created.id);
  }

  protected when(t: ChatThread): string {
    return new Date(t.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
}
