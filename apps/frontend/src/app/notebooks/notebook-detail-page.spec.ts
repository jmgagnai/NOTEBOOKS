import { convertToParamMap, ActivatedRoute } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import { NotebookDetailPage } from './notebook-detail-page';
import { NotebooksService } from '../api/services/notebooks.service';
import { DocumentsService } from '../api/services/documents.service';
import { DocumentTransferService } from '../documents/document-transfer.service';

const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';

function activatedRouteFor(notebookId: string) {
  return {
    provide: ActivatedRoute,
    useValue: { snapshot: { paramMap: convertToParamMap({ notebookId }) } },
  };
}

// Seam-3 test (per NBK-1's testing decisions, and explicitly called for by
// NBK-5's acceptance criteria): render the real page + SignalStore, mocking
// only the generated ng-openapi-gen client interface (DocumentsService) and
// the hand-written DocumentTransferService (see its file for why it exists
// instead of a generated one) — never the store or any Angular service
// internals directly.
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
        status: 'uploaded',
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
      ],
    });

    expect(await screen.findByText('Research')).toBeTruthy();
    expect(await screen.findByText('report.txt')).toBeTruthy();
    expect(screen.getByText('uploaded')).toBeTruthy();
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
      status: 'uploaded',
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
      status: 'uploaded',
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

  it('downloads a Document Version through the transfer service', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([]);
    const existingDocument = {
      id: 'doc-4',
      notebookId: NOTEBOOK_ID,
      filename: 'sheet.xlsx',
      status: 'uploaded',
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
      ],
    });

    await screen.findByText('sheet.xlsx');
    fireEvent.click(screen.getByRole('button', { name: 'Download sheet.xlsx' }));

    expect(downloadDocumentVersion).toHaveBeenCalledWith(NOTEBOOK_ID, 'doc-4', 'v-9', 'sheet.xlsx');
  });
});
