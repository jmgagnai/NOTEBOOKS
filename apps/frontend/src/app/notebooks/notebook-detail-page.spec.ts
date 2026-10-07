import { convertToParamMap, ActivatedRoute } from '@angular/router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { NotebookDetailPage } from './notebook-detail-page';
import { NotebooksService } from '../api/services/notebooks.service';
import { ChatService } from '../api/services/chat.service';
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
 * Stands in for the generated chat client (NBK-10). The page embeds the chat
 * panel, so rendering it reaches `ChatService`; what the panel does with it
 * is covered by its own seam-3 test (chat-panel.spec.ts), so here it only
 * has to not fail.
 */
function chatServiceStub() {
  return {
    provide: ChatService,
    useValue: { listChatThreads: vi.fn().mockResolvedValue([]) },
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
      providers: [
        activatedRouteFor(NOTEBOOK_ID),
        { provide: NotebooksService, useValue: { listNotebooks } },
        { provide: DocumentsService, useValue: { listDocuments } },
        chatServiceStub(),
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
        chatServiceStub(),
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
        chatServiceStub(),
        { provide: DocumentTransferService, useValue: { uploadDocument } },
        appEventsStub().provider,
      ],
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

  // NBK-16: several files picked at once upload as one batch — one request per
  // file to the existing single-file route, at most 3 in flight, with a
  // per-file progress panel and a summary. The batch lives in the
  // root-provided store, but the only things asserted here are what a user
  // sees and the calls the mocked upload client receives.
  describe('NBK-16: batch upload', () => {
    function documentFor(filename: string, overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: `doc-${filename}`,
        notebookId: NOTEBOOK_ID,
        filename,
        status: 'queued',
        abstract: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        latestVersion: {
          id: `v-${filename}-1`,
          versionNumber: 1,
          mimeType: 'text/plain',
          sizeBytes: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        ...overrides,
      };
    }

    /** A promise the test resolves or rejects by hand, to hold a request "in flight". */
    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    async function renderWithUpload(
      uploadDocument: ReturnType<typeof vi.fn>,
      existing: Record<string, unknown>[] = [],
    ) {
      const listNotebooks = vi.fn().mockResolvedValue([]);
      const listDocuments = vi.fn().mockResolvedValue(existing);
      await render(NotebookDetailPage, {
        providers: [
          activatedRouteFor(NOTEBOOK_ID),
          { provide: NotebooksService, useValue: { listNotebooks } },
          { provide: DocumentsService, useValue: { listDocuments } },
          chatServiceStub(),
          { provide: DocumentTransferService, useValue: { uploadDocument } },
          appEventsStub().provider,
        ],
      });
      if (existing.length === 0) await screen.findByText('No Documents yet.');
      else await screen.findByText(String(existing[0]['filename']));
    }

    function pick(files: File[]) {
      const input = screen.getByLabelText('Upload Documents') as HTMLInputElement;
      fireEvent.change(input, { target: { files } });
      return input;
    }

    function panelRow(filename: string) {
      const panel = screen.getByRole('list', { name: 'Upload progress' });
      return within(panel)
        .getAllByRole('listitem')
        .find((row) => within(row).queryByText(filename) !== null)!;
    }

    it('accepts several files at once and sends one request per file', async () => {
      const uploadDocument = vi
        .fn()
        .mockImplementation((_notebookId: string, file: File) =>
          Promise.resolve(documentFor(file.name)),
        );
      await renderWithUpload(uploadDocument);

      const input = pick([new File(['a'], 'a.txt'), new File(['b'], 'b.md')]);
      expect(input.multiple).toBe(true);
      // The picker only offers what the backend accepts — the one list the
      // frontend keeps for it.
      expect(input.accept).toBe('.txt,.md,.markdown,.docx,.xlsx,.csv,.pdf');

      const cards = await screen.findByRole('list', { name: 'Documents' });
      expect(await within(cards).findByText('a.txt')).toBeTruthy();
      expect(await within(cards).findByText('b.md')).toBeTruthy();
      expect(uploadDocument).toHaveBeenCalledTimes(2);
      expect(uploadDocument.mock.calls.map(([, file]) => (file as File).name)).toEqual([
        'a.txt',
        'b.md',
      ]);
    });

    it('keeps at most 3 requests in flight, taking files in selection order', async () => {
      const inFlight: ReturnType<typeof deferred<Record<string, unknown>>>[] = [];
      const uploadDocument = vi.fn().mockImplementation(() => {
        const request = deferred<Record<string, unknown>>();
        inFlight.push(request);
        return request.promise;
      });
      await renderWithUpload(uploadDocument);

      const files = ['1.txt', '2.txt', '3.txt', '4.txt', '5.txt'].map(
        (name) => new File(['x'], name),
      );
      pick(files);

      const sentNames = () => uploadDocument.mock.calls.map(([, file]) => (file as File).name);
      await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(3));
      expect(sentNames()).toEqual(['1.txt', '2.txt', '3.txt']);

      // Nothing more goes out until a slot frees up...
      await screen.findByText('5.txt');
      expect(uploadDocument).toHaveBeenCalledTimes(3);

      // ...and when one does, the next file in selection order takes it.
      inFlight[1].resolve(documentFor('2.txt'));
      await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(4));
      expect(sentNames()[3]).toBe('4.txt');

      inFlight[0].resolve(documentFor('1.txt'));
      await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(5));
      expect(sentNames()[4]).toBe('5.txt');

      for (const [index, request] of inFlight.slice(2).entries()) {
        request.resolve(documentFor(`${index + 3}.txt`));
      }
      expect(await screen.findByText('5 uploaded, 0 skipped, 0 failed')).toBeTruthy();
      expect(uploadDocument).toHaveBeenCalledTimes(5);
    });

    it('shows each file moving from waiting to uploading to uploaded', async () => {
      const inFlight: ReturnType<typeof deferred<Record<string, unknown>>>[] = [];
      const uploadDocument = vi.fn().mockImplementation(() => {
        const request = deferred<Record<string, unknown>>();
        inFlight.push(request);
        return request.promise;
      });
      await renderWithUpload(uploadDocument);

      pick(['1.txt', '2.txt', '3.txt', '4.txt'].map((name) => new File(['x'], name)));

      await screen.findByText('4.txt');
      expect(within(panelRow('1.txt')).getByText('uploading')).toBeTruthy();
      expect(within(panelRow('4.txt')).getByText('waiting')).toBeTruthy();
      // No summary while files are still moving.
      expect(screen.queryByText(/uploaded, .* skipped, .* failed/)).toBeNull();

      inFlight[0].resolve(documentFor('1.txt'));
      expect(await within(panelRow('1.txt')).findByText('uploaded')).toBeTruthy();
      expect(await within(panelRow('4.txt')).findByText('uploading')).toBeTruthy();
    });

    // Filtering happens in the browser before anything is sent, so a stray
    // file never costs a request and never blocks the others.
    it('skips unsupported files with a reason, and explains .xls specifically', async () => {
      const uploadDocument = vi
        .fn()
        .mockImplementation((_notebookId: string, file: File) =>
          Promise.resolve(documentFor(file.name)),
        );
      await renderWithUpload(uploadDocument);

      pick([
        new File(['x'], 'photo.png'),
        new File(['x'], 'legacy.xls'),
        new File(['x'], 'fine.pdf'),
      ]);

      expect(await screen.findByText('1 uploaded, 2 skipped, 0 failed')).toBeTruthy();
      const photo = panelRow('photo.png');
      expect(within(photo).getByText('skipped')).toBeTruthy();
      expect(
        within(photo).getByText(
          'Unsupported file type. Accepted types: text, Markdown, DOCX, Excel (.xlsx), CSV, and PDF.',
        ),
      ).toBeTruthy();
      const legacy = panelRow('legacy.xls');
      expect(within(legacy).getByText('skipped')).toBeTruthy();
      expect(within(legacy).getByText(/Re-save it as \.xlsx/)).toBeTruthy();
      expect(uploadDocument).toHaveBeenCalledTimes(1);
      expect((uploadDocument.mock.calls[0][1] as File).name).toBe('fine.pdf');
    });

    it('skips a file over 50 MiB before sending anything, naming the limit', async () => {
      const uploadDocument = vi
        .fn()
        .mockImplementation((_notebookId: string, file: File) =>
          Promise.resolve(documentFor(file.name)),
        );
      await renderWithUpload(uploadDocument);

      const huge = new File([''], 'huge.pdf');
      Object.defineProperty(huge, 'size', { value: 50 * 1024 * 1024 + 1 });
      const atLimit = new File([''], 'at-limit.pdf');
      Object.defineProperty(atLimit, 'size', { value: 50 * 1024 * 1024 });
      pick([huge, atLimit]);

      expect(await screen.findByText('1 uploaded, 1 skipped, 0 failed')).toBeTruthy();
      expect(within(panelRow('huge.pdf')).getByText(/50 MiB/)).toBeTruthy();
      expect(within(panelRow('at-limit.pdf')).getByText('uploaded')).toBeTruthy();
      expect(uploadDocument).toHaveBeenCalledTimes(1);
      expect((uploadDocument.mock.calls[0][1] as File).name).toBe('at-limit.pdf');
    });

    it('skips a later file whose name repeats an earlier one in the same selection', async () => {
      const uploadDocument = vi
        .fn()
        .mockImplementation((_notebookId: string, file: File) =>
          Promise.resolve(documentFor(file.name)),
        );
      await renderWithUpload(uploadDocument);

      const first = new File(['first'], 'notes.md');
      const second = new File(['second'], 'notes.md');
      pick([first, second]);

      expect(await screen.findByText('1 uploaded, 1 skipped, 0 failed')).toBeTruthy();
      const rows = within(screen.getByRole('list', { name: 'Upload progress' })).getAllByRole(
        'listitem',
      );
      expect(within(rows[0]).getByText('uploaded')).toBeTruthy();
      expect(within(rows[1]).getByText('skipped')).toBeTruthy();
      expect(within(rows[1]).getByText(/duplicate/i)).toBeTruthy();
      // The first one wins.
      expect(uploadDocument).toHaveBeenCalledTimes(1);
      expect(uploadDocument).toHaveBeenCalledWith(NOTEBOOK_ID, first);
    });

    it('refuses a selection of more than 100 uploadable files, naming the cap and the count', async () => {
      const uploadDocument = vi.fn();
      await renderWithUpload(uploadDocument);

      // Skipped files do not count toward the cap, so this is 101 uploadable
      // files plus one that would be skipped anyway.
      const files = Array.from({ length: 101 }, (_, i) => new File(['x'], `f${i}.txt`));
      files.push(new File(['x'], 'photo.png'));
      pick(files);

      expect(
        await screen.findByText(
          'Too many files: 101 uploadable files selected, but one upload takes at most 100. Split the selection and try again.',
        ),
      ).toBeTruthy();
      expect(uploadDocument).not.toHaveBeenCalled();
      expect(screen.queryByRole('list', { name: 'Upload progress' })).toBeNull();
    });

    it('marks a failed request as failed with its reason and counts it in the summary', async () => {
      const uploadDocument = vi
        .fn()
        .mockImplementation((_notebookId: string, file: File) =>
          file.name === 'bad.txt'
            ? Promise.reject({ error: { message: 'Storage is unavailable.' } })
            : Promise.resolve(documentFor(file.name)),
        );
      await renderWithUpload(uploadDocument);

      pick([new File(['x'], 'good.txt'), new File(['x'], 'bad.txt')]);

      expect(await screen.findByText('1 uploaded, 0 skipped, 1 failed')).toBeTruthy();
      const bad = panelRow('bad.txt');
      expect(within(bad).getByText('failed')).toBeTruthy();
      expect(within(bad).getByText('Storage is unavailable.')).toBeTruthy();
      // The failure stays in the panel; it does not replace the Document list
      // with an error banner, and the other file still landed.
      const cards = screen.getByRole('list', { name: 'Documents' });
      expect(within(cards).getByText('good.txt')).toBeTruthy();
      expect(within(cards).queryByText('bad.txt')).toBeNull();
    });

    it('lands a re-uploaded filename as a new Version, replacing its card and counted in the summary', async () => {
      const existing = documentFor('report.txt', { id: 'doc-existing' });
      const uploadDocument = vi.fn().mockImplementation((_notebookId: string, file: File) =>
        Promise.resolve(
          file.name === 'report.txt'
            ? documentFor('report.txt', {
                id: 'doc-existing',
                latestVersion: { ...existing.latestVersion, id: 'v-report-2', versionNumber: 2 },
              })
            : documentFor(file.name),
        ),
      );
      await renderWithUpload(uploadDocument, [existing]);

      pick([new File(['x'], 'report.txt'), new File(['x'], 'fresh.txt')]);

      // Since NBK-19 the existing name is a question first; answering New
      // Version is what lands it as one.
      const dialog = await screen.findByRole('dialog', { name: 'Document already exists' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'New Version' }));

      expect(
        await screen.findByText('2 uploaded (1 as new Versions), 0 skipped, 0 failed'),
      ).toBeTruthy();
      expect(within(panelRow('report.txt')).getByText('new version')).toBeTruthy();
      expect(within(panelRow('fresh.txt')).getByText('uploaded')).toBeTruthy();

      const cards = screen.getByRole('list', { name: 'Documents' });
      // One card for report.txt, now at v2 — not a duplicate.
      expect(within(cards).getAllByText('report.txt')).toHaveLength(1);
      expect(within(cards).getByText('v2')).toBeTruthy();
      expect(within(cards).getByText('fresh.txt')).toBeTruthy();
    });
  });

  // NBK-18: files dragged from a file manager onto the Notebook page upload
  // as the same batch a picker selection would. jsdom has no DataTransfer or
  // DragEvent, so each drag event carries a constructed object shaped like a
  // DataTransfer: `types`, `files`, and `items` whose `webkitGetAsEntry()`
  // says whether the entry is a directory — the same thing the page reads
  // from a real drop.
  describe('NBK-18: drag and drop', () => {
    function documentFor(filename: string) {
      return {
        id: `doc-${filename}`,
        notebookId: NOTEBOOK_ID,
        filename,
        status: 'queued',
        abstract: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        latestVersion: {
          id: `v-${filename}-1`,
          versionNumber: 1,
          mimeType: 'text/plain',
          sizeBytes: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      };
    }

    async function renderWithUpload(uploadDocument: ReturnType<typeof vi.fn>) {
      const listNotebooks = vi.fn().mockResolvedValue([]);
      const listDocuments = vi.fn().mockResolvedValue([]);
      await render(NotebookDetailPage, {
        providers: [
          activatedRouteFor(NOTEBOOK_ID),
          { provide: NotebooksService, useValue: { listNotebooks } },
          { provide: DocumentsService, useValue: { listDocuments } },
          chatServiceStub(),
          { provide: DocumentTransferService, useValue: { uploadDocument } },
          appEventsStub().provider,
        ],
      });
      await screen.findByText('No Documents yet.');
    }

    /** A dropped folder: what a file manager hands over for a directory. */
    interface Folder {
      folder: string;
    }

    /**
     * A DataTransfer as a drop of `entries` would carry it. A folder arrives
     * as an item whose entry `isDirectory`, backed by a size-0 File named
     * after it — which is what Chromium and Firefox actually put in `files`.
     */
    function dataTransferOf(entries: (File | Folder)[]) {
      const files = entries.map((entry) =>
        entry instanceof File ? entry : new File([], entry.folder),
      );
      return {
        types: ['Files'],
        files,
        items: entries.map((entry, index) => ({
          kind: 'file',
          type: files[index].type,
          getAsFile: () => files[index],
          webkitGetAsEntry: () => ({
            name: files[index].name,
            isFile: entry instanceof File,
            isDirectory: !(entry instanceof File),
          }),
        })),
        dropEffect: 'none',
        effectAllowed: 'all',
      };
    }

    function panelRow(filename: string) {
      const panel = screen.getByRole('list', { name: 'Upload progress' });
      return within(panel)
        .getAllByRole('listitem')
        .find((row) => within(row).queryByText(filename) !== null)!;
    }

    /** A promise the test resolves by hand, to hold a request "in flight". */
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    /** Somewhere inside the page; drag events bubble up to the page itself. */
    function somewhereOnThePage() {
      return screen.getByRole('heading', { name: 'Documents' });
    }

    const DROP_HINT = 'Drop files to upload them into this Notebook';

    it('highlights the whole page while files are dragged over it, until they leave', async () => {
      await renderWithUpload(vi.fn());
      expect(screen.queryByText(DROP_HINT)).toBeNull();

      const dataTransfer = dataTransferOf([new File(['x'], 'a.txt')]);
      fireEvent.dragEnter(somewhereOnThePage(), { dataTransfer });
      // `dragover` has to be cancelled or the browser refuses the drop.
      expect(fireEvent.dragOver(somewhereOnThePage(), { dataTransfer })).toBe(false);
      expect(screen.getByText(DROP_HINT)).toBeTruthy();

      // Moving between elements of the page fires leave/enter pairs that must
      // not flicker the state off...
      fireEvent.dragEnter(screen.getByRole('heading', { name: 'Chat' }), { dataTransfer });
      fireEvent.dragLeave(somewhereOnThePage(), { dataTransfer });
      expect(screen.getByText(DROP_HINT)).toBeTruthy();

      // ...while leaving the page clears it.
      fireEvent.dragLeave(screen.getByRole('heading', { name: 'Chat' }), { dataTransfer });
      expect(screen.queryByText(DROP_HINT)).toBeNull();
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
      fireEvent.dragEnter(somewhereOnThePage(), { dataTransfer });
      expect(screen.getByText(DROP_HINT)).toBeTruthy();
      // Cancelled, or the browser would open the dropped file instead.
      expect(fireEvent.drop(somewhereOnThePage(), { dataTransfer })).toBe(false);
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
      fireEvent.drop(somewhereOnThePage(), {
        dataTransfer: dataTransferOf([{ folder: 'photos' }, report]),
      });

      expect(await screen.findByText('1 uploaded, 1 skipped, 0 failed')).toBeTruthy();
      const folder = panelRow('photos');
      expect(within(folder).getByText('skipped')).toBeTruthy();
      expect(
        within(folder).getByText(
          "Folders can't be uploaded. Open the folder and select its files instead.",
        ),
      ).toBeTruthy();
      expect(within(panelRow('report.txt')).getByText('uploaded')).toBeTruthy();
      expect(uploadDocument.mock.calls).toEqual([[NOTEBOOK_ID, report]]);
    });

    it('ignores a drop while a batch is running, and shows no drag-over state', async () => {
      const request = deferred<Record<string, unknown>>();
      const uploadDocument = vi.fn().mockReturnValue(request.promise);
      await renderWithUpload(uploadDocument);

      fireEvent.drop(somewhereOnThePage(), {
        dataTransfer: dataTransferOf([new File(['x'], 'first.txt')]),
      });
      await screen.findByText('first.txt');
      expect(within(panelRow('first.txt')).getByText('uploading')).toBeTruthy();

      // With first.txt still in flight, a second drag gets no welcome...
      const second = dataTransferOf([new File(['x'], 'second.txt')]);
      fireEvent.dragEnter(somewhereOnThePage(), { dataTransfer: second });
      fireEvent.dragOver(somewhereOnThePage(), { dataTransfer: second });
      expect(screen.queryByText(DROP_HINT)).toBeNull();
      // ...and its drop changes nothing: the running batch is untouched.
      fireEvent.drop(somewhereOnThePage(), { dataTransfer: second });
      expect(screen.queryByText('second.txt')).toBeNull();
      expect(uploadDocument).toHaveBeenCalledTimes(1);

      // Once the batch is done, dropping works again.
      request.resolve(documentFor('first.txt'));
      await screen.findByText('1 uploaded, 0 skipped, 0 failed');
      fireEvent.drop(somewhereOnThePage(), { dataTransfer: second });
      expect(await screen.findByText('second.txt')).toBeTruthy();
    });

    it('applies the 100-file cap to a drop', async () => {
      const uploadDocument = vi.fn();
      await renderWithUpload(uploadDocument);

      const files = Array.from({ length: 101 }, (_, i) => new File(['x'], `f${i}.txt`));
      fireEvent.drop(somewhereOnThePage(), { dataTransfer: dataTransferOf(files) });

      expect(await screen.findByText(/Too many files: 101 uploadable files/)).toBeTruthy();
      expect(uploadDocument).not.toHaveBeenCalled();
    });
  });

  // NBK-19: before a file silently becomes a new Version of an existing
  // Document, the user is asked. The conflict is detected in the browser,
  // against the Document list the page already holds; the dialog offers New
  // Version or Skip, one file at a time, while the other files keep going.
  describe('NBK-19: conflict dialog', () => {
    function documentFor(filename: string, overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: `doc-${filename}`,
        notebookId: NOTEBOOK_ID,
        filename,
        status: 'queued',
        abstract: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        latestVersion: {
          id: `v-${filename}-1`,
          versionNumber: 1,
          mimeType: 'text/plain',
          sizeBytes: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        ...overrides,
      };
    }

    /** What the backend returns for a re-upload: the same Document, one Version up. */
    function newVersionOf(existing: ReturnType<typeof documentFor>) {
      return {
        ...existing,
        latestVersion: {
          ...existing.latestVersion,
          id: `${existing.latestVersion.id}-next`,
          versionNumber: existing.latestVersion.versionNumber + 1,
        },
      };
    }

    /** A promise the test resolves by hand, to hold a request "in flight". */
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    async function renderWithUpload(
      uploadDocument: ReturnType<typeof vi.fn>,
      existing: Record<string, unknown>[] = [],
    ) {
      const listNotebooks = vi.fn().mockResolvedValue([]);
      const listDocuments = vi.fn().mockResolvedValue(existing);
      await render(NotebookDetailPage, {
        providers: [
          activatedRouteFor(NOTEBOOK_ID),
          { provide: NotebooksService, useValue: { listNotebooks } },
          { provide: DocumentsService, useValue: { listDocuments } },
          chatServiceStub(),
          { provide: DocumentTransferService, useValue: { uploadDocument } },
          appEventsStub().provider,
        ],
      });
      if (existing.length === 0) await screen.findByText('No Documents yet.');
      else await screen.findByText(String(existing[0]['filename']));
    }

    function pick(files: File[]) {
      const input = screen.getByLabelText('Upload Documents') as HTMLInputElement;
      fireEvent.change(input, { target: { files } });
    }

    function panelRow(filename: string) {
      const panel = screen.getByRole('list', { name: 'Upload progress' });
      return within(panel)
        .getAllByRole('listitem')
        .find((row) => within(row).queryByText(filename) !== null)!;
    }

    const dialog = () => screen.queryByRole('dialog', { name: 'Document already exists' });
    const findDialog = () => screen.findByRole('dialog', { name: 'Document already exists' });
    const findDialogSync = () => screen.getByRole('dialog', { name: 'Document already exists' });
    const sentNames = (uploadDocument: ReturnType<typeof vi.fn>) =>
      uploadDocument.mock.calls.map(([, file]) => (file as File).name);

    it('asks before sending a file whose name is an existing Document, and sends it on New Version', async () => {
      const existing = documentFor('report.txt');
      const uploadDocument = vi.fn().mockResolvedValue(newVersionOf(existing));
      await renderWithUpload(uploadDocument, [existing]);

      pick([new File(['x'], 'report.txt')]);

      const open = await findDialog();
      expect(within(open).getByText(/"report\.txt" already exists in this Notebook/)).toBeTruthy();
      expect(within(open).getByRole('button', { name: 'New Version' })).toBeTruthy();
      expect(within(open).getByRole('button', { name: 'Skip' })).toBeTruthy();
      expect(
        within(open).getByRole('checkbox', { name: 'Apply to all remaining conflicts' }),
      ).toBeTruthy();
      // Nothing is sent until the user answers.
      expect(uploadDocument).not.toHaveBeenCalled();
      expect(within(panelRow('report.txt')).getByText('waiting')).toBeTruthy();

      fireEvent.click(within(open).getByRole('button', { name: 'New Version' }));

      expect(
        await screen.findByText('1 uploaded (1 as new Versions), 0 skipped, 0 failed'),
      ).toBeTruthy();
      expect(dialog()).toBeNull();
      expect(uploadDocument).toHaveBeenCalledTimes(1);
      expect(within(panelRow('report.txt')).getByText('new version')).toBeTruthy();
      // The card is replaced, not duplicated.
      const cards = screen.getByRole('list', { name: 'Documents' });
      expect(within(cards).getAllByText('report.txt')).toHaveLength(1);
      expect(within(cards).getByText('v2')).toBeTruthy();
    });

    it('lists the file as skipped, with the reason, on Skip — and never sends it', async () => {
      const existing = documentFor('report.txt');
      const uploadDocument = vi
        .fn()
        .mockImplementation((_notebookId: string, file: File) =>
          Promise.resolve(documentFor(file.name)),
        );
      await renderWithUpload(uploadDocument, [existing]);

      pick([new File(['x'], 'report.txt'), new File(['x'], 'fresh.txt')]);

      const open = await findDialog();
      fireEvent.click(within(open).getByRole('button', { name: 'Skip' }));

      expect(await screen.findByText('1 uploaded, 1 skipped, 0 failed')).toBeTruthy();
      expect(dialog()).toBeNull();
      const row = panelRow('report.txt');
      expect(within(row).getByText('skipped')).toBeTruthy();
      expect(within(row).getByText(/name already exists/i)).toBeTruthy();
      expect(sentNames(uploadDocument)).toEqual(['fresh.txt']);
      // The existing Document is untouched: still one card, no v2 anywhere.
      const cards = screen.getByRole('list', { name: 'Documents' });
      expect(within(cards).getAllByText('report.txt')).toHaveLength(1);
      expect(within(cards).queryByText('v2')).toBeNull();
    });

    it('applies one answer to every later conflict of the batch when "apply to all" is ticked', async () => {
      const existing = ['a.txt', 'b.txt', 'c.txt'].map((name) => documentFor(name));
      const uploadDocument = vi
        .fn()
        .mockImplementation((_notebookId: string, file: File) =>
          Promise.resolve(documentFor(file.name)),
        );
      await renderWithUpload(uploadDocument, existing);

      pick(['a.txt', 'fresh.txt', 'b.txt', 'c.txt'].map((name) => new File(['x'], name)));

      // The first conflict is asked about...
      const open = await findDialog();
      expect(within(open).getByText(/"a\.txt" already exists/)).toBeTruthy();
      fireEvent.click(
        within(open).getByRole('checkbox', { name: 'Apply to all remaining conflicts' }),
      );
      fireEvent.click(within(open).getByRole('button', { name: 'Skip' }));

      // ...and the other two are settled the same way, with no second dialog.
      expect(await screen.findByText('1 uploaded, 3 skipped, 0 failed')).toBeTruthy();
      expect(dialog()).toBeNull();
      for (const name of ['a.txt', 'b.txt', 'c.txt']) {
        expect(within(panelRow(name)).getByText('skipped')).toBeTruthy();
        expect(within(panelRow(name)).getByText(/name already exists/i)).toBeTruthy();
      }
      expect(sentNames(uploadDocument)).toEqual(['fresh.txt']);
    });

    it('applies New Version to every later conflict when "apply to all" is ticked', async () => {
      const existing = ['a.txt', 'b.txt'].map((name) => documentFor(name));
      const uploadDocument = vi
        .fn()
        .mockImplementation((_notebookId: string, file: File) =>
          Promise.resolve(newVersionOf(existing.find((d) => d.filename === file.name)!)),
        );
      await renderWithUpload(uploadDocument, existing);

      pick(['a.txt', 'b.txt'].map((name) => new File(['x'], name)));

      const open = await findDialog();
      fireEvent.click(
        within(open).getByRole('checkbox', { name: 'Apply to all remaining conflicts' }),
      );
      fireEvent.click(within(open).getByRole('button', { name: 'New Version' }));

      expect(
        await screen.findByText('2 uploaded (2 as new Versions), 0 skipped, 0 failed'),
      ).toBeTruthy();
      expect(sentNames(uploadDocument)).toEqual(['a.txt', 'b.txt']);
      const cards = screen.getByRole('list', { name: 'Documents' });
      expect(within(cards).getAllByText('v2')).toHaveLength(2);
    });

    it('keeps 3 non-conflicting files in flight while a dialog is open, and shows one dialog at a time', async () => {
      const existing = ['a.txt', 'b.txt'].map((name) => documentFor(name));
      const inFlight = new Map<string, ReturnType<typeof deferred<Record<string, unknown>>>>();
      const uploadDocument = vi.fn().mockImplementation((_notebookId: string, file: File) => {
        const request = deferred<Record<string, unknown>>();
        inFlight.set(file.name, request);
        return request.promise;
      });
      await renderWithUpload(uploadDocument, existing);

      // Two conflicts first in selection order, then four plain files.
      pick(
        ['a.txt', 'b.txt', '1.txt', '2.txt', '3.txt', '4.txt'].map((name) => new File(['x'], name)),
      );

      // The dialog is about the first conflict only, and while it is open
      // the plain files fill all 3 slots — the two files awaiting an answer
      // hold none.
      const first = await findDialog();
      expect(within(first).getByText(/"a\.txt" already exists/)).toBeTruthy();
      expect(within(first).queryByText(/b\.txt/)).toBeNull();
      await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(3));
      expect(sentNames(uploadDocument)).toEqual(['1.txt', '2.txt', '3.txt']);
      expect(screen.getAllByRole('dialog')).toHaveLength(1);

      // A slot freeing up goes to the next plain file, not to a file still
      // waiting on its dialog.
      inFlight.get('2.txt')!.resolve(documentFor('2.txt'));
      await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(4));
      expect(sentNames(uploadDocument)[3]).toBe('4.txt');
      expect(dialog()).toBe(first);

      // Answering the first conflict brings up the second — still one dialog.
      fireEvent.click(within(first).getByRole('button', { name: 'New Version' }));
      await waitFor(() =>
        expect(within(findDialogSync()).getByText(/"b\.txt" already exists/)).toBeTruthy(),
      );
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      // a.txt is now sendable, but every slot is taken; it goes out once one
      // frees up.
      expect(uploadDocument).toHaveBeenCalledTimes(4);
      inFlight.get('1.txt')!.resolve(documentFor('1.txt'));
      await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(5));
      expect(sentNames(uploadDocument)[4]).toBe('a.txt');

      fireEvent.click(within(findDialogSync()).getByRole('button', { name: 'Skip' }));
      await waitFor(() => expect(dialog()).toBeNull());
      inFlight.get('a.txt')!.resolve(newVersionOf(existing[0]));
      for (const name of ['3.txt', '4.txt']) inFlight.get(name)!.resolve(documentFor(name));

      expect(
        await screen.findByText('5 uploaded (1 as new Versions), 1 skipped, 0 failed'),
      ).toBeTruthy();
      expect(uploadDocument).toHaveBeenCalledTimes(5);
    });

    // A soft-deleted Document is not in the list the page holds (`GET
    // .../documents` never returns one), so a name only it had is no
    // conflict: the file goes straight out and lands as a new Document.
    it('uploads a file whose name matches only a deleted Document without asking', async () => {
      const uploadDocument = vi
        .fn()
        .mockImplementation((_notebookId: string, file: File) =>
          Promise.resolve(documentFor(file.name)),
        );
      await renderWithUpload(uploadDocument, [documentFor('kept.txt')]);

      pick([new File(['x'], 'deleted-earlier.txt')]);

      expect(await screen.findByText('1 uploaded, 0 skipped, 0 failed')).toBeTruthy();
      expect(dialog()).toBeNull();
      expect(sentNames(uploadDocument)).toEqual(['deleted-earlier.txt']);
      expect(within(panelRow('deleted-earlier.txt')).getByText('uploaded')).toBeTruthy();
    });

    it('asks the same question for a single-file upload', async () => {
      const existing = documentFor('only.txt');
      const uploadDocument = vi.fn().mockResolvedValue(newVersionOf(existing));
      await renderWithUpload(uploadDocument, [existing]);

      pick([new File(['x'], 'only.txt')]);

      const open = await findDialog();
      expect(within(open).getByText(/"only\.txt" already exists/)).toBeTruthy();
      expect(uploadDocument).not.toHaveBeenCalled();
      fireEvent.click(within(open).getByRole('button', { name: 'Skip' }));

      expect(await screen.findByText('0 uploaded, 1 skipped, 0 failed')).toBeTruthy();
      expect(uploadDocument).not.toHaveBeenCalled();
    });
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
        chatServiceStub(),
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
        chatServiceStub(),
        { provide: DocumentTransferService, useValue: {} },
        appEvents.provider,
      ],
    });

    await screen.findByText('thesis.pdf');
    expect(screen.getByText('queued')).toBeTruthy();
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

  // NBK-8: ingestion ends at "ready", and NBK-1's user story is that a user
  // can "see a Document's ingestion status ... so that I know when it's safe
  // to rely on it for chat". So the badge has to reach "ready" live, and
  // "ready" has to look different from a mid-pipeline stage boundary.
  it('follows a Document through stage 3 to the "ready" badge', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([]);
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
      providers: [
        activatedRouteFor(NOTEBOOK_ID),
        { provide: NotebooksService, useValue: { listNotebooks } },
        { provide: DocumentsService, useValue: { listDocuments } },
        chatServiceStub(),
        { provide: DocumentTransferService, useValue: {} },
        appEvents.provider,
      ],
    });

    await screen.findByText('report.pdf');

    appEvents.events.next({
      id: 'event-1',
      type: 'document-version-status-changed',
      topic: `notebook:${NOTEBOOK_ID}`,
      occurredAt: '2026-01-01T00:00:01.000Z',
      data: { documentId: 'doc-9', versionId: 'v-9', status: 'indexing' },
    });
    expect(await screen.findByText('indexing')).toBeTruthy();

    appEvents.events.next({
      id: 'event-2',
      type: 'document-version-status-changed',
      topic: `notebook:${NOTEBOOK_ID}`,
      occurredAt: '2026-01-01T00:00:02.000Z',
      data: { documentId: 'doc-9', versionId: 'v-9', status: 'ready' },
    });
    const badge = await screen.findByText('ready');
    expect(badge.className).toContain('notebook-detail-page__badge--ready');
    // The event alone drove it; nothing was re-fetched.
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
        chatServiceStub(),
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

  // NBK-7: "Document cards show the Abstract". Per GLOSSARY.md the Abstract
  // is the 50-100 word artifact "used in search results, search-result
  // previews, and document cards" — so this is the one summary that belongs
  // in a list, and it has to be visible without opening anything.
  describe('NBK-7: the Abstract on a Document card', () => {
    function summarizedDocument(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: 'doc-7',
        notebookId: NOTEBOOK_ID,
        filename: 'quarterly.pdf',
        status: 'summarized',
        abstract:
          'A quarterly report covering revenue growth and supply-chain risk across three regions.',
        createdAt: '2026-01-01T00:00:00.000Z',
        latestVersion: {
          id: 'v-11',
          versionNumber: 1,
          mimeType: 'application/pdf',
          sizeBytes: 100,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        ...overrides,
      };
    }

    it("shows the Abstract on the Document's card, and links to the Document", async () => {
      const listNotebooks = vi.fn().mockResolvedValue([]);
      const listDocuments = vi.fn().mockResolvedValue([summarizedDocument()]);

      await render(NotebookDetailPage, {
        providers: [
          activatedRouteFor(NOTEBOOK_ID),
          { provide: NotebooksService, useValue: { listNotebooks } },
          { provide: DocumentsService, useValue: { listDocuments } },
          chatServiceStub(),
          { provide: DocumentTransferService, useValue: {} },
          appEventsStub().provider,
        ],
      });

      expect(await screen.findByText('quarterly.pdf')).toBeTruthy();
      expect(
        screen.getByText(
          'A quarterly report covering revenue growth and supply-chain risk across three regions.',
        ),
      ).toBeTruthy();

      // Opening the Document is where the Executive Summary lives, so the
      // card has to get the user there.
      const open = screen.getByRole('link', { name: 'Open quarterly.pdf' });
      expect(open.getAttribute('href')).toBe(`/notebooks/${NOTEBOOK_ID}/documents/doc-7`);
    });

    it('says the Abstract is still being generated while ingestion has not produced one', async () => {
      const listNotebooks = vi.fn().mockResolvedValue([]);
      const listDocuments = vi
        .fn()
        .mockResolvedValue([summarizedDocument({ status: 'converting', abstract: null })]);

      await render(NotebookDetailPage, {
        providers: [
          activatedRouteFor(NOTEBOOK_ID),
          { provide: NotebooksService, useValue: { listNotebooks } },
          { provide: DocumentsService, useValue: { listDocuments } },
          chatServiceStub(),
          { provide: DocumentTransferService, useValue: {} },
          appEventsStub().provider,
        ],
      });

      await screen.findByText('quarterly.pdf');
      // An empty card would read as "this document says nothing"; the status
      // badge alone doesn't explain the missing summary.
      expect(screen.getByText('Abstract not generated yet.')).toBeTruthy();
    });

    // The pipeline now has a second stage, so the badge has two more states
    // to show. And because an app event carries only *what changed* — per
    // ADR-0004 it has to stay well inside Postgres's 8000-byte NOTIFY cap —
    // the newly generated Abstract is not in the event. Reaching
    // "summarized" is the cue to re-read that one Document over the normal
    // API, which is the ADR's "an event is a hint" contract made concrete.
    it('tracks the stage-2 statuses live, then re-reads the Document to pick up its Abstract', async () => {
      const listNotebooks = vi.fn().mockResolvedValue([]);
      const listDocuments = vi
        .fn()
        .mockResolvedValue([summarizedDocument({ status: 'converted', abstract: null })]);
      const getDocument = vi
        .fn()
        .mockResolvedValue(
          summarizedDocument({ status: 'summarized', abstract: 'The freshly generated Abstract.' }),
        );
      const appEvents = appEventsStub();

      await render(NotebookDetailPage, {
        providers: [
          activatedRouteFor(NOTEBOOK_ID),
          { provide: NotebooksService, useValue: { listNotebooks } },
          { provide: DocumentsService, useValue: { listDocuments, getDocument } },
          chatServiceStub(),
          { provide: DocumentTransferService, useValue: {} },
          appEvents.provider,
        ],
      });

      await screen.findByText('quarterly.pdf');
      expect(screen.getByText('converted')).toBeTruthy();
      expect(screen.getByText('Abstract not generated yet.')).toBeTruthy();

      appEvents.events.next({
        id: 'event-s1',
        type: 'document-version-status-changed',
        topic: `notebook:${NOTEBOOK_ID}`,
        occurredAt: '2026-01-01T00:00:01.000Z',
        data: { documentId: 'doc-7', versionId: 'v-11', status: 'summarizing' },
      });
      expect(await screen.findByText('summarizing')).toBeTruthy();
      // An in-progress stage is not a reason to re-read anything.
      expect(getDocument).not.toHaveBeenCalled();

      appEvents.events.next({
        id: 'event-s2',
        type: 'document-version-status-changed',
        topic: `notebook:${NOTEBOOK_ID}`,
        occurredAt: '2026-01-01T00:00:02.000Z',
        data: { documentId: 'doc-7', versionId: 'v-11', status: 'summarized' },
      });

      const badge = await screen.findByText('summarized');
      expect(badge.className).toContain('notebook-detail-page__badge--summarized');
      // The Abstract arrives from the re-read, not from the event.
      expect(await screen.findByText('The freshly generated Abstract.')).toBeTruthy();
      expect(getDocument).toHaveBeenCalledWith({ notebookId: NOTEBOOK_ID, documentId: 'doc-7' });
      // The whole list was never re-fetched — only the one Document that
      // changed.
      expect(listDocuments).toHaveBeenCalledTimes(1);
    });
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
        chatServiceStub(),
        { provide: DocumentTransferService, useValue: { downloadDocumentVersion } },
        appEventsStub().provider,
      ],
    });

    await screen.findByText('sheet.xlsx');
    fireEvent.click(screen.getByRole('button', { name: 'Download sheet.xlsx' }));

    expect(downloadDocumentVersion).toHaveBeenCalledWith(NOTEBOOK_ID, 'doc-4', 'v-9', 'sheet.xlsx');
  });

  // NBK-9: search is how a user finds a source without opening a chat, so it
  // has to be reachable from the Notebook they are already looking at.
  it("links to this Notebook's search page", async () => {
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

    const link = await screen.findByLabelText('Search this Notebook');
    expect(link.getAttribute('href')).toBe(`/notebooks/${NOTEBOOK_ID}/search`);
  });
});
