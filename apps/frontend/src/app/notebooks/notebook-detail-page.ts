import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  OnDestroy,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatStore } from '../chat/chat.store';
import { ThreadView } from '../chat/thread-view';
import { DocumentFilter } from '../documents/document-filter';
import { DocumentList, isInProgress } from '../documents/document-list';
import { DocumentsEmptyState } from '../documents/documents-empty-state';
import { Document, DocumentsStore } from '../documents/documents.store';
import { UploadBatchPanel } from '../documents/upload-batch-panel';
import { UPLOAD_ACCEPT } from '../documents/upload-rules';
import { EditableTitle } from '../shared/editable-title';
import { showPageTitle } from '../shared/page-title';
import { UndoSnackBar } from '../shared/undo-snack-bar';
import { NotebooksStore } from './notebooks.store';

/**
 * What a drop carried (NBK-18): every entry as a File, in drop order, and
 * which of those Files are really folders.
 *
 * A file manager hands a directory over like any file — a File with the
 * folder's name, no type and (usually) no size — so `dataTransfer.files`
 * alone cannot tell the two apart, and a size-0 typeless *file* is a
 * perfectly good upload. What does tell them apart is the entry behind each
 * `DataTransferItem`: `webkitGetAsEntry()` returns a FileSystemEntry whose
 * `isDirectory` is the answer. The folder keeps its File so it can be listed
 * in the batch under its own name. A browser without `webkitGetAsEntry`
 * (none current) simply has everything treated as a file, and the backend
 * refuses the folder's typeless File as unsupported.
 */
function droppedEntries(dataTransfer: DataTransfer | null): {
  files: File[];
  folders: Set<File>;
} {
  const files: File[] = [];
  const folders = new Set<File>();
  const items = Array.from(dataTransfer?.items ?? []);
  if (items.length === 0) {
    return { files: Array.from(dataTransfer?.files ?? []), folders };
  }
  items.forEach((item, index) => {
    if (item.kind !== 'file') return;
    const entry = item.webkitGetAsEntry?.();
    // `getAsFile()` and `files[index]` are the same File in a real drop;
    // the second is a fallback for a DataTransfer that only filled one. An
    // item that yields neither has nothing to upload and nothing to list —
    // current browsers always back a directory entry with a File, so a
    // placeholder File for that case would be code no drop exercises.
    const file = item.getAsFile() ?? dataTransfer?.files?.[index];
    if (!file) return;
    files.push(file);
    if (entry?.isDirectory) folders.add(file);
  });
  return { files, folders };
}

/**
 * A Notebook's workspace (NBK-5, framed in NBK-35): a slim header, then
 * two panes side by side — the open Thread and the Documents panel with its rows (`DocumentList`, NBK-42) and their
 * upload, open, delete, restore and download actions. Notebooks have no
 * dedicated `GET /notebooks/:id` endpoint, so the Notebook itself (its
 * title, for the header and the browser tab) is looked up from
 * `NotebooksStore`'s already-loaded list by route id, the same list the
 * top-level Notebooks page uses.
 *
 * Each row links to the Document itself, where the Abstract (NBK-7), the
 * Executive Summary and the full converted content live.
 *
 * While open, it also follows this Notebook's live app events (NBK-6) so a
 * Document's row tracks the background pipeline without a refresh.
 *
 * The chat pane (NBK-10, split in NBK-34) is the open Thread. Per NBK-1 a
 * Notebook's detail page is "composed of a sources panel ... [and] a chat
 * panel", so the two live on one page. The Chat Threads navigator sits in
 * the app's sidebar since NBK-79, but this page owns the chat store's
 * lifecycle (see `ngOnInit`).
 */
@Component({
  selector: 'app-notebook-detail-page',
  standalone: true,
  imports: [
    EditableTitle,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    DocumentFilter,
    DocumentList,
    DocumentsEmptyState,
    RouterLink,
    ThreadView,
    UploadBatchPanel,
  ],
  templateUrl: './notebook-detail-page.html',
  styleUrl: './notebook-detail-page.scss',
  // Files dropped anywhere on the page land in this Notebook (NBK-18), so
  // the drag events are listened for on the host rather than on one box
  // inside it; what lights up is the Documents panel (NBK-36), driven by
  // `dragOver`.
  host: {
    '(dragenter)': 'onDragEnter($event)',
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'onDragLeave($event)',
    '(drop)': 'onDrop($event)',
  },
})
export class NotebookDetailPage implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);

  protected readonly notebooksStore = inject(NotebooksStore);
  protected readonly store = inject(DocumentsStore);
  private readonly chatStore = inject(ChatStore);
  private readonly undoSnackBar = inject(UndoSnackBar);

  protected readonly notebookId = this.route.snapshot.paramMap.get('notebookId')!;
  protected readonly notebook = computed(
    () => this.notebooksStore.notebooks().find((n) => n.id === this.notebookId) ?? null,
  );

  // The browser tab names the Notebook (NBK-35, NBK-61) so several open
  // Notebooks are distinguishable; it follows a rename.
  private readonly tabTitle = showPageTitle(() => this.notebook()?.title);

  ngOnInit(): void {
    void this.notebooksStore.loadNotebooks();
    void this.store.loadDocuments(this.notebookId);
    this.store.watchNotebook(this.notebookId);
    // The Chat Threads (which opens the most recent one, see
    // `ChatStore.loadThreads`) and the live stream their answers arrive on —
    // the same one the Document status badges follow (NBK-6), so no second
    // connection is opened. The page's job rather than the navigator's
    // (spec 07, NBK-79): the navigator now sits in the sidebar, which drops
    // it when collapsed, and that must not reset the open Thread.
    void this.chatStore.loadThreads(this.notebookId);
    this.chatStore.watchNotebook(this.notebookId);
  }

  ngOnDestroy(): void {
    // The stores are root-provided and outlive this page, so the live
    // connections have to be closed explicitly or they would leak across
    // navigations; `reset` also clears the open Chat Thread, which would
    // otherwise show up on the next Notebook opened.
    this.store.stopWatching();
    this.chatStore.reset();
  }

  /**
   * Whether the navigation here asked for the title to open for editing:
   * "Create Notebook" does (spec 05 story 3), because the title it gave the
   * new Notebook is a placeholder. Read while the router is still
   * activating this page, the only moment the navigation's state is at hand.
   */
  private editTitleOnArrival =
    inject(Router).currentNavigation()?.extras.state?.['editTitle'] === true;

  private readonly headerTitle = viewChild(EditableTitle);

  // Once the Notebook has loaded and the header has rendered its title, so
  // the box opens on the real title rather than the "Notebook" placeholder;
  // once only, so a later rename or list reload does not reopen it.
  private readonly openTitleOnArrival = effect(() => {
    const header = this.headerTitle();
    if (!this.editTitleOnArrival || !header || !this.notebook()) return;
    this.editTitleOnArrival = false;
    afterNextRender(() => header.edit(), { injector: this.injector });
  });

  /**
   * Renaming in place (NBK-35): the header title is an `app-editable-title`
   * (NBK-41), which only hands over a title that differs from the current
   * one, so nothing is sent for a click-and-click-away.
   */
  protected rename(title: string): void {
    const notebook = this.notebook();
    if (!notebook) return;
    void this.notebooksStore.renameNotebook(notebook.id, title);
  }

  /**
   * Whether the Documents panel is hidden (NBK-37), so the Thread takes its
   * width while the user reads answers. Component state on purpose: the spec
   * wants a reload to show the panel again, so nothing is persisted. The
   * panel stays in the DOM — hidden by the grid collapsing its column, and
   * made unreachable with `inert` and `aria-hidden` — so showing it again is
   * a slide back in rather than a re-render of the Document list.
   */
  protected readonly documentsHidden = signal(false);

  private readonly injector = inject(Injector);
  private readonly hideDocumentsButton = viewChild('hideDocumentsButton', { read: ElementRef });

  protected hideDocuments(): void {
    this.documentsHidden.set(true);
  }

  /**
   * Restores the panel and hands focus to its hide control: "Show Documents"
   * is gone from the header the moment the panel is back, so the keyboard
   * would otherwise land on the body. The focus waits for the render that
   * removes `inert` — a focus call on an inert element is silently ignored.
   */
  protected showDocuments(): void {
    this.documentsHidden.set(false);
    afterNextRender(() => this.hideDocumentsButton()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  /**
   * The panel header's count (NBK-48): "23/25 ready" while some Document is
   * still ingesting, else "25 Documents". A failed Document does not hold the
   * in-progress form: it is not on its way to ready, and its row already
   * carries the warning. It follows the store, so App Events move it without
   * a refetch.
   */
  protected readonly documentCount = computed(() => {
    const documents = this.store.documents();
    if (documents.some((d) => isInProgress(d.status))) {
      const ready = documents.filter((d) => d.status === 'ready').length;
      return `${ready}/${documents.length} ready`;
    }
    return documents.length === 1 ? '1 Document' : `${documents.length} Documents`;
  });

  /** What the user typed in "Filter Documents" (NBK-48). */
  protected readonly documentFilter = signal('');

  /**
   * The filter box is only rendered while there are Documents, so once the
   * last one goes its text would linger out of sight and hide the next
   * upload behind "No Documents match". Forgetting it with the list keeps
   * what is filtered always on screen.
   */
  private readonly forgetFilterWhenEmpty = effect(() => {
    if (this.store.documents().length === 0) this.documentFilter.set('');
  });

  /**
   * The rows the panel lists (NBK-48): the store's Documents whose filename
   * contains the filter text, ignoring case. Client-side on purpose — the
   * list is already here, and the API's search is semantic, which is "Search
   * this Notebook", not this. Surrounding blanks are ignored so a stray
   * space does not empty the list.
   */
  protected readonly filteredDocuments = computed(() => {
    const documents = this.store.documents();
    const text = this.documentFilter().trim().toLocaleLowerCase();
    if (!text) return documents;
    return documents.filter((d) => d.filename.toLocaleLowerCase().includes(text));
  });

  /** The picker only offers the accepted document types (NBK-16). */
  protected readonly accept = UPLOAD_ACCEPT;

  protected onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;
    void this.store.uploadDocuments(this.notebookId, files);
    input.value = '';
  }

  /**
   * How many elements of the page the dragged files are currently "inside"
   * (NBK-18). A drag fires `dragenter` on each element it moves over and
   * `dragleave` on the one it left, in that order, so a single boolean would
   * flicker off at every boundary; counting enters against leaves makes the
   * state hold until the drag leaves the page altogether.
   */
  private dragDepth = 0;

  /** True while files are being dragged over the page; the Documents panel shows it (NBK-36). */
  protected readonly dragOver = signal(false);

  /** Whether a drag carries files at all — text or links dragged over the page are not a drop. */
  private carriesFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }

  /**
   * Whether the page takes a drop right now. It does not while a batch is
   * running: a second batch is not queued behind the first (spec, out of
   * scope), so the honest thing is to refuse it visibly. Leaving `dragenter`
   * and `dragover` uncancelled is how a page tells the browser that — the
   * cursor shows "not allowed" and no `drop` is fired.
   */
  private refuseDrag(event: DragEvent): boolean {
    if (!this.store.batchRunning()) return false;
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    return true;
  }

  protected onDragEnter(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    // The drop target must never be missing (NBK-37): files dragged in while
    // the panel is hidden bring it back, whether or not the drop is welcome.
    this.documentsHidden.set(false);
    if (this.refuseDrag(event)) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.dragOver.set(true);
  }

  protected onDragOver(event: DragEvent): void {
    if (!this.carriesFiles(event) || this.refuseDrag(event)) return;
    // Cancelling `dragover` is what tells the browser the drop is allowed.
    event.preventDefault();
  }

  protected onDragLeave(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dragOver.set(false);
  }

  /**
   * A drop goes through the same `uploadDocuments` as the picker, so the
   * skipping rules and the cap apply unchanged (NBK-18).
   */
  protected onDrop(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    // Cancelled, or the browser would navigate to the dropped file.
    event.preventDefault();
    this.dragDepth = 0;
    this.dragOver.set(false);
    // Normally unreachable while a batch runs, since `dragover` was not
    // cancelled; guarded anyway so nothing else on the page can let it in.
    if (this.store.batchRunning()) return;
    const { files, folders } = droppedEntries(event.dataTransfer);
    if (files.length === 0) return;
    void this.store.uploadDocuments(this.notebookId, files, { folders });
  }

  protected async delete(document: Document): Promise<void> {
    await this.store.deleteDocument(this.notebookId, document.id);
    // `lastDeleted` holding this Document is the store's own signal that the
    // delete went through; a failure leaves it as it was and sets `error`.
    const deleted = this.store.lastDeleted();
    if (deleted?.id !== document.id) return;
    this.undoSnackBar.open(deleted.filename, () => this.restore(deleted));
  }

  protected restore(document: Document): void {
    void this.store.restoreDocument(this.notebookId, document.id);
  }

  protected download(document: Document): void {
    void this.store.downloadDocumentVersion(this.notebookId, document);
  }
}
