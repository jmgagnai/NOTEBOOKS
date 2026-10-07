import { Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ProtoAddDocumentsButton } from './proto-add-documents-button';
import { ProtoComposer } from './proto-composer';
import { ProtoDocumentList } from './proto-document-list';
import { ProtoIcon } from './proto-icon';
import { ProtoMessageList } from './proto-message-list';
import { ProtoThreadMenu } from './proto-thread-menu';
import { ProtoVariantBase } from './proto-variant-base';

/** Static client-side prompts (spec 00: no LLM-generated suggestions). */
const SUGGESTIONS = [
  'Summarize what these Documents have in common',
  'What are the key dates and deadlines mentioned?',
  'List the open questions these Documents leave unanswered',
];

/**
 * PROTOTYPE — throwaway. Variant C, "Chat-first canvas": no side panes at
 * all. One centred 760 px column — the open Thread above, a large composer
 * below — with the Documents reduced to a chip strip over the composer
 * ("Grounded in N Documents") and their management moved to a slide-over
 * sheet. The composer is the page; Documents are context, not a pane.
 */
@Component({
  selector: 'proto-workspace-c',
  standalone: true,
  imports: [
    RouterLink,
    MatTooltipModule,
    ProtoAddDocumentsButton,
    ProtoComposer,
    ProtoDocumentList,
    ProtoIcon,
    ProtoMessageList,
    ProtoThreadMenu,
  ],
  templateUrl: './workspace-variant-c.html',
  styleUrl: './workspace-variant-c.scss',
})
export class WorkspaceVariantC extends ProtoVariantBase {
  static readonly variantName = 'Chat-first canvas';
  protected readonly sheetOpen = signal(false);
  protected readonly suggestions = SUGGESTIONS;

  protected readonly chips = computed(() => this.documentsStore.documents().slice(0, 4));
  protected readonly overflow = computed(() => Math.max(0, this.documentCount() - 4));
  protected readonly showHero = computed(
    () =>
      this.chat.messages().length === 0 &&
      !this.chat.streamingAnswer() &&
      !this.chat.messagesLoading(),
  );

  protected kind(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return ['pdf', 'docx', 'xlsx', 'csv'].includes(ext)
      ? ext
      : ext === 'md' || ext === 'markdown'
        ? 'md'
        : 'txt';
  }
}
