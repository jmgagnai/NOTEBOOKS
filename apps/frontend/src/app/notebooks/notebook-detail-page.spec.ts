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

  // NBK-17: while a batch runs the user can steer it and is protected from
  // losing it — Retry failed, Cancel, a disabled picker, the browser's
  // leave-page warning, survival across in-app navigation, and a dismiss
  // once it is done. Same seam as NBK-16: the real page and store, with only
  // the upload client, the generated Documents client and the app-events
  // stream mocked. The helpers mirror NBK-16's rather than sharing them, so
  // the tickets built in parallel on this file merge without touching each
  // other's blocks.
  describe('NBK-17: retry, cancel, and leaving the page', () => {
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

    /** An upload client whose every request stays in flight until the test settles it. */
    function heldUploads() {
      const inFlight: {
        file: File;
        request: ReturnType<typeof deferred<Record<string, unknown>>>;
      }[] = [];
      const uploadDocument = vi.fn().mockImplementation((_notebookId: string, file: File) => {
        const request = deferred<Record<string, unknown>>();
        inFlight.push({ file, request });
        return request.promise;
      });
      const sentNames = () => inFlight.map(({ file }) => file.name);
      const land = (filename: string) =>
        inFlight.find(({ file }) => file.name === filename)!.request.resolve(documentFor(filename));
      const fail = (filename: string) =>
        inFlight
          .find(({ file }) => file.name === filename)!
          .request.reject({ error: { message: 'Storage is unavailable.' } });
      return { uploadDocument, inFlight, sentNames, land, fail };
    }

    async function renderWithUpload(uploadDocument: ReturnType<typeof vi.fn>) {
      const listNotebooks = vi.fn().mockResolvedValue([]);
      const listDocuments = vi.fn().mockResolvedValue([]);
      const result = await render(NotebookDetailPage, {
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
      return result;
    }

    function pick(names: string[]) {
      const input = screen.getByLabelText('Upload Documents') as HTMLInputElement;
      fireEvent.change(input, { target: { files: names.map((name) => new File(['x'], name)) } });
      return input;
    }

    function panelRow(filename: string) {
      const panel = screen.getByRole('list', { name: 'Upload progress' });
      return within(panel)
        .getAllByRole('listitem')
        .find((row) => within(row).queryByText(filename) !== null)!;
    }

    it('re-sends only the failed files on Retry failed, three at a time, leaving the rest alone', async () => {
      const uploads = heldUploads();
      await renderWithUpload(uploads.uploadDocument);

      pick(['good.txt', 'photo.png', 'bad1.txt', 'bad2.txt', 'bad3.txt', 'bad4.txt']);
      await waitFor(() => expect(uploads.uploadDocument).toHaveBeenCalledTimes(3));
      uploads.land('good.txt');
      for (const name of ['bad1.txt', 'bad2.txt', 'bad3.txt', 'bad4.txt']) {
        await waitFor(() => expect(uploads.sentNames()).toContain(name));
        uploads.fail(name);
      }
      expect(await screen.findByText('1 uploaded, 1 skipped, 4 failed')).toBeTruthy();
      expect(uploads.uploadDocument).toHaveBeenCalledTimes(5);

      fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }));

      // Only the failures go again, through the same 3-at-a-time flow: three
      // in flight, the fourth waiting for a slot.
      await waitFor(() => expect(uploads.uploadDocument).toHaveBeenCalledTimes(8));
      expect(uploads.sentNames().slice(5)).toEqual(['bad1.txt', 'bad2.txt', 'bad3.txt']);
      expect(within(panelRow('bad4.txt')).getByText('waiting')).toBeTruthy();
      expect(screen.queryByText(/uploaded, .* skipped, .* failed/)).toBeNull();
      // The file that landed and the one that was skipped are untouched.
      expect(within(panelRow('good.txt')).getByText('uploaded')).toBeTruthy();
      expect(within(panelRow('photo.png')).getByText('skipped')).toBeTruthy();

      uploads.inFlight[5].request.resolve(documentFor('bad1.txt'));
      await waitFor(() => expect(uploads.uploadDocument).toHaveBeenCalledTimes(9));
      expect(uploads.sentNames()[8]).toBe('bad4.txt');
      for (const { file, request } of uploads.inFlight.slice(6)) {
        request.resolve(documentFor(file.name));
      }

      expect(await screen.findByText('5 uploaded, 1 skipped, 0 failed')).toBeTruthy();
      expect(uploads.uploadDocument).toHaveBeenCalledTimes(9);
      // Nothing is left to retry.
      expect(screen.queryByRole('button', { name: 'Retry failed' })).toBeNull();
      const cards = screen.getByRole('list', { name: 'Documents' });
      expect(within(cards).getByText('bad4.txt')).toBeTruthy();
      expect(within(cards).getAllByText('good.txt')).toHaveLength(1);
    });

    it('stops the files not yet sent on Cancel, and lets the ones in flight land', async () => {
      const uploads = heldUploads();
      await renderWithUpload(uploads.uploadDocument);

      pick(['1.txt', '2.txt', '3.txt', '4.txt', '5.txt']);
      await waitFor(() => expect(uploads.uploadDocument).toHaveBeenCalledTimes(3));
      await screen.findByText('5.txt');

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      // The two that had not gone out are stopped, and say why.
      for (const name of ['4.txt', '5.txt']) {
        const row = panelRow(name);
        expect(await within(row).findByText('skipped')).toBeTruthy();
        expect(within(row).getByText(/cancelled/i)).toBeTruthy();
      }
      // The three in flight are left alone — neither aborted nor re-sent —
      // and still land when they finish.
      expect(within(panelRow('1.txt')).getByText('uploading')).toBeTruthy();
      expect(screen.queryByText(/uploaded, .* skipped, .* failed/)).toBeNull();
      for (const name of ['1.txt', '2.txt', '3.txt']) uploads.land(name);

      expect(await screen.findByText('3 uploaded, 2 skipped, 0 failed')).toBeTruthy();
      expect(uploads.uploadDocument).toHaveBeenCalledTimes(3);
      const cards = screen.getByRole('list', { name: 'Documents' });
      expect(within(cards).getByText('3.txt')).toBeTruthy();
      expect(within(cards).queryByText('4.txt')).toBeNull();
      // Cancel is for a running batch; a finished one has nothing to cancel.
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    });

    it('disables the picker while the batch runs, so a second batch cannot start mid-way', async () => {
      const uploads = heldUploads();
      await renderWithUpload(uploads.uploadDocument);

      expect((screen.getByLabelText('Upload Documents') as HTMLInputElement).disabled).toBe(false);
      const input = pick(['1.txt', '2.txt']);
      await screen.findByText('2.txt');
      await waitFor(() => expect(input.disabled).toBe(true));

      uploads.land('1.txt');
      // One file landing does not free the picker; the batch is still running.
      await within(panelRow('1.txt')).findByText('uploaded');
      expect(input.disabled).toBe(true);

      uploads.land('2.txt');
      await screen.findByText('2 uploaded, 0 skipped, 0 failed');
      await waitFor(() => expect(input.disabled).toBe(false));
    });

    it("asks the browser to warn before the tab closes while the batch runs, and not once it's done", async () => {
      const uploads = heldUploads();
      await renderWithUpload(uploads.uploadDocument);
      // The browser only shows its leave-page dialog when the event is
      // cancelled, so "prevented" is the whole contract.
      const closingTab = () => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      };

      expect(closingTab()).toBe(false);

      pick(['1.txt', '2.txt']);
      await screen.findByText('2.txt');
      expect(closingTab()).toBe(true);

      uploads.land('1.txt');
      await within(panelRow('1.txt')).findByText('uploaded');
      expect(closingTab()).toBe(true);

      uploads.land('2.txt');
      await screen.findByText('2 uploaded, 0 skipped, 0 failed');
      expect(closingTab()).toBe(false);
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
