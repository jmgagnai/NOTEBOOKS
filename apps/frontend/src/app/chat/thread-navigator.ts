import {
  afterNextRender,
  Component,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '../auth/auth.store';
import { ChatStore, ChatThread, NEW_THREAD_TITLE } from './chat.store';
import { DeleteThreadDialog, type DeleteThreadDialogData } from './delete-thread-dialog';
import { EditableTitle } from '../shared/editable-title';
import { ShortDatePipe } from '../shared/short-date.pipe';

/**
 * The Chat Threads navigator of a Notebook (NBK-10, split out in NBK-34,
 * redesigned as a list in NBK-43): every Thread in the Notebook, the open one
 * marked, and the one control that starts a new one.
 *
 * Per GLOSSARY.md and ADR-0001 the list is every Thread in the Notebook, not
 * this user's — so each entry names its author. That attribution is the only
 * thing author identity is used for here: nothing is hidden or disabled
 * because someone else started it.
 *
 * It only reads the root-provided ChatStore and acts on it: loading the
 * Threads, the live stream and resetting on the way out are the Notebook
 * page's (NBK-79). The navigator moved into the app's sidebar, which drops
 * it while collapsed and shows it only on the Notebook page — had it kept
 * the lifecycle it owned since NBK-34, collapsing the sidebar would reset
 * the store and close the open Thread under the reader. It relies on
 * nothing but the shared store, so it does not care where it is placed.
 */
@Component({
  selector: 'app-thread-navigator',
  standalone: true,
  imports: [
    EditableTitle,
    ShortDatePipe,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './thread-navigator.html',
  styleUrl: './thread-navigator.scss',
})
export class ThreadNavigator {
  readonly notebookId = input.required<string>();

  protected readonly store = inject(ChatStore);

  private readonly auth = inject(AuthStore);

  private readonly dialog = inject(MatDialog);

  private readonly injector = inject(Injector);

  /**
   * The Chat Thread whose row is being renamed in place (NBK-115), by
   * double-click, F2 or its "⋯" menu — the way a Notebook row is (NBK-56).
   * Open to anyone, like the title above the conversation (ADR-0001).
   */
  protected readonly renamingId = signal<string | null>(null);

  // The row's text box opens as soon as it appears: the double-click, F2 or
  // menu item was the activation. Untracked, so the Threads list re-binding
  // the title (a rename landing, an App Event) cannot reopen the box and
  // throw away what is being typed.
  private readonly renamingTitle = viewChild(EditableTitle);
  private readonly openRenameBox = effect(() => {
    const title = this.renamingTitle();
    if (title) untracked(() => title.edit());
  });

  private readonly rowButtons = viewChildren<ElementRef<HTMLElement>>('rowButton');

  protected newThread(): void {
    void this.store.createThread(this.notebookId(), NEW_THREAD_TITLE);
  }

  protected openThread(thread: ChatThread): void {
    // Not a reload: the row of the open Thread is marked, not disabled, so a
    // click on it has to be harmless — re-fetching would blank the messages
    // for a moment and drop an answer streaming into them.
    if (this.isOpen(thread)) return;
    void this.store.openThread(this.notebookId(), thread.id);
  }

  protected startRename(thread: ChatThread): void {
    this.renamingId.set(thread.id);
  }

  protected rename(thread: ChatThread, title: string): void {
    void this.store.renameThread(this.notebookId(), thread.id, title);
  }

  /**
   * Enter and Escape take the focused box away, so the focus goes back to
   * the row it came from; a box left for another control leaves it there.
   */
  protected closeRename(thread: ChatThread, refocus: boolean): void {
    this.renamingId.set(null);
    if (!refocus) return;
    afterNextRender(
      () =>
        this.rowButtons()
          .find((row) => row.nativeElement.dataset['threadId'] === thread.id)
          ?.nativeElement.focus(),
      { injector: this.injector },
    );
  }

  protected isOpen(thread: ChatThread): boolean {
    return thread.id === this.store.activeThreadId();
  }

  /**
   * Whether the signed-in user started this Thread: only its author may
   * delete it (NBK-95, ADR-0001 amendment), so only their rows' "⋯" menu
   * offers Delete. The server refuses anyone else too.
   */
  protected isMine(thread: ChatThread): boolean {
    return thread.author.id === this.auth.user()?.id;
  }

  /** Asks first — there is no Undo — and deletes on confirmation. */
  protected async deleteThread(thread: ChatThread): Promise<void> {
    const confirmed = await firstValueFrom(
      this.dialog
        .open<DeleteThreadDialog, DeleteThreadDialogData, boolean>(DeleteThreadDialog, {
          data: { title: thread.title },
          autoFocus: 'dialog',
        })
        .afterClosed(),
    );
    if (confirmed) await this.store.deleteThread(this.notebookId(), thread.id);
  }
}
