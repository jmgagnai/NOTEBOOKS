import { Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ProtoAddDocumentsButton } from './proto-add-documents-button';
import { ProtoComposer } from './proto-composer';
import { ProtoDocumentList } from './proto-document-list';
import { ProtoIcon } from './proto-icon';
import { ProtoMessageList } from './proto-message-list';
import { ProtoThreadMenu } from './proto-thread-menu';
import { ProtoVariantBase } from './proto-variant-base';

/**
 * PROTOTYPE — throwaway. Variant A, "Side by side": spec 02 as written. A
 * 44 px header, then a `320px 1fr` grid — Documents pane left (collapsible
 * to a 48 px rail), Chat pane right with the composer pinned to its bottom.
 * Panes are full-bleed white surfaces separated by 1 px borders.
 */
@Component({
  selector: 'proto-workspace-a',
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
  templateUrl: './workspace-variant-a.html',
  styleUrl: './workspace-variant-a.scss',
})
export class WorkspaceVariantA extends ProtoVariantBase {
  static readonly variantName = 'Side by side';
  protected readonly collapsed = signal(false);
}
