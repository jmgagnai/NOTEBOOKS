import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular';
import { NotebookDetailPage } from './notebook-detail-page';
import { AppEventsService } from '../events/app-events.service';
import { APP_NAME } from '../shared/brand';
import {
  NOTEBOOK_ID,
  RouterShell,
  Elsewhere,
  appEventsStub,
  pageProviders,
  documentFor,
  deferred,
  RESEARCH,
  landingTitle,
  renderWithUpload,
  typeTitle,
  fileNamed,
  pick,
  panelRow,
  documentRow,
  rowMenuItem,
  dataTransferOf,
  documentsPanel,
  elsewhereOnThePage,
  DROP_HINT,
  highlightsDocumentsPanel,
} from './notebook-detail-page.spec-helpers';
import { tooltipOf } from '../chat/chat-panel.spec-helpers';

describe('NotebookDetailPage — layout', () => {
  it("renders the Notebook's title and its Documents", async () => {
    const listNotebooks = vi
      .fn()
      .mockResolvedValue([
        { id: NOTEBOOK_ID, title: 'Research', createdAt: '2026-01-01T00:00:00.000Z' },
      ]);
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
      providers: pageProviders({
        notebooks: { listNotebooks },
        documents: { listDocuments },
      }),
    });

    expect(await landingTitle('Research')).toBeTruthy();
    expect(await screen.findByText('report.txt')).toBeTruthy();
    // One compact row (NBK-42): the type icon named for what it shows, the
    // stage as a quiet line with a progress bar while ingestion runs, and no
    // version tag for a Document that has only one Version.
    const row = documentRow('report.txt');
    expect(within(row).getByRole('img', { name: 'Text' })).toBeTruthy();
    expect(within(row).getByText('Queued')).toBeTruthy();
    expect(within(row).getByRole('progressbar')).toBeTruthy();
    expect(within(row).queryByText('v1')).toBeNull();
  });

  it('shows an empty state when there are no Documents', async () => {
    const listDocuments = vi.fn().mockResolvedValue([]);

    await render(NotebookDetailPage, {
      providers: pageProviders({
        documents: { listDocuments },
      }),
    });

    expect(await screen.findByText('No Documents yet.')).toBeTruthy();
  });

  it('uploads a file through the file input', async () => {
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
      providers: pageProviders({
        documents: { listDocuments },
        transfer: { uploadDocument },
      }),
    });

    await screen.findByText('No Documents yet.');

    const file = new File(['# hi'], 'notes.md', { type: 'text/markdown' });
    const input = screen.getByLabelText('Upload Documents') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    // The Document lands on its card, and — since NBK-16 — a single file goes
    // through the same batch panel as a multi-select, so the filename shows
    // there too.
    const cards = await screen.findByRole('list', { name: 'Documents' });
    expect(await within(cards).findByText('notes.md')).toBeTruthy();
    expect(uploadDocument).toHaveBeenCalledWith(NOTEBOOK_ID, file);
    expect(await screen.findByText('1 uploaded, 0 skipped, 0 failed')).toBeTruthy();
  });

  it('deletes a Document, removing it from the list, then restores it via Undo', async () => {
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
      providers: pageProviders({
        documents: { listDocuments, deleteDocument, restoreDocument },
      }),
    });

    await screen.findByText('contract.pdf');

    // Delete lives in the row's "…" menu (NBK-42), under its unchanged name.
    fireEvent.click(await rowMenuItem('contract.pdf', 'Delete'));
    expect(deleteDocument).toHaveBeenCalledWith({ notebookId: NOTEBOOK_ID, documentId: 'doc-3' });
    await screen.findByText('No Documents yet.');

    // The offer is a snack bar (NBK-33), which only becomes visible to
    // assistive technology once Material has announced it.
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(restoreDocument).toHaveBeenCalledWith({ notebookId: NOTEBOOK_ID, documentId: 'doc-3' });
    expect(await screen.findByText('contract.pdf')).toBeTruthy();
  });

  // NBK-33: the undo offer is a snack bar, not a line in the page, so the
  // cards no longer jump when a Document is deleted.
  it('announces a deleted Document in a snack bar instead of an inline line', async () => {
    const listDocuments = vi.fn().mockResolvedValue([documentFor('contract.pdf')]);
    const deleteDocument = vi.fn().mockResolvedValue(null);

    await render(NotebookDetailPage, {
      providers: pageProviders({
        documents: { listDocuments, deleteDocument },
      }),
    });

    await screen.findByText('contract.pdf');
    fireEvent.click(await rowMenuItem('contract.pdf', 'Delete'));

    expect(await screen.findByText('contract.pdf deleted')).toBeTruthy();
    expect(screen.queryByText(/"contract\.pdf" deleted\./)).toBeNull();
  });

  it('replaces the undo offer when a second Document is deleted', async () => {
    const listDocuments = vi
      .fn()
      .mockResolvedValue([documentFor('contract.pdf'), documentFor('report.txt')]);
    const deleteDocument = vi.fn().mockResolvedValue(null);

    await render(NotebookDetailPage, {
      providers: pageProviders({
        documents: { listDocuments, deleteDocument },
      }),
    });

    await screen.findByText('contract.pdf');
    fireEvent.click(await rowMenuItem('contract.pdf', 'Delete'));
    await screen.findByText('contract.pdf deleted');

    fireEvent.click(await rowMenuItem('report.txt', 'Delete'));

    expect(await screen.findByText('report.txt deleted')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('contract.pdf deleted')).toBeNull());
  });

  // NBK-6: the status badge must follow the background conversion with no
  // page refresh. Nothing is re-fetched here — the only new information is
  // the app event, which is the whole point.
  it('updates a Document row live from an app event', async () => {
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
      providers: pageProviders({
        documents: { listDocuments },
        appEvents,
      }),
    });

    await screen.findByText('thesis.pdf');
    expect(screen.getByText('Queued')).toBeTruthy();
    // Only this Notebook's events are asked for — by every store on the page
    // that follows the stream (Document statuses, and since NBK-11 the chat
    // panel's streamed answers). How *many* ask is not the point, and the
    // real AppEventsService shares one connection per topic set anyway.
    expect(appEvents.topics.length).toBeGreaterThan(0);
    for (const requested of appEvents.topics) {
      expect(requested).toEqual([`notebook:${NOTEBOOK_ID}`]);
    }

    appEvents.events.next({
      id: 'event-1',
      type: 'document-version-status-changed',
      topic: `notebook:${NOTEBOOK_ID}`,
      occurredAt: '2026-01-01T00:00:01.000Z',
      data: { documentId: 'doc-5', versionId: 'v-7', status: 'converting' },
    });
    expect(await screen.findByText('Converting')).toBeTruthy();

    appEvents.events.next({
      id: 'event-2',
      type: 'document-version-status-changed',
      topic: `notebook:${NOTEBOOK_ID}`,
      occurredAt: '2026-01-01T00:00:02.000Z',
      data: { documentId: 'doc-5', versionId: 'v-7', status: 'converted' },
    });
    expect(await screen.findByText('Converted')).toBeTruthy();
    // "converted" is a stage done, not the end of ingestion, so the row
    // still reads as in progress (NBK-32, NBK-42).
    expect(within(documentRow('thesis.pdf')).getByRole('progressbar')).toBeTruthy();
    // Nothing was re-fetched: the event alone drove the change.
    expect(listDocuments).toHaveBeenCalledTimes(1);
  });

  // NBK-8: ingestion ends at "ready", and NBK-1's user story is that a user
  // can "see a Document's ingestion status ... so that I know when it's safe
  // to rely on it for chat". So the badge has to reach "ready" live, and
  // "ready" has to look different from a mid-pipeline stage boundary.
  it('follows a Document through stage 3 to "ready"', async () => {
    const listDocuments = vi.fn().mockResolvedValue([
      {
        id: 'doc-9',
        notebookId: NOTEBOOK_ID,
        filename: 'report.pdf',
        status: 'summarized',
        abstract: 'An abstract.',
        createdAt: '2026-01-01T00:00:00.000Z',
        latestVersion: {
          id: 'v-9',
          versionNumber: 1,
          mimeType: 'application/pdf',
          sizeBytes: 100,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);
    const appEvents = appEventsStub();

    await render(NotebookDetailPage, {
      providers: pageProviders({
        documents: { listDocuments },
        appEvents,
      }),
    });

    await screen.findByText('report.pdf');

    appEvents.events.next({
      id: 'event-1',
      type: 'document-version-status-changed',
      topic: `notebook:${NOTEBOOK_ID}`,
      occurredAt: '2026-01-01T00:00:01.000Z',
      data: { documentId: 'doc-9', versionId: 'v-9', status: 'indexing' },
    });
    expect(await screen.findByText('Indexing')).toBeTruthy();

    appEvents.events.next({
      id: 'event-2',
      type: 'document-version-status-changed',
      topic: `notebook:${NOTEBOOK_ID}`,
      occurredAt: '2026-01-01T00:00:02.000Z',
      data: { documentId: 'doc-9', versionId: 'v-9', status: 'ready' },
    });
    // `ready` is the quiet state (NBK-42): the stage line and the progress
    // bar go, and no badge takes their place.
    await waitFor(() => expect(screen.queryByText('Indexing')).toBeNull());
    const row = documentRow('report.pdf');
    expect(within(row).queryByRole('progressbar')).toBeNull();
    expect(within(row).queryByText('Ready')).toBeNull();
    // The event alone drove it; nothing was re-fetched.
    expect(listDocuments).toHaveBeenCalledTimes(1);
  });

  it('ignores a status event for a Version that is no longer the latest', async () => {
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
      providers: pageProviders({
        documents: { listDocuments },
        appEvents,
      }),
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

    expect(screen.getByText('Converted')).toBeTruthy();
    expect(screen.queryByText('Failed')).toBeNull();
  });

  it('downloads a Document Version through the transfer service', async () => {
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
      providers: pageProviders({
        documents: { listDocuments },
        transfer: { downloadDocumentVersion },
      }),
    });

    await screen.findByText('sheet.xlsx');
    fireEvent.click(await rowMenuItem('sheet.xlsx', 'Download'));

    expect(downloadDocumentVersion).toHaveBeenCalledWith(NOTEBOOK_ID, 'doc-4', 'v-9', 'sheet.xlsx');
  });

  // NBK-18: files dragged from a file manager onto the Notebook page upload
  // as the same batch a picker selection would. jsdom has no DataTransfer or
  // DragEvent, so each drag event carries a constructed object shaped like a
  // DataTransfer: `types`, `files`, and `items` whose `webkitGetAsEntry()`
  // says whether the entry is a directory — the same thing the page reads
  // from a real drop.
  describe('NBK-18: drag and drop', () => {
    it('highlights the Documents panel, and only it, while files are dragged over the page', async () => {
      await renderWithUpload(vi.fn());
      expect(highlightsDocumentsPanel()).toBe(false);

      const dataTransfer = dataTransferOf([new File(['x'], 'a.txt')]);
      // Over the Chat card, not the panel: anywhere on the page points at the Documents panel.
      fireEvent.dragEnter(elsewhereOnThePage(), { dataTransfer });
      // `dragover` has to be cancelled or the browser refuses the drop.
      expect(fireEvent.dragOver(elsewhereOnThePage(), { dataTransfer })).toBe(false);
      expect(highlightsDocumentsPanel()).toBe(true);

      // Moving between elements of the page fires leave/enter pairs that must
      // not flicker the state off...
      fireEvent.dragEnter(documentsPanel(), { dataTransfer });
      fireEvent.dragLeave(elsewhereOnThePage(), { dataTransfer });
      expect(highlightsDocumentsPanel()).toBe(true);

      // ...while leaving the page clears it.
      fireEvent.dragLeave(documentsPanel(), { dataTransfer });
      expect(highlightsDocumentsPanel()).toBe(false);
    });

    it('does not light up for a drag that carries no files', async () => {
      await renderWithUpload(vi.fn());

      const dataTransfer = { ...dataTransferOf([]), types: ['text/plain'] };
      fireEvent.dragEnter(documentsPanel(), { dataTransfer });
      fireEvent.dragOver(documentsPanel(), { dataTransfer });
      expect(highlightsDocumentsPanel()).toBe(false);
    });

    it('uploads dropped files as the same batch the picker would start, skipping included', async () => {
      const uploadDocument = vi
        .fn()
        .mockImplementation((_notebookId: string, file: File) =>
          Promise.resolve(documentFor(file.name)),
        );
      await renderWithUpload(uploadDocument);

      const a = new File(['a'], 'a.txt');
      const b = new File(['b'], 'b.md');
      const dataTransfer = dataTransferOf([a, b, new File(['x'], 'photo.png')]);
      fireEvent.dragEnter(documentsPanel(), { dataTransfer });
      expect(screen.getByText(DROP_HINT)).toBeTruthy();
      // Cancelled, or the browser would open the dropped file instead.
      expect(fireEvent.drop(documentsPanel(), { dataTransfer })).toBe(false);
      expect(screen.queryByText(DROP_HINT)).toBeNull();

      expect(await screen.findByText('2 uploaded, 1 skipped, 0 failed')).toBeTruthy();
      expect(within(panelRow('photo.png')).getByText(/Unsupported file type/)).toBeTruthy();
      const cards = screen.getByRole('list', { name: 'Documents' });
      expect(within(cards).getByText('a.txt')).toBeTruthy();
      expect(within(cards).getByText('b.md')).toBeTruthy();
      expect(uploadDocument.mock.calls).toEqual([
        [NOTEBOOK_ID, a],
        [NOTEBOOK_ID, b],
      ]);
    });

    it('lists a dropped folder as skipped with the folder message, and uploads the files beside it', async () => {
      const uploadDocument = vi
        .fn()
        .mockImplementation((_notebookId: string, file: File) =>
          Promise.resolve(documentFor(file.name)),
        );
      await renderWithUpload(uploadDocument);

      const report = new File(['x'], 'report.txt');
      fireEvent.drop(documentsPanel(), {
        dataTransfer: dataTransferOf([{ folder: 'photos' }, report]),
      });

      expect(await screen.findByText('1 uploaded, 1 skipped, 0 failed')).toBeTruthy();
      const folder = panelRow('photos');
      expect(within(folder).getByText('Skipped')).toBeTruthy();
      expect(
        within(folder).getByText(
          "Folders can't be uploaded. Open the folder and select its files instead.",
        ),
      ).toBeTruthy();
      expect(within(panelRow('report.txt')).getByText('Uploaded')).toBeTruthy();
      expect(uploadDocument.mock.calls).toEqual([[NOTEBOOK_ID, report]]);
    });

    it('ignores a drop while a batch is running, and shows no drag-over state', async () => {
      const request = deferred<Record<string, unknown>>();
      const uploadDocument = vi.fn().mockReturnValue(request.promise);
      await renderWithUpload(uploadDocument);

      fireEvent.drop(documentsPanel(), {
        dataTransfer: dataTransferOf([new File(['x'], 'first.txt')]),
      });
      await screen.findByText('first.txt');
      expect(within(panelRow('first.txt')).getByText('Uploading')).toBeTruthy();

      // With first.txt still in flight, a second drag gets no welcome...
      const second = dataTransferOf([new File(['x'], 'second.txt')]);
      fireEvent.dragEnter(documentsPanel(), { dataTransfer: second });
      fireEvent.dragOver(documentsPanel(), { dataTransfer: second });
      expect(screen.queryByText(DROP_HINT)).toBeNull();
      // ...and its drop changes nothing: the running batch is untouched.
      fireEvent.drop(documentsPanel(), { dataTransfer: second });
      expect(screen.queryByText('second.txt')).toBeNull();
      expect(uploadDocument).toHaveBeenCalledTimes(1);

      // Once the batch is done, dropping works again.
      request.resolve(documentFor('first.txt'));
      await screen.findByText('1 uploaded, 0 skipped, 0 failed');
      fireEvent.drop(documentsPanel(), { dataTransfer: second });
      expect(await screen.findByText('second.txt')).toBeTruthy();
    });

    it('applies the 100-file cap to a drop', async () => {
      const uploadDocument = vi.fn();
      await renderWithUpload(uploadDocument);

      const files = Array.from({ length: 101 }, (_, i) => new File(['x'], `f${i}.txt`));
      fireEvent.drop(documentsPanel(), { dataTransfer: dataTransferOf(files) });

      expect(await screen.findByText(/Too many files: 101 uploadable files/)).toBeTruthy();
      expect(uploadDocument).not.toHaveBeenCalled();
    });
  });

  // NBK-35: the Notebook is a full-height workspace of panes — since NBK-79
  // the open Thread and the Documents panel, the Chat Threads having moved
  // to the app's sidebar — each a labelled landmark so a keyboard user can
  // jump between them, under a slim header that carries the way back, the
  // title and the Notebook's actions.
  describe('NBK-35: page frame', () => {
    it('lays the Notebook out as two labelled regions, with no Chat Threads column', async () => {
      await renderWithUpload(vi.fn());

      const chat = screen.getByRole('region', { name: 'Chat' });
      const documents = documentsPanel();

      expect(screen.queryByRole('navigation', { name: 'Chat Threads' })).toBeNull();
      // NBK-81: with no Chat Threads the Chat region is the Notebook landing.
      expect(within(chat).getByRole('heading', { name: 'Notebook' })).toBeTruthy();
      expect(within(chat).getByLabelText('Ask a question')).toBeTruthy();
      expect(within(documents).getByText('No Documents yet.')).toBeTruthy();
    });

    // NBK-82 (spec 07 "Notebook page frame"): no header row above the panes.
    // Its controls moved: the way back and Search to the sidebar, the title to
    // the landing, Add Documents into the Documents pane — so every control
    // the page renders sits in one of the two panes.
    it('has no header row: every control sits in the Chat region or the Documents pane', async () => {
      await renderWithUpload(vi.fn(), [], { notebook: RESEARCH });

      const chat = screen.getByRole('region', { name: 'Chat' });
      const documents = documentsPanel();
      const controls = [...screen.getAllByRole('button'), ...screen.queryAllByRole('link')];
      expect(controls.filter((c) => !chat.contains(c) && !documents.contains(c))).toEqual([]);
      expect(screen.queryByRole('button', { name: 'Back to Notebooks' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'Search this Notebook' })).toBeNull();
    });

    it('renames the Notebook from its title on Enter', async () => {
      const renameNotebook = vi.fn().mockResolvedValue({ ...RESEARCH, title: 'Research 2026' });
      await renderWithUpload(vi.fn(), [], { notebook: RESEARCH, renameNotebook });

      fireEvent.keyDown(await typeTitle('Research 2026'), { key: 'Enter' });

      expect(renameNotebook).toHaveBeenCalledWith({
        id: NOTEBOOK_ID,
        body: { title: 'Research 2026' },
      });
      expect(await landingTitle('Research 2026')).toBeTruthy();
      expect(screen.queryByLabelText('Notebook title')).toBeNull();
      // NBK-61: the browser tab follows the rename.
      expect(document.title).toBe(`Research 2026 – ${APP_NAME}`);
    });

    // Spec 05 story 3: "Create Notebook" names the Notebook "Untitled
    // Notebook" and lands here, so the title it just made up is ready to type
    // over. The Notebooks page says so in the navigation's state.
    it('opens the title for editing when the navigation asks for it', async () => {
      await render(RouterShell, {
        routes: [{ path: 'notebooks/:notebookId', component: NotebookDetailPage }],
        providers: pageProviders({
          notebooks: { listNotebooks: vi.fn().mockResolvedValue([RESEARCH]) },
          documents: { listDocuments: vi.fn().mockResolvedValue([]) },
          inRouterShell: true,
        }),
      });

      await TestBed.inject(Router).navigate(['/notebooks', NOTEBOOK_ID], {
        state: { editTitle: true },
      });

      // On the Notebook landing (NBK-82: the page header that held it is gone).
      const box = (await within(elsewhereOnThePage()).findByLabelText(
        'Notebook title',
      )) as HTMLInputElement;
      expect(box.value).toBe('Research');
      expect(document.activeElement).toBe(box);
    });

    it('commits the rename when the title box loses focus', async () => {
      const renameNotebook = vi.fn().mockResolvedValue({ ...RESEARCH, title: 'Archive' });
      await renderWithUpload(vi.fn(), [], { notebook: RESEARCH, renameNotebook });

      fireEvent.blur(await typeTitle('Archive'));

      expect(renameNotebook).toHaveBeenCalledWith({ id: NOTEBOOK_ID, body: { title: 'Archive' } });
      expect(await landingTitle('Archive')).toBeTruthy();
    });

    it('discards the edit on Escape and sends nothing', async () => {
      const renameNotebook = vi.fn();
      await renderWithUpload(vi.fn(), [], { notebook: RESEARCH, renameNotebook });

      fireEvent.keyDown(await typeTitle('Mistake'), { key: 'Escape' });

      expect(renameNotebook).not.toHaveBeenCalled();
      expect(await landingTitle('Research')).toBeTruthy();
      expect(screen.queryByLabelText('Notebook title')).toBeNull();
    });

    // NBK-82: at the top of the Documents pane, the header's old place gone.
    it('"Add Documents" opens the picker, and is disabled with it while a batch runs', async () => {
      const request = deferred<Record<string, unknown>>();
      await renderWithUpload(vi.fn().mockReturnValue(request.promise));
      const input = screen.getByLabelText('Upload Documents') as HTMLInputElement;
      const open = vi.spyOn(input, 'click');

      fireEvent.click(within(documentsPanel()).getByRole('button', { name: 'Add Documents' }));
      expect(open).toHaveBeenCalledTimes(1);

      pick([fileNamed('a.txt')]);
      await screen.findByText('a.txt');
      expect(
        (screen.getByRole('button', { name: 'Add Documents' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(input.disabled).toBe(true);

      request.resolve(documentFor('a.txt'));
      await screen.findByText('1 uploaded, 0 skipped, 0 failed');
      expect(
        (screen.getByRole('button', { name: 'Add Documents' }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    // NBK-61: leaving puts back the default, not whatever the tab said on
    // arrival — hence a stale title to start from.
    it('puts the Notebook title in the browser tab while open, and the default back on leaving', async () => {
      document.title = 'A stale title';
      const listNotebooks = vi.fn().mockResolvedValue([RESEARCH]);
      const listDocuments = vi.fn().mockResolvedValue([]);
      const { navigate } = await render(RouterShell, {
        routes: [
          { path: 'notebooks/:notebookId', component: NotebookDetailPage },
          { path: 'elsewhere', component: Elsewhere },
        ],
        providers: pageProviders({
          notebooks: { listNotebooks },
          documents: { listDocuments },
          inRouterShell: true,
        }),
      });

      await navigate(`/notebooks/${NOTEBOOK_ID}`);
      await waitFor(() => expect(document.title).toBe(`Research – ${APP_NAME}`));

      await navigate('/elsewhere');
      await screen.findByText('Somewhere else');
      expect(document.title).toBe(APP_NAME);
    });
  });

  // NBK-37: a user reading answers can hide the Documents panel and get it
  // back from the top of the Chat pane (NBK-82; the page header until then).
  // Hidden means gone for assistive technology and the keyboard too, not just
  // out of sight, so the tests ask the accessibility tree (role queries skip
  // hidden content) rather than styles.
  describe('NBK-37: hiding the Documents panel', () => {
    const THREE = [documentFor('a.txt'), documentFor('b.txt'), documentFor('c.txt')];

    function hideDocumentsButton() {
      return within(documentsPanel()).getByRole('button', { name: 'Hide Documents' });
    }

    function showDocumentsButton() {
      return within(elsewhereOnThePage()).queryByRole('button', { name: 'Show Documents' });
    }

    it('offers "Hide Documents" in the panel and no "Show Documents" while the panel is visible', async () => {
      await renderWithUpload(vi.fn(), THREE);

      expect(hideDocumentsButton()).toBeTruthy();
      expect(showDocumentsButton()).toBeNull();
    });

    it('"Hide Documents" hides the panel and offers "Show Documents" in the Chat pane, the count in its tooltip', async () => {
      await renderWithUpload(vi.fn(), THREE);

      fireEvent.click(hideDocumentsButton());

      expect(screen.queryByRole('complementary', { name: 'Documents' })).toBeNull();
      expect(screen.queryByRole('list', { name: 'Documents' })).toBeNull();
      // Only the panel goes: the reader hid it to make room for the Thread.
      expect(screen.getByRole('region', { name: 'Chat' })).toBeTruthy();
      const show = showDocumentsButton()!;
      expect(show).toBeTruthy();
      expect(await tooltipOf(show)).toBe('Show Documents (3)');
    });

    it('"Show Documents" restores the panel, goes away, and focuses "Hide Documents"', async () => {
      await renderWithUpload(vi.fn(), THREE);
      fireEvent.click(hideDocumentsButton());

      fireEvent.click(showDocumentsButton()!);

      expect(documentsPanel()).toBeTruthy();
      expect(
        within(screen.getByRole('list', { name: 'Documents' })).getByText('a.txt'),
      ).toBeTruthy();
      expect(showDocumentsButton()).toBeNull();
      // The keyboard has somewhere to be: the control that undoes what it just did.
      await waitFor(() => expect(document.activeElement).toBe(hideDocumentsButton()));
    });

    it('a drag carrying files while hidden brings the panel back as the drop target', async () => {
      const uploadDocument = vi
        .fn()
        .mockImplementation((_notebookId: string, file: File) =>
          Promise.resolve(documentFor(file.name)),
        );
      await renderWithUpload(uploadDocument);
      fireEvent.click(hideDocumentsButton());
      expect(screen.queryByRole('complementary', { name: 'Documents' })).toBeNull();

      const report = new File(['x'], 'report.txt');
      const dataTransfer = dataTransferOf([report]);
      fireEvent.dragEnter(elsewhereOnThePage(), { dataTransfer });

      expect(highlightsDocumentsPanel()).toBe(true);
      expect(showDocumentsButton()).toBeNull();
      // ...and the drop then behaves as it always did.
      fireEvent.drop(documentsPanel(), { dataTransfer });
      expect(await screen.findByText('1 uploaded, 0 skipped, 0 failed')).toBeTruthy();
      expect(uploadDocument).toHaveBeenCalledWith(NOTEBOOK_ID, report);
    });
  });
});
