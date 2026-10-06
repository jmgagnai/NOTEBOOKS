import { convertToParamMap, ActivatedRoute } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { NotebookDetailPage } from './notebook-detail-page';
import { NotebooksService } from '../api/services/notebooks.service';
import { DocumentsService } from '../api/services/documents.service';
import { DocumentTransferService } from '../documents/document-transfer.service';
import { AppEvent, AppEventsService } from '../events/app-events.service';

const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';

function activatedRouteFor(notebookId: string) {
  return {
    provide: ActivatedRoute,
    useValue: { snapshot: { paramMap: convertToParamMap({ notebookId }) } },
  };
}

/**
 * Stands in for the real SSE connection. `AppEventsService` is mocked rather
 * than `EventSource` because it is the seam: jsdom has no `EventSource`, and
 * the page's contract is "events arrive on this stream", not "an HTTP
 * connection is opened in this particular way". That the real service turns
 * a live SSE connection into these events is proven on the backend, by
 * apps/backend/test/events.route.test.ts.
 */
function appEventsStub() {
  const events = new Subject<AppEvent>();
  const topics: string[][] = [];
  return {
    events,
    topics,
    provider: {
      provide: AppEventsService,
      useValue: {
        stream: (requested: string[]) => {
          topics.push(requested);
          return events.asObservable();
        },
      },
    },
  };
}

// Seam-3 test (per NBK-1's testing decisions, and explicitly called for by
// NBK-5's and NBK-6's acceptance criteria): render the real page +
// SignalStore, mocking only the generated ng-openapi-gen client interface
// (DocumentsService), the hand-written DocumentTransferService (see its file
// for why it exists instead of a generated one), and the SSE stream — never
// the store or any Angular service internals directly.
describe('NotebookDetailPage', () => {
  it("renders the Notebook's title and its Documents", async () => {
    const listNotebooks = vi
      .fn()
      .mockResolvedValue([{ id: NOTEBOOK_ID, title: 'Research', createdAt: '2026-01-01T00:00:00.000Z' }]);
    const listDocuments = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        notebookId: NOTEBOOK_ID,
        filename: 'report.txt',
        status: 'queued',
        createdAt: '2026-01-01T00:00:00.000Z',
        latestVersion: {
          id: 'v-1',
          versionNumber: 1,
          mimeType: 'text/plain',
          sizeBytes: 12,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);

    await render(NotebookDetailPage, {
      providers: [
        activatedRouteFor(NOTEBOOK_ID),
        { provide: NotebooksService, useValue: { listNotebooks } },
        { provide: DocumentsService, useValue: { listDocuments } },
        { provide: DocumentTransferService, useValue: {} },
        appEventsStub().provider,
      ],
    });

    expect(await screen.findByText('Research')).toBeTruthy();
    expect(await screen.findByText('report.txt')).toBeTruthy();
    expect(screen.getByText('queued')).toBeTruthy();
    expect(screen.getByText('v1')).toBeTruthy();
  });

  it('shows an empty state when there are no Documents', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([]);
    const listDocuments = vi.fn().mockResolvedValue([]);

    await render(NotebookDetailPage, {
      providers: [
        activatedRouteFor(NOTEBOOK_ID),
        { provide: NotebooksService, useValue: { listNotebooks } },
        { provide: DocumentsService, useValue: { listDocuments } },
        { provide: DocumentTransferService, useValue: {} },
        appEventsStub().provider,
      ],
    });

    expect(await screen.findByText('No Documents yet.')).toBeTruthy();
  });

  it('uploads a file through the file input', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([]);
    const listDocuments = vi.fn().mockResolvedValue([]);
    const uploadedDocument = {
      id: 'doc-2',
      notebookId: NOTEBOOK_ID,
      filename: 'notes.md',
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      latestVersion: {
        id: 'v-1',
        versionNumber: 1,
        mimeType: 'text/markdown',
        sizeBytes: 5,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const uploadDocument = vi.fn().mockResolvedValue(uploadedDocument);

    await render(NotebookDetailPage, {
      providers: [
        activatedRouteFor(NOTEBOOK_ID),
        { provide: NotebooksService, useValue: { listNotebooks } },
        { provide: DocumentsService, useValue: { listDocuments } },
        { provide: DocumentTransferService, useValue: { uploadDocument } },
        appEventsStub().provider,
      ],
    });

    await screen.findByText('No Documents yet.');

    const file = new File(['# hi'], 'notes.md', { type: 'text/markdown' });
    const input = screen.getByLabelText('Upload a Document') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText('notes.md')).toBeTruthy();
    expect(uploadDocument).toHaveBeenCalledWith(NOTEBOOK_ID, file);
  });

  it('deletes a Document, removing it from the list, then restores it via Undo', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([]);
    const existingDocument = {
      id: 'doc-3',
      notebookId: NOTEBOOK_ID,
      filename: 'contract.pdf',
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      latestVersion: {
        id: 'v-1',
        versionNumber: 1,
        mimeType: 'application/pdf',
        sizeBytes: 100,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const listDocuments = vi.fn().mockResolvedValue([existingDocument]);
    const deleteDocument = vi.fn().mockResolvedValue(null);
    const restoreDocument = vi.fn().mockResolvedValue(existingDocument);

    await render(NotebookDetailPage, {
      providers: [
        activatedRouteFor(NOTEBOOK_ID),
        { provide: NotebooksService, useValue: { listNotebooks } },
        { provide: DocumentsService, useValue: { listDocuments, deleteDocument, restoreDocument } },
        { provide: DocumentTransferService, useValue: {} },
        appEventsStub().provider,
      ],
    });

    await screen.findByText('contract.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'Delete contract.pdf' }));
    expect(deleteDocument).toHaveBeenCalledWith({ notebookId: NOTEBOOK_ID, documentId: 'doc-3' });
    await screen.findByText('No Documents yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(restoreDocument).toHaveBeenCalledWith({ notebookId: NOTEBOOK_ID, documentId: 'doc-3' });
    expect(await screen.findByText('contract.pdf')).toBeTruthy();
  });

  // NBK-6: the status badge must follow the background conversion with no
  // page refresh. Nothing is re-fetched here — the only new information is
  // the app event, which is the whole point.
  it('updates a Document status badge live from an app event', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([]);
    const listDocuments = vi.fn().mockResolvedValue([
      {
        id: 'doc-5',
        notebookId: NOTEBOOK_ID,
        filename: 'thesis.pdf',
        status: 'queued',
        createdAt: '2026-01-01T00:00:00.000Z',
        latestVersion: {
          id: 'v-7',
          versionNumber: 1,
          mimeType: 'application/pdf',
          sizeBytes: 100,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);
    const appEvents = appEventsStub();

    await render(NotebookDetailPage, {
      providers: [
        activatedRouteFor(NOTEBOOK_ID),
        { provide: NotebooksService, useValue: { listNotebooks } },
        { provide: DocumentsService, useValue: { listDocuments } },
        { provide: DocumentTransferService, useValue: {} },
        appEvents.provider,
      ],
    });

    await screen.findByText('thesis.pdf');
    expect(screen.getByText('queued')).toBeTruthy();
    // Only this Notebook's events are asked for.
    expect(appEvents.topics).toEqual([[`notebook:${NOTEBOOK_ID}`]]);

    appEvents.events.next({
      id: 'event-1',
      type: 'document-version-status-changed',
      topic: `notebook:${NOTEBOOK_ID}`,
      occurredAt: '2026-01-01T00:00:01.000Z',
      data: { documentId: 'doc-5', versionId: 'v-7', status: 'converting' },
    });
    expect(await screen.findByText('converting')).toBeTruthy();

    appEvents.events.next({
      id: 'event-2',
      type: 'document-version-status-changed',
      topic: `notebook:${NOTEBOOK_ID}`,
      occurredAt: '2026-01-01T00:00:02.000Z',
      data: { documentId: 'doc-5', versionId: 'v-7', status: 'converted' },
    });
    const badge = await screen.findByText('converted');
    // The badge is styled by outcome, so a failed conversion can't be
    // mistaken for a finished one at a glance.
    expect(badge.className).toContain('notebook-detail-page__badge--converted');
    // Nothing was re-fetched: the event alone drove the change.
    expect(listDocuments).toHaveBeenCalledTimes(1);
  });

  it('ignores a status event for a Version that is no longer the latest', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([]);
    const listDocuments = vi.fn().mockResolvedValue([
      {
        id: 'doc-6',
        notebookId: NOTEBOOK_ID,
        filename: 'superseded.txt',
        status: 'converted',
        createdAt: '2026-01-01T00:00:00.000Z',
        latestVersion: {
          id: 'v-2',
          versionNumber: 2,
          mimeType: 'text/plain',
          sizeBytes: 10,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);
    const appEvents = appEventsStub();

    await render(NotebookDetailPage, {
      providers: [
        activatedRouteFor(NOTEBOOK_ID),
        { provide: NotebooksService, useValue: { listNotebooks } },
        { provide: DocumentsService, useValue: { listDocuments } },
        { provide: DocumentTransferService, useValue: {} },
        appEvents.provider,
      ],
    });

    await screen.findByText('superseded.txt');

    // A late event about version 1, which version 2 has already replaced.
    // The badge shows the latest Version's status, so this must not move it
    // backwards.
    appEvents.events.next({
      id: 'event-3',
      type: 'document-version-status-changed',
      topic: `notebook:${NOTEBOOK_ID}`,
      occurredAt: '2026-01-01T00:00:01.000Z',
      data: { documentId: 'doc-6', versionId: 'v-1', status: 'failed' },
    });

    expect(screen.getByText('converted')).toBeTruthy();
    expect(screen.queryByText('failed')).toBeNull();
  });

  it('downloads a Document Version through the transfer service', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([]);
    const existingDocument = {
      id: 'doc-4',
      notebookId: NOTEBOOK_ID,
      filename: 'sheet.xlsx',
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      latestVersion: {
        id: 'v-9',
        versionNumber: 1,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: 100,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const listDocuments = vi.fn().mockResolvedValue([existingDocument]);
    const downloadDocumentVersion = vi.fn().mockResolvedValue(undefined);

    await render(NotebookDetailPage, {
      providers: [
        activatedRouteFor(NOTEBOOK_ID),
        { provide: NotebooksService, useValue: { listNotebooks } },
        { provide: DocumentsService, useValue: { listDocuments } },
        { provide: DocumentTransferService, useValue: { downloadDocumentVersion } },
        appEventsStub().provider,
      ],
    });

    await screen.findByText('sheet.xlsx');
    fireEvent.click(screen.getByRole('button', { name: 'Download sheet.xlsx' }));

    expect(downloadDocumentVersion).toHaveBeenCalledWith(NOTEBOOK_ID, 'doc-4', 'v-9', 'sheet.xlsx');
  });
});
