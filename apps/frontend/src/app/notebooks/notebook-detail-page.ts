import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ThreadNavigator } from '../chat/thread-navigator';
import { ThreadView } from '../chat/thread-view';
import {
  ConflictChoice,
  Document,
  DocumentsStore,
  UploadItemStatus,
} from '../documents/documents.store';
import { UPLOAD_ACCEPT } from '../documents/upload-rules';
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
 * The app's name as the browser tab shows it. Spec 06 brings the app-name
 * constant and its own title handling; until then this is the literal
 * index.html carries (NBK-35).
 */
const APP_NAME = 'RAG Notebook';

/**
 * A Notebook's workspace (NBK-5, framed in NBK-35): a slim header, then
 * three cards side by side — the Chat Threads navigator, the open Thread and
 * the Documents panel with its cards and their upload, open, delete, restore
 * and download actions. Notebooks have no dedicated `GET /notebooks/:id`
 * endpoint, so the Notebook itself (its title, for the header and the browser
 * tab) is looked up from `NotebooksStore`'s already-loaded list by route id,
 * the same list the top-level Notebooks page uses.
 *
 * Each card carries that Document's Abstract (NBK-7) — the summary
 * GLOSSARY.md writes "to be skimmed in a list" — and links to the Document
 * itself, where the Executive Summary and the full converted content live.
 *
 * While open, it also follows this Notebook's live app events (NBK-6) so a
 * Document's status badge tracks the background pipeline without a refresh.
 *
 * The chat cards (NBK-10, split in NBK-34) are the Notebook's Chat Threads
 * and the open Thread. Per NBK-1 a Notebook's detail page is "composed of a
 * sources panel ... [and] a chat panel", so the two live on one page; the
 * Thread navigator owns the chat store's loading and live stream.
 */
@Component({
  selector: 'app-notebook-detail-page',
  standalone: true,
  imports: [
    MatButtonModule,
    MatCheckboxModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    RouterLink,
    ThreadNavigator,
    ThreadView,
  ],
  templateUrl: './notebook-detail-page.html',
  styleUrl: './notebook-detail-page.scss',
  // The whole page is the drop target (NBK-18), so the drag events are
  // listened for on the host rather than on one box inside it. NBK-36 moves
  // them to the Documents panel.
  host: {
    '(dragenter)': 'onDragEnter($event)',
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'onDragLeave($event)',
    '(drop)': 'onDrop($event)',
  },
})
export class NotebookDetailPage implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly title = inject(Title);

  protected readonly notebooksStore = inject(NotebooksStore);
  protected readonly store = inject(DocumentsStore);

  protected readonly notebookId = this.route.snapshot.paramMap.get('notebookId')!;
  protected readonly notebook = computed(
    () => this.notebooksStore.notebooks().find((n) => n.id === this.notebookId) ?? null,
  );

  /**
   * The browser tab reads "<Notebook title> – <app name>" while the page is
   * open (NBK-35), so several open Notebooks are distinguishable; the title
   * found on arrival is what leaving restores. The Notebook arrives after the
   * list loads and changes on a rename, hence an effect rather than a
   * one-off in `ngOnInit`.
   */
  private readonly titleOnArrival = this.title.getTitle();

  private readonly tabTitle = effect(() => {
    const notebook = this.notebook();
    if (notebook) this.title.setTitle(`${notebook.title} – ${APP_NAME}`);
  });

  ngOnInit(): void {
    void this.notebooksStore.loadNotebooks();
    void this.store.loadDocuments(this.notebookId);
    this.store.watchNotebook(this.notebookId);
  }

  ngOnDestroy(): void {
    // The store is root-provided and outlives this page, so the live
    // connection has to be closed explicitly or it would leak across
    // navigations.
    this.store.stopWatching();
    this.title.setTitle(this.titleOnArrival);
  }

  /**
   * Renaming in place (NBK-35): the header title is a button that swaps to a
   * text box holding `titleDraft`. Page state, like the Notebooks page's own
   * rename form: nothing is sent until the draft is committed.
   */
  protected readonly renaming = signal(false);
  protected readonly titleDraft = signal('');
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');

  // The box appears on demand, so it is focused when it does — otherwise a
  // click on the title would leave the keyboard nowhere.
  private readonly focusTitleInput = effect(() => {
    this.titleInput()?.nativeElement.select();
  });

  protected startRename(): void {
    this.titleDraft.set(this.notebook()?.title ?? '');
    this.renaming.set(true);
  }

  /**
   * Enter and leaving the box both commit. Commit is a no-op once the box is
   * gone: Enter closes it, and some browsers then fire the blur of the
   * removed element, which must not rename a second time.
   */
  protected commitRename(): void {
    if (!this.renaming()) return;
    this.renaming.set(false);
    const title = this.titleDraft().trim();
    const notebook = this.notebook();
    if (!notebook || !title || title === notebook.title) return;
    void this.notebooksStore.renameNotebook(notebook.id, title);
  }

  protected cancelRename(): void {
    this.renaming.set(false);
  }

  /** The picker only offers the accepted document types (NBK-16). */
  protected readonly accept = UPLOAD_ACCEPT;

  /** The upload batch, if the one in the store belongs to this Notebook. */
  protected readonly batch = computed(() => {
    const batch = this.store.batch();
    return batch?.notebookId === this.notebookId ? batch : null;
  });

  /** The end-of-batch summary line, once nothing is waiting or in flight. */
  protected readonly batchSummaryLine = computed(() => {
    const summary = this.store.batchSummary();
    if (!summary || !this.batch() || this.store.batchRunning()) return null;
    const uploaded =
      summary.newVersions > 0
        ? `${summary.uploaded} uploaded (${summary.newVersions} as new Versions)`
        : `${summary.uploaded} uploaded`;
    return `${uploaded}, ${summary.skipped} skipped, ${summary.failed} failed`;
  });

  protected onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;
    void this.store.uploadDocuments(this.notebookId, files);
    input.value = '';
  }

  /** Re-sends every failed file of the batch (NBK-17). */
  protected retryFailed(): void {
    void this.store.retryFailed();
  }

  /** Stops the files of the batch not sent yet; in-flight ones finish (NBK-17). */
  protected cancelBatch(): void {
    this.store.cancelBatch();
  }

  /** Clears the panel once the batch is done (NBK-17). */
  protected dismissBatch(): void {
    this.store.dismissBatch();
  }

  /**
   * The conflict dialog's "apply to all remaining conflicts" tick (NBK-19).
   * Page state, not store state: it is part of the answer being composed,
   * and is sent with it.
   */
  protected readonly applyToAll = signal(false);

  /** Answers the open conflict dialog, with the tick as it stands. */
  protected answerConflict(choice: ConflictChoice): void {
    this.store.answerConflict(choice, this.applyToAll());
    this.applyToAll.set(false);
  }

  /**
   * How many elements of the page the dragged files are currently "inside"
   * (NBK-18). A drag fires `dragenter` on each element it moves over and
   * `dragleave` on the one it left, in that order, so a single boolean would
   * flicker off at every boundary; counting enters against leaves makes the
   * state hold until the drag leaves the page altogether.
   */
  private dragDepth = 0;

  /** True while files are being dragged over the page. */
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
    if (!this.carriesFiles(event) || this.refuseDrag(event)) return;
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

  /** How an item's status reads in the progress panel. */
  protected statusLabel(status: UploadItemStatus): string {
    return status === 'new-version' ? 'new version' : status;
  }

  protected delete(document: Document): void {
    void this.store.deleteDocument(this.notebookId, document.id);
  }

  protected restore(document: Document): void {
    void this.store.restoreDocument(this.notebookId, document.id);
  }

  protected download(document: Document): void {
    void this.store.downloadDocumentVersion(this.notebookId, document);
  }
}
