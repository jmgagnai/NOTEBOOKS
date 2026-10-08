import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { StatusBadge } from '../shared/status-badge';
import { ConflictChoice, DocumentsStore } from './documents.store';

/**
 * The upload batch block of the Documents panel (NBK-16, NBK-17, NBK-19;
 * compacted and extracted from the Notebook page in NBK-50, spec 03 "Batch
 * panel"): one row per file with its status badge, the summary once the
 * batch is done, the controls that steer it, and the conflict question for a
 * file whose name is an existing Document.
 *
 * It reads the root `DocumentsStore` directly rather than taking the batch as
 * an input: the batch, its summary and the open conflict are one state
 * machine the store owns, and the page has nothing to add to it but which
 * Notebook it is showing. Renders nothing when the store's batch belongs to
 * another Notebook or there is none.
 */
@Component({
  selector: 'app-upload-batch-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatCheckboxModule, MatProgressSpinnerModule, StatusBadge],
  templateUrl: './upload-batch-panel.html',
  styleUrl: './upload-batch-panel.scss',
})
export class UploadBatchPanel {
  protected readonly store = inject(DocumentsStore);

  /** The Notebook the panel is shown in; a batch for another one is not shown. */
  readonly notebookId = input.required<string>();

  /** The upload batch, if the one in the store belongs to this Notebook. */
  protected readonly batch = computed(() => {
    const batch = this.store.batch();
    return batch?.notebookId === this.notebookId() ? batch : null;
  });

  /** The end-of-batch summary line, once nothing is waiting or in flight. */
  protected readonly summaryLine = computed(() => {
    const summary = this.store.batchSummary();
    if (!summary || !this.batch() || this.store.batchRunning()) return null;
    const uploaded =
      summary.newVersions > 0
        ? `${summary.uploaded} uploaded (${summary.newVersions} as new Versions)`
        : `${summary.uploaded} uploaded`;
    return `${uploaded}, ${summary.skipped} skipped, ${summary.failed} failed`;
  });

  /** Re-sends every failed file of the batch (NBK-17). */
  protected retryFailed(): void {
    void this.store.retryFailed();
  }

  /** Stops the files of the batch not sent yet; in-flight ones finish (NBK-17). */
  protected cancel(): void {
    this.store.cancelBatch();
  }

  /** Clears the panel once the batch is done (NBK-17). */
  protected dismiss(): void {
    this.store.dismissBatch();
  }

  /**
   * The conflict question's "apply to all remaining conflicts" tick (NBK-19).
   * Component state, not store state: it is part of the answer being
   * composed, and is sent with it.
   */
  protected readonly applyToAll = signal(false);

  /** Answers the open conflict question, with the tick as it stands. */
  protected answerConflict(choice: ConflictChoice): void {
    this.store.answerConflict(choice, this.applyToAll());
    this.applyToAll.set(false);
  }
}
