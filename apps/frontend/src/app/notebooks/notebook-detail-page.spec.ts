import { Component } from '@angular/core';
import { convertToParamMap, ActivatedRoute, RouterOutlet } from '@angular/router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { NotebookDetailPage } from './notebook-detail-page';
import { NotebooksService } from '../api/services/notebooks.service';
import { ChatService } from '../api/services/chat.service';
import { DocumentsService } from '../api/services/documents.service';
import { DocumentTransferService } from '../documents/document-transfer.service';
import { AppEvent, AppEventsService } from '../events/app-events.service';
import { provideAppIcons } from '../shared/fluent-icons';

const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';

/**
 * A bare outlet to route the real page in and out of (NBK-17): in-app
 * navigation has to destroy and re-create the page the way the router does.
 */
@Component({
  selector: 'app-router-shell',
  standalone: true,
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
class RouterShell {}

/** Any other page of the app, to navigate away to. */
@Component({ selector: 'app-elsewhere', standalone: true, template: '<p>Somewhere else</p>' })
class Elsewhere {}

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

/**
 * The page's providers, one set for every render: the route, the icon
 * registry (NBK-31) and the four clients the page reaches, each stubbed to
 * what the test hands over. A render through `RouterShell` says so: its real
 * router supplies the route the stub otherwise stands in for.
 */
function pageProviders({
  notebooks = { listNotebooks: vi.fn().mockResolvedValue([]) },
  documents,
  transfer = {},
  appEvents = appEventsStub(),
  inRouterShell = false,
}: {
  notebooks?: Record<string, unknown>;
  documents: Record<string, unknown>;
  transfer?: Record<string, unknown>;
  appEvents?: ReturnType<typeof appEventsStub>;
  inRouterShell?: boolean;
}) {
  return [
    ...(inRouterShell ? [] : [activatedRouteFor(NOTEBOOK_ID)]),
    provideAppIcons(),
    { provide: NotebooksService, useValue: notebooks },
    { provide: DocumentsService, useValue: documents },
    chatServiceStub(),
    { provide: DocumentTransferService, useValue: transfer },
    appEvents.provider,
  ];
}

// Shared by the upload blocks (NBK-16..19): a Document as the API returns
// it, a request the test settles by hand, the page rendered with an upload
// client, and the picker and the progress panel as a user reaches them.

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

/** A latest Version of `filename` stored as `mimeType`, the field the row's type icon reads (NBK-42). */
function versionOf(filename: string, mimeType: string) {
  return {
    id: `v-${filename}-1`,
    versionNumber: 1,
    mimeType,
    sizeBytes: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
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
  const land = (filename: string) =>
    inFlight.find(({ file }) => file.name === filename)!.request.resolve(documentFor(filename));
  const fail = (filename: string) =>
    inFlight
      .find(({ file }) => file.name === filename)!
      .request.reject({ error: { message: 'Storage is unavailable.' } });
  return { uploadDocument, inFlight, sentNames: () => sentNames(uploadDocument), land, fail };
}

/** The Notebook the header tests open (NBK-35), under its own title. */
const RESEARCH = { id: NOTEBOOK_ID, title: 'Research', createdAt: '2026-01-01T00:00:00.000Z' };

/**
 * The page on its Notebook, listing `existing`, with `uploadDocument` as the
 * upload client. The header tests (NBK-35) name the `notebook` so the title
 * shows, and hand over `renameNotebook` as the rename client; both are
 * waited for, since the title lands after the Document list.
 */
async function renderWithUpload(
  uploadDocument: ReturnType<typeof vi.fn>,
  existing: Record<string, unknown>[] = [],
  {
    notebook,
    renameNotebook,
  }: { notebook?: typeof RESEARCH; renameNotebook?: ReturnType<typeof vi.fn> } = {},
) {
  const listNotebooks = vi.fn().mockResolvedValue(notebook ? [notebook] : []);
  const listDocuments = vi.fn().mockResolvedValue(existing);
  const result = await render(NotebookDetailPage, {
    providers: pageProviders({
      notebooks: { listNotebooks, renameNotebook },
      documents: { listDocuments },
      transfer: { uploadDocument },
    }),
  });
  if (existing.length === 0) await screen.findByText('No Documents yet.');
  else await screen.findByText(String(existing[0]['filename']));
  if (notebook) await screen.findByRole('button', { name: notebook.title });
  return result;
}

/** Opens the "Research" title for editing and types `title` into it. */
async function typeTitle(title: string) {
  fireEvent.click(await screen.findByRole('button', { name: RESEARCH.title }));
  const input = screen.getByLabelText('Notebook title') as HTMLInputElement;
  expect(input.value).toBe(RESEARCH.title);
  fireEvent.input(input, { target: { value: title } });
  return input;
}

/** A one-byte file, when only its name matters. */
function fileNamed(name: string) {
  return new File(['x'], name);
}

/** Selects `files` in the picker. */
function pick(files: File[]) {
  const input = screen.getByLabelText('Upload Documents') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
  return input;
}

/** The filenames `uploadDocument` was asked to send, in order. */
function sentNames(uploadDocument: ReturnType<typeof vi.fn>) {
  return uploadDocument.mock.calls.map(([, file]) => (file as File).name);
}

/** The progress panel's row for `filename`. */
function panelRow(filename: string) {
  const panel = screen.getByRole('list', { name: 'Upload progress' });
  return within(panel)
    .getAllByRole('listitem')
    .find((row) => within(row).queryByText(filename) !== null)!;
}

// Document row helpers (NBK-42): the Documents list is one row per Document,
// with Open, Download and Delete behind the row's "…" menu.

/** The Documents list's row for `filename`. */
function documentRow(filename: string) {
  const list = screen.getByRole('list', { name: 'Documents' });
  return within(list)
    .getAllByRole('listitem')
    .find((row) => within(row).queryByText(filename) !== null)!;
}

/** Opens the row's "…" menu and returns its `action` item, named "<action> <filename>". */
async function rowMenuItem(filename: string, action: 'Open' | 'Download' | 'Delete') {
  fireEvent.click(
    within(documentRow(filename)).getByRole('button', { name: `Actions for ${filename}` }),
  );
  return screen.findByRole('menuitem', { name: `${action} ${filename}` });
}

// Drag-and-drop helpers (NBK-18, NBK-36), at module scope because NBK-37's
// hidden panel has to come back for a drag too.
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

/**
 * The Documents panel: the drop target since NBK-36. Drag events bubble up
 * to the page, so it also serves as "somewhere on the page" for a drag.
 */
function documentsPanel() {
  return screen.getByRole('complementary', { name: 'Documents' });
}

/** Somewhere else on the page, for a drag moving between its elements. */
function elsewhereOnThePage() {
  return screen.getByRole('region', { name: 'Chat' });
}

const DROP_HINT = 'Drop files to upload them into this Notebook';
const DRAG_OVER = 'notebook-detail-page__panel--drag-over';

/** Whether files dragged over the page light up the Documents panel, and only it. */
function highlightsDocumentsPanel() {
  const litUp = document.querySelectorAll(`.${DRAG_OVER}`);
  const hintInPanel = within(documentsPanel()).queryByText(DROP_HINT) !== null;
  expect(litUp.length).toBe(hintInPanel ? 1 : 0);
  if (hintInPanel) expect(litUp[0]).toBe(documentsPanel());
  // Nothing outside the panel lights up or carries the hint.
  expect(screen.queryAllByText(DROP_HINT).length).toBe(hintInPanel ? 1 : 0);
  return hintInPanel;
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
      providers: pageProviders({
        notebooks: { listNotebooks },
        documents: { listDocuments },
      }),
    });

    expect(await screen.findByText('Research')).toBeTruthy();
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

  // NBK-16: several files picked at once upload as one batch — one request per
  // file to the existing single-file route, at most 3 in flight, with a
  // per-file progress panel and a summary. The batch lives in the
  // root-provided store, but the only things asserted here are what a user
  // sees and the calls the mocked upload client receives.
  describe('NBK-16: batch upload', () => {
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
      expect(sentNames(uploadDocument)).toEqual(['a.txt', 'b.md']);
    });

    it('keeps at most 3 requests in flight, taking files in selection order', async () => {
      const inFlight: ReturnType<typeof deferred<Record<string, unknown>>>[] = [];
      const uploadDocument = vi.fn().mockImplementation(() => {
        const request = deferred<Record<string, unknown>>();
        inFlight.push(request);
        return request.promise;
      });
      await renderWithUpload(uploadDocument);

      pick(['1.txt', '2.txt', '3.txt', '4.txt', '5.txt'].map(fileNamed));

      await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(3));
      expect(sentNames(uploadDocument)).toEqual(['1.txt', '2.txt', '3.txt']);

      // Nothing more goes out until a slot frees up...
      await screen.findByText('5.txt');
      expect(uploadDocument).toHaveBeenCalledTimes(3);

      // ...and when one does, the next file in selection order takes it.
      inFlight[1].resolve(documentFor('2.txt'));
      await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(4));
      expect(sentNames(uploadDocument)[3]).toBe('4.txt');

      inFlight[0].resolve(documentFor('1.txt'));
      await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(5));
      expect(sentNames(uploadDocument)[4]).toBe('5.txt');

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

      pick(['1.txt', '2.txt', '3.txt', '4.txt'].map(fileNamed));

      await screen.findByText('4.txt');
      expect(within(panelRow('1.txt')).getByText('Uploading')).toBeTruthy();
      expect(within(panelRow('4.txt')).getByText('Waiting')).toBeTruthy();
      // No summary while files are still moving.
      expect(screen.queryByText(/uploaded, .* skipped, .* failed/)).toBeNull();

      inFlight[0].resolve(documentFor('1.txt'));
      expect(await within(panelRow('1.txt')).findByText('Uploaded')).toBeTruthy();
      expect(await within(panelRow('4.txt')).findByText('Uploading')).toBeTruthy();
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
      expect(within(photo).getByText('Skipped')).toBeTruthy();
      expect(
        within(photo).getByText(
          'Unsupported file type. Accepted types: text, Markdown, DOCX, Excel (.xlsx), CSV, and PDF.',
        ),
      ).toBeTruthy();
      const legacy = panelRow('legacy.xls');
      expect(within(legacy).getByText('Skipped')).toBeTruthy();
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
      expect(within(panelRow('at-limit.pdf')).getByText('Uploaded')).toBeTruthy();
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
      expect(within(rows[0]).getByText('Uploaded')).toBeTruthy();
      expect(within(rows[1]).getByText('Skipped')).toBeTruthy();
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
      // The panel reuses the Document status badge (NBK-32): a request that
      // did not land reads as a failure, a landed one as finished.
      expect(within(bad).getByText('Failed').className).toContain('app-badge--error');
      expect(within(panelRow('good.txt')).getByText('Uploaded').className).toContain(
        'app-badge--success',
      );
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
      expect(within(panelRow('report.txt')).getByText('New version').className).toContain(
        'app-badge--success',
      );
      expect(within(panelRow('fresh.txt')).getByText('Uploaded')).toBeTruthy();

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
  // stream mocked.
  describe('NBK-17: retry, cancel, and leaving the page', () => {
    it('re-sends only the failed files on Retry failed, three at a time, leaving the rest alone', async () => {
      const uploads = heldUploads();
      await renderWithUpload(uploads.uploadDocument);

      pick(
        ['good.txt', 'photo.png', 'bad1.txt', 'bad2.txt', 'bad3.txt', 'bad4.txt'].map(fileNamed),
      );
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
      expect(within(panelRow('bad4.txt')).getByText('Waiting')).toBeTruthy();
      expect(screen.queryByText(/uploaded, .* skipped, .* failed/)).toBeNull();
      // The file that landed and the one that was skipped are untouched.
      expect(within(panelRow('good.txt')).getByText('Uploaded')).toBeTruthy();
      expect(within(panelRow('photo.png')).getByText('Skipped')).toBeTruthy();

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

      pick(['1.txt', '2.txt', '3.txt', '4.txt', '5.txt'].map(fileNamed));
      await waitFor(() => expect(uploads.uploadDocument).toHaveBeenCalledTimes(3));
      await screen.findByText('5.txt');

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      // The two that had not gone out are stopped, and say why.
      for (const name of ['4.txt', '5.txt']) {
        const row = panelRow(name);
        expect(await within(row).findByText('Skipped')).toBeTruthy();
        expect(within(row).getByText(/cancelled/i)).toBeTruthy();
      }
      // The three in flight are left alone — neither aborted nor re-sent —
      // and still land when they finish.
      expect(within(panelRow('1.txt')).getByText('Uploading')).toBeTruthy();
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
      const input = pick(['1.txt', '2.txt'].map(fileNamed));
      await screen.findByText('2.txt');
      await waitFor(() => expect(input.disabled).toBe(true));

      uploads.land('1.txt');
      // One file landing does not free the picker; the batch is still running.
      await within(panelRow('1.txt')).findByText('Uploaded');
      expect(input.disabled).toBe(true);

      uploads.land('2.txt');
      await screen.findByText('2 uploaded, 0 skipped, 0 failed');
      await waitFor(() => expect(input.disabled).toBe(false));
    });

    // The disabled picker is the page's guard; the store has its own, so a
    // selection that reaches it anyway — a dialog open counts as running too
    // — leaves the batch alone and says why.
    it('refuses a second selection while the batch runs, even with a conflict dialog open', async () => {
      const uploads = heldUploads();
      await renderWithUpload(uploads.uploadDocument, [documentFor('report.txt')]);

      const input = pick(['1.txt', '2.txt', '3.txt', 'report.txt'].map(fileNamed));
      const open = await screen.findByRole('dialog', { name: 'Document already exists' });
      await waitFor(() => expect(uploads.uploadDocument).toHaveBeenCalledTimes(3));
      expect(input.disabled).toBe(true);

      // Past the disabled picker, as a stale page or a script could be.
      input.disabled = false;
      pick([fileNamed('later.txt')]);

      expect(await screen.findByText('An upload is already running.')).toBeTruthy();
      const panel = screen.getByRole('list', { name: 'Upload progress' });
      expect(within(panel).getAllByRole('listitem')).toHaveLength(4);
      expect(within(panel).queryByText('later.txt')).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Document already exists' })).toBe(open);
      expect(uploads.uploadDocument).toHaveBeenCalledTimes(3);

      // The running batch finishes as if nothing had happened.
      fireEvent.click(within(open).getByRole('button', { name: 'New Version' }));
      for (const name of ['1.txt', '2.txt', '3.txt']) uploads.land(name);
      await waitFor(() => expect(uploads.sentNames()).toContain('report.txt'));
      uploads.land('report.txt');
      expect(
        await screen.findByText('4 uploaded (1 as new Versions), 0 skipped, 0 failed'),
      ).toBeTruthy();
      expect(uploads.uploadDocument).toHaveBeenCalledTimes(4);
    });

    it("asks the browser to warn before the tab closes while the batch runs, and not once it's done", async () => {
      const uploads = heldUploads();
      await renderWithUpload(uploads.uploadDocument);
      // The browser only shows its leave-page dialog when the event is
      // cancelled — by `preventDefault()`, or, in older Chromium, by setting
      // `returnValue` — so both are the contract. jsdom has no
      // BeforeUnloadEvent, and its plain Event's legacy `returnValue` only
      // mirrors `defaultPrevented`; an own property stands in for the real
      // one so the assignment is observable.
      const closingTab = () => {
        const event = new Event('beforeunload', { cancelable: true });
        Object.defineProperty(event, 'returnValue', { value: undefined, writable: true });
        window.dispatchEvent(event);
        return { prevented: event.defaultPrevented, returnValue: event.returnValue };
      };

      expect(closingTab()).toEqual({ prevented: false, returnValue: undefined });

      pick(['1.txt', '2.txt'].map(fileNamed));
      await screen.findByText('2.txt');
      expect(closingTab()).toEqual({ prevented: true, returnValue: '' });

      uploads.land('1.txt');
      await within(panelRow('1.txt')).findByText('Uploaded');
      expect(closingTab()).toEqual({ prevented: true, returnValue: '' });

      uploads.land('2.txt');
      await screen.findByText('2 uploaded, 0 skipped, 0 failed');
      expect(closingTab()).toEqual({ prevented: false, returnValue: undefined });
    });

    // Real routing here, not the ActivatedRoute stub: the page has to be
    // destroyed and created again by the router, the way it is in the app,
    // for "navigating away and back" to mean anything.
    it('keeps the batch going, and shows it again, across in-app navigation away and back', async () => {
      const uploads = heldUploads();
      // The second visit re-reads the list, and by then the first file is
      // stored — as the real backend would report.
      const listDocuments = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([documentFor('1.txt')]);
      const { navigate } = await render(RouterShell, {
        routes: [
          { path: 'notebooks/:notebookId', component: NotebookDetailPage },
          { path: 'elsewhere', component: Elsewhere },
        ],
        providers: pageProviders({
          documents: { listDocuments },
          transfer: { uploadDocument: uploads.uploadDocument },
          inRouterShell: true,
        }),
      });
      await navigate(`/notebooks/${NOTEBOOK_ID}`);
      await screen.findByText('No Documents yet.');

      pick(['1.txt', '2.txt'].map(fileNamed));
      await waitFor(() => expect(uploads.uploadDocument).toHaveBeenCalledTimes(2));
      await screen.findByText('2.txt');

      await navigate('/elsewhere');
      await screen.findByText('Somewhere else');
      expect(screen.queryByRole('list', { name: 'Upload progress' })).toBeNull();
      // A file landing while the page is away is not lost...
      uploads.land('1.txt');

      await navigate(`/notebooks/${NOTEBOOK_ID}`);
      // ...the batch is still shown, in progress, with what landed meanwhile...
      const panel = await screen.findByRole('list', { name: 'Upload progress' });
      expect(within(panelRow('1.txt')).getByText('Uploaded')).toBeTruthy();
      expect(within(panelRow('2.txt')).getByText('Uploading')).toBeTruthy();
      expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
      expect((screen.getByLabelText('Upload Documents') as HTMLInputElement).disabled).toBe(true);
      // ...and Documents keep landing on the re-created page; no file was
      // sent twice.
      uploads.land('2.txt');
      expect(await screen.findByText('2 uploaded, 0 skipped, 0 failed')).toBeTruthy();
      const cards = screen.getByRole('list', { name: 'Documents' });
      expect(within(cards).getByText('1.txt')).toBeTruthy();
      expect(within(cards).getByText('2.txt')).toBeTruthy();
      expect(uploads.uploadDocument).toHaveBeenCalledTimes(2);
    });

    // The batch outlives the page, but the Document list in the same store
    // is whichever Notebook was opened last. A file landing while another
    // Notebook is open must neither show up in that Notebook's list nor be
    // judged a conflict against that Notebook's names.
    it('keeps a file landing while another Notebook is open out of its list, and judges conflicts by its own Notebook', async () => {
      const OTHER_NOTEBOOK_ID = '22222222-2222-2222-2222-222222222222';
      const uploads = heldUploads();
      // The other Notebook already has a notes.txt; this one does not — and
      // this one's list is what the backend reports at each visit.
      let thisNotebooksDocuments: Record<string, unknown>[] = [];
      const listDocuments = vi
        .fn()
        .mockImplementation(({ notebookId }: { notebookId: string }) =>
          Promise.resolve(
            notebookId === OTHER_NOTEBOOK_ID
              ? [{ ...documentFor('notes.txt'), notebookId: OTHER_NOTEBOOK_ID }]
              : thisNotebooksDocuments,
          ),
        );
      const { navigate } = await render(RouterShell, {
        routes: [
          { path: 'notebooks/:notebookId', component: NotebookDetailPage },
          { path: 'elsewhere', component: Elsewhere },
        ],
        providers: pageProviders({
          documents: { listDocuments },
          transfer: { uploadDocument: uploads.uploadDocument },
          inRouterShell: true,
        }),
      });
      await navigate(`/notebooks/${NOTEBOOK_ID}`);
      await screen.findByText('No Documents yet.');

      pick(['1.txt', '2.txt', '3.txt', 'notes.txt'].map(fileNamed));
      await waitFor(() => expect(uploads.uploadDocument).toHaveBeenCalledTimes(3));
      expect(within(panelRow('notes.txt')).getByText('Waiting')).toBeTruthy();

      // Through another page, as the app goes through the Notebooks list: the
      // router reuses the page between two Notebooks on the same route.
      await navigate('/elsewhere');
      await navigate(`/notebooks/${OTHER_NOTEBOOK_ID}`);
      const otherCards = await screen.findByRole('list', { name: 'Documents' });
      expect(within(otherCards).getByText('notes.txt')).toBeTruthy();
      expect(screen.queryByRole('list', { name: 'Upload progress' })).toBeNull();

      // A slot frees up while the other Notebook is open: the file that lands
      // stays out of its list, and the batch's notes.txt goes out — the other
      // Notebook's notes.txt is no conflict for it.
      uploads.land('1.txt');
      await waitFor(() => expect(uploads.uploadDocument).toHaveBeenCalledTimes(4));
      expect(uploads.sentNames()[3]).toBe('notes.txt');
      expect(within(otherCards).queryByText('1.txt')).toBeNull();
      expect(within(otherCards).getAllByRole('listitem')).toHaveLength(1);

      // Back on the first Notebook, its list is re-read and shows what landed.
      thisNotebooksDocuments = [documentFor('1.txt')];
      await navigate('/elsewhere');
      await navigate(`/notebooks/${NOTEBOOK_ID}`);
      const cards = await screen.findByRole('list', { name: 'Documents' });
      expect(await within(cards).findByText('1.txt')).toBeTruthy();
      expect(listDocuments).toHaveBeenCalledWith({ notebookId: NOTEBOOK_ID });
      expect(
        listDocuments.mock.calls.filter(([args]) => args.notebookId === NOTEBOOK_ID),
      ).toHaveLength(2);
      expect(within(panelRow('1.txt')).getByText('Uploaded')).toBeTruthy();
      expect(within(panelRow('notes.txt')).getByText('Uploading')).toBeTruthy();
      expect(screen.queryByRole('dialog', { name: 'Document already exists' })).toBeNull();

      for (const name of ['2.txt', '3.txt', 'notes.txt']) uploads.land(name);
      expect(await screen.findByText('4 uploaded, 0 skipped, 0 failed')).toBeTruthy();
      expect(within(panelRow('notes.txt')).getByText('Uploaded')).toBeTruthy();
      expect(within(cards).getAllByText('notes.txt')).toHaveLength(1);
      expect(within(cards).getAllByText('1.txt')).toHaveLength(1);
    });

    it('offers to dismiss the panel once the batch has finished, and not before', async () => {
      const uploads = heldUploads();
      await renderWithUpload(uploads.uploadDocument);

      pick([fileNamed('1.txt')]);
      await screen.findByText('1.txt');
      expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();

      uploads.land('1.txt');
      await screen.findByText('1 uploaded, 0 skipped, 0 failed');
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

      await waitFor(() =>
        expect(screen.queryByRole('list', { name: 'Upload progress' })).toBeNull(),
      );
      expect(screen.queryByText('1 uploaded, 0 skipped, 0 failed')).toBeNull();
      // Dismissing the panel forgets nothing that was stored.
      expect(
        within(screen.getByRole('list', { name: 'Documents' })).getByText('1.txt'),
      ).toBeTruthy();
    });

    // Cancel meets the conflict dialog (NBK-19): a file waiting on its
    // dialog is a file not yet sent, so Cancel covers it too — the question
    // is withdrawn, not left on screen over a batch that has nothing left
    // to ask about.
    it('withdraws an open conflict dialog on Cancel, and the batch still finishes', async () => {
      const uploads = heldUploads();
      await renderWithUpload(uploads.uploadDocument, [documentFor('report.txt')]);

      pick(['1.txt', '2.txt', '3.txt', 'report.txt', '4.txt'].map(fileNamed));
      const open = await screen.findByRole('dialog', { name: 'Document already exists' });
      expect(within(open).getByText(/"report\.txt" already exists/)).toBeTruthy();
      await waitFor(() => expect(uploads.uploadDocument).toHaveBeenCalledTimes(3));

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Document already exists' })).toBeNull(),
      );
      for (const name of ['report.txt', '4.txt']) {
        const row = panelRow(name);
        expect(await within(row).findByText('Skipped')).toBeTruthy();
        expect(within(row).getByText(/cancelled/i)).toBeTruthy();
      }
      // The three in flight still land, and the batch reaches its summary.
      for (const name of ['1.txt', '2.txt', '3.txt']) uploads.land(name);
      expect(await screen.findByText('3 uploaded, 2 skipped, 0 failed')).toBeTruthy();
      expect(uploads.uploadDocument).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole('dialog', { name: 'Document already exists' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
      // The existing Document was neither replaced nor duplicated.
      const cards = screen.getByRole('list', { name: 'Documents' });
      expect(within(cards).getAllByText('report.txt')).toHaveLength(1);
      // Still its one Version: the row shows no version tag (NBK-42).
      expect(within(documentRow('report.txt')).queryByText(/^v\d+$/)).toBeNull();
    });
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

  // NBK-19: before a file silently becomes a new Version of an existing
  // Document, the user is asked. The conflict is detected in the browser,
  // against the Document list the page already holds; the dialog offers New
  // Version or Skip, one file at a time, while the other files keep going.
  describe('NBK-19: conflict dialog', () => {
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

    const dialog = () => screen.queryByRole('dialog', { name: 'Document already exists' });
    const findDialog = () => screen.findByRole('dialog', { name: 'Document already exists' });
    const getDialog = () => screen.getByRole('dialog', { name: 'Document already exists' });

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
      expect(within(panelRow('report.txt')).getByText('Waiting')).toBeTruthy();

      fireEvent.click(within(open).getByRole('button', { name: 'New Version' }));

      expect(
        await screen.findByText('1 uploaded (1 as new Versions), 0 skipped, 0 failed'),
      ).toBeTruthy();
      expect(dialog()).toBeNull();
      expect(uploadDocument).toHaveBeenCalledTimes(1);
      expect(within(panelRow('report.txt')).getByText('New version')).toBeTruthy();
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
      expect(within(row).getByText('Skipped')).toBeTruthy();
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

      pick(['a.txt', 'fresh.txt', 'b.txt', 'c.txt'].map(fileNamed));

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
        expect(within(panelRow(name)).getByText('Skipped')).toBeTruthy();
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

      pick(['a.txt', 'b.txt'].map(fileNamed));

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
      pick(['a.txt', 'b.txt', '1.txt', '2.txt', '3.txt', '4.txt'].map(fileNamed));

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
        expect(within(getDialog()).getByText(/"b\.txt" already exists/)).toBeTruthy(),
      );
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      // a.txt is now sendable, but every slot is taken; it goes out once one
      // frees up.
      expect(uploadDocument).toHaveBeenCalledTimes(4);
      inFlight.get('1.txt')!.resolve(documentFor('1.txt'));
      await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(5));
      expect(sentNames(uploadDocument)[4]).toBe('a.txt');

      fireEvent.click(within(getDialog()).getByRole('button', { name: 'Skip' }));
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
      expect(within(panelRow('deleted-earlier.txt')).getByText('Uploaded')).toBeTruthy();
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

  // NBK-42: one compact row per Document — type icon, filename, a quiet
  // status, a warning when ingestion failed, and Open, Download and Delete
  // behind a "…" menu. The row itself opens the Document.
  describe('NBK-42: compact Document rows', () => {
    it('shows each type icon from the latest Version, named for the kind of Document', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('a.pdf', { latestVersion: versionOf('a.pdf', 'application/pdf') }),
        documentFor('b.docx', {
          latestVersion: versionOf(
            'b.docx',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ),
        }),
        documentFor('c.md', { latestVersion: versionOf('c.md', 'text/markdown') }),
        documentFor('d.csv', { latestVersion: versionOf('d.csv', 'text/csv') }),
        documentFor('e.bin', { latestVersion: versionOf('e.bin', 'application/octet-stream') }),
      ]);

      expect(within(documentRow('a.pdf')).getByRole('img', { name: 'PDF' })).toBeTruthy();
      expect(within(documentRow('b.docx')).getByRole('img', { name: 'Word' })).toBeTruthy();
      expect(within(documentRow('c.md')).getByRole('img', { name: 'Text' })).toBeTruthy();
      expect(within(documentRow('d.csv')).getByRole('img', { name: 'Spreadsheet' })).toBeTruthy();
      expect(within(documentRow('e.bin')).getByRole('img', { name: 'Document' })).toBeTruthy();
    });

    it('shows the stage while ingesting and nothing at all once ready', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('busy.txt', { status: 'summarizing' }),
        documentFor('done.txt', { status: 'ready' }),
      ]);

      const busy = documentRow('busy.txt');
      expect(within(busy).getByText('Summarizing')).toBeTruthy();
      expect(within(busy).getByRole('progressbar')).toBeTruthy();

      const done = documentRow('done.txt');
      expect(done.textContent?.trim()).toBe('done.txt');
      expect(within(done).queryByRole('progressbar')).toBeNull();
      expect(within(done).queryByRole('img', { name: 'Ingestion failed' })).toBeNull();
    });

    it('marks a failed Document with a warning that carries the reason', async () => {
      await renderWithUpload(vi.fn(), [documentFor('broken.pdf', { status: 'failed' })]);

      const row = documentRow('broken.pdf');
      const warning = within(row).getByRole('img', {
        name: 'Ingestion failed',
        description: 'Ingestion failed for the latest Version of this Document.',
      });
      expect(warning).toBeTruthy();
      expect(within(row).queryByRole('progressbar')).toBeNull();
      expect(within(row).queryByText('Failed')).toBeNull();
    });

    it('shows the version only once a Document has more than one Version', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('one.txt', { status: 'ready' }),
        documentFor('three.txt', {
          status: 'ready',
          latestVersion: { ...versionOf('three.txt', 'text/plain'), versionNumber: 3 },
        }),
      ]);

      expect(within(documentRow('one.txt')).queryByText(/^v\d+$/)).toBeNull();
      expect(within(documentRow('three.txt')).getByText('v3')).toBeTruthy();
    });

    it('shows the full filename on hover', async () => {
      const long = 'a-very-long-quarterly-report-name-that-will-not-fit-the-panel.pdf';
      await renderWithUpload(vi.fn(), [documentFor(long)]);

      expect(within(documentRow(long)).getByTitle(long)).toBeTruthy();
    });

    it('opens the Document when the row is activated', async () => {
      const listDocuments = vi.fn().mockResolvedValue([documentFor('report.txt')]);
      const { navigate } = await render(RouterShell, {
        routes: [
          { path: 'notebooks/:notebookId', component: NotebookDetailPage },
          { path: 'notebooks/:notebookId/documents/:documentId', component: Elsewhere },
        ],
        providers: pageProviders({ documents: { listDocuments }, inRouterShell: true }),
      });
      await navigate(`/notebooks/${NOTEBOOK_ID}`);
      await screen.findByText('report.txt');

      // A link, so Enter opens it as a click does.
      const open = within(documentRow('report.txt')).getByRole('link', { name: /report\.txt/ });
      expect(open.getAttribute('href')).toBe(`/notebooks/${NOTEBOOK_ID}/documents/doc-report.txt`);
      fireEvent.click(open);

      expect(await screen.findByText('Somewhere else')).toBeTruthy();
    });

    it('moves between rows with the arrow keys, from one Tab stop', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('a.txt'),
        documentFor('b.txt'),
        documentFor('c.txt'),
      ]);
      const rowLink = (filename: string) =>
        within(documentRow(filename)).getByRole('link', { name: new RegExp(filename) });

      expect(['a.txt', 'b.txt', 'c.txt'].map((name) => rowLink(name).tabIndex)).toEqual([
        0, -1, -1,
      ]);

      rowLink('a.txt').focus();
      fireEvent.keyDown(rowLink('a.txt'), { key: 'ArrowDown' });
      expect(document.activeElement).toBe(rowLink('b.txt'));
      fireEvent.keyDown(rowLink('b.txt'), { key: 'End' });
      expect(document.activeElement).toBe(rowLink('c.txt'));
      fireEvent.keyDown(rowLink('c.txt'), { key: 'ArrowUp' });
      expect(document.activeElement).toBe(rowLink('b.txt'));
      // The Tab stop follows the focus, so Tab out and back lands here again.
      expect(rowLink('b.txt').tabIndex).toBe(0);
      expect(rowLink('a.txt').tabIndex).toBe(-1);
    });

    it('offers Open, Download and Delete in the row menu, reachable by keyboard', async () => {
      await renderWithUpload(vi.fn(), [documentFor('report.txt')]);

      const more = within(documentRow('report.txt')).getByRole('button', {
        name: 'Actions for report.txt',
      });
      expect(more.tagName).toBe('BUTTON');
      fireEvent.click(more);

      const items = await screen.findAllByRole('menuitem');
      expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
        'Open report.txt',
        'Download report.txt',
        'Delete report.txt',
      ]);
    });

    it('leaves no Document card, badge or Abstract in the list', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('report.txt', { status: 'ready', abstract: 'An Abstract to skim.' }),
      ]);

      const list = screen.getByRole('list', { name: 'Documents' });
      expect(within(list).queryByText('An Abstract to skim.')).toBeNull();
      expect(list.querySelector('app-status-badge')).toBeNull();
    });
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

  // NBK-7 gave each Document card its Abstract; NBK-42 folded the cards into
  // rows and the Abstract left the list (spec 03 brings it back as a popover
  // on the filename). What stays is the way to the Document, and the re-read
  // that fetches the Abstract once stage 2 has written it.
  describe('NBK-7: opening a Document and following its Abstract', () => {
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

    it("offers Open in the row's menu, linking to the Document", async () => {
      const listDocuments = vi.fn().mockResolvedValue([summarizedDocument()]);

      await render(NotebookDetailPage, {
        providers: pageProviders({
          documents: { listDocuments },
        }),
      });

      expect(await screen.findByText('quarterly.pdf')).toBeTruthy();
      // The Abstract is no longer on the row (NBK-42).
      expect(
        screen.queryByText(
          'A quarterly report covering revenue growth and supply-chain risk across three regions.',
        ),
      ).toBeNull();

      // Opening the Document is where the Executive Summary lives, so the
      // row has to get the user there.
      const open = await rowMenuItem('quarterly.pdf', 'Open');
      expect(open.getAttribute('href')).toBe(`/notebooks/${NOTEBOOK_ID}/documents/doc-7`);
    });

    // The pipeline now has a second stage, so the badge has two more states
    // to show. And because an app event carries only *what changed* — per
    // ADR-0004 it has to stay well inside Postgres's 8000-byte NOTIFY cap —
    // the newly generated Abstract is not in the event. Reaching
    // "summarized" is the cue to re-read that one Document over the normal
    // API, which is the ADR's "an event is a hint" contract made concrete.
    it('tracks the stage-2 statuses live, then re-reads the Document to pick up its Abstract', async () => {
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
        providers: pageProviders({
          documents: { listDocuments, getDocument },
          appEvents,
        }),
      });

      await screen.findByText('quarterly.pdf');
      expect(screen.getByText('Converted')).toBeTruthy();

      appEvents.events.next({
        id: 'event-s1',
        type: 'document-version-status-changed',
        topic: `notebook:${NOTEBOOK_ID}`,
        occurredAt: '2026-01-01T00:00:01.000Z',
        data: { documentId: 'doc-7', versionId: 'v-11', status: 'summarizing' },
      });
      expect(await screen.findByText('Summarizing')).toBeTruthy();
      // An in-progress stage is not a reason to re-read anything.
      expect(getDocument).not.toHaveBeenCalled();

      appEvents.events.next({
        id: 'event-s2',
        type: 'document-version-status-changed',
        topic: `notebook:${NOTEBOOK_ID}`,
        occurredAt: '2026-01-01T00:00:02.000Z',
        data: { documentId: 'doc-7', versionId: 'v-11', status: 'summarized' },
      });

      expect(await screen.findByText('Summarized')).toBeTruthy();
      // The Abstract arrives from the re-read, not from the event; the row
      // no longer shows it (NBK-42), so the re-read itself is what is seen.
      await waitFor(() =>
        expect(getDocument).toHaveBeenCalledWith({ notebookId: NOTEBOOK_ID, documentId: 'doc-7' }),
      );
      // The whole list was never re-fetched — only the one Document that
      // changed.
      expect(listDocuments).toHaveBeenCalledTimes(1);
    });
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

  // NBK-9: search is how a user looks something up in the Documents without
  // opening a chat, so it has to be reachable from the Notebook they are
  // already looking at.
  it("links to this Notebook's search page", async () => {
    const listDocuments = vi.fn().mockResolvedValue([]);

    await render(NotebookDetailPage, {
      providers: pageProviders({
        documents: { listDocuments },
      }),
    });

    const link = await screen.findByLabelText('Search this Notebook');
    expect(link.getAttribute('href')).toBe(`/notebooks/${NOTEBOOK_ID}/search`);
  });

  // NBK-35: the Notebook is a full-height workspace of three cards — the
  // Chat Threads navigator, the open Thread and the Documents panel — each a
  // labelled landmark so a keyboard user can jump between them, under a slim
  // header that carries the way back, the title and the Notebook's actions.
  describe('NBK-35: workspace frame', () => {
    it('lays the Notebook out as three labelled regions', async () => {
      await renderWithUpload(vi.fn());

      const navigator = screen.getByRole('navigation', { name: 'Chat Threads' });
      const chat = screen.getByRole('region', { name: 'Chat' });
      const documents = screen.getByRole('complementary', { name: 'Documents' });

      expect(within(navigator).getByRole('button', { name: 'New Chat Thread' })).toBeTruthy();
      expect(
        within(chat).getByText('Open a Chat Thread, or start one, to ask a question.'),
      ).toBeTruthy();
      expect(within(documents).getByText('No Documents yet.')).toBeTruthy();
    });

    it('renames the Notebook from its title on Enter', async () => {
      const renameNotebook = vi.fn().mockResolvedValue({ ...RESEARCH, title: 'Research 2026' });
      await renderWithUpload(vi.fn(), [], { notebook: RESEARCH, renameNotebook });

      fireEvent.keyDown(await typeTitle('Research 2026'), { key: 'Enter' });

      expect(renameNotebook).toHaveBeenCalledWith({
        id: NOTEBOOK_ID,
        body: { title: 'Research 2026' },
      });
      expect(await screen.findByRole('button', { name: 'Research 2026' })).toBeTruthy();
      expect(screen.queryByLabelText('Notebook title')).toBeNull();
    });

    it('commits the rename when the title box loses focus', async () => {
      const renameNotebook = vi.fn().mockResolvedValue({ ...RESEARCH, title: 'Archive' });
      await renderWithUpload(vi.fn(), [], { notebook: RESEARCH, renameNotebook });

      fireEvent.blur(await typeTitle('Archive'));

      expect(renameNotebook).toHaveBeenCalledWith({ id: NOTEBOOK_ID, body: { title: 'Archive' } });
      expect(await screen.findByRole('button', { name: 'Archive' })).toBeTruthy();
    });

    it('discards the edit on Escape and sends nothing', async () => {
      const renameNotebook = vi.fn();
      await renderWithUpload(vi.fn(), [], { notebook: RESEARCH, renameNotebook });

      fireEvent.keyDown(await typeTitle('Mistake'), { key: 'Escape' });

      expect(renameNotebook).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Research' })).toBeTruthy();
      expect(screen.queryByLabelText('Notebook title')).toBeNull();
    });

    it('"Back to Notebooks" takes the user to the Notebooks list', async () => {
      const listNotebooks = vi.fn().mockResolvedValue([RESEARCH]);
      const listDocuments = vi.fn().mockResolvedValue([]);
      const { navigate } = await render(RouterShell, {
        routes: [
          { path: 'notebooks/:notebookId', component: NotebookDetailPage },
          { path: '', component: Elsewhere },
        ],
        providers: pageProviders({
          notebooks: { listNotebooks },
          documents: { listDocuments },
          inRouterShell: true,
        }),
      });
      await navigate(`/notebooks/${NOTEBOOK_ID}`);
      await screen.findByText('No Documents yet.');

      fireEvent.click(screen.getByRole('button', { name: 'Back to Notebooks' }));

      expect(await screen.findByText('Somewhere else')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Back to Notebooks' })).toBeNull();
    });

    it('"Add Documents" opens the picker, and is disabled with it while a batch runs', async () => {
      const request = deferred<Record<string, unknown>>();
      await renderWithUpload(vi.fn().mockReturnValue(request.promise));
      const input = screen.getByLabelText('Upload Documents') as HTMLInputElement;
      const open = vi.spyOn(input, 'click');

      fireEvent.click(screen.getByRole('button', { name: 'Add Documents' }));
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

    it('puts the Notebook title in the browser tab while open, and restores it on leaving', async () => {
      document.title = 'RAG Notebook';
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
      await waitFor(() => expect(document.title).toBe('Research – RAG Notebook'));

      await navigate('/elsewhere');
      await screen.findByText('Somewhere else');
      expect(document.title).toBe('RAG Notebook');
    });
  });

  // NBK-37: a user reading answers can hide the Documents panel and get it
  // back from the page header. Hidden means gone for assistive technology and
  // the keyboard too, not just out of sight, so the tests ask the
  // accessibility tree (role queries skip hidden content) rather than styles.
  describe('NBK-37: hiding the Documents panel', () => {
    const THREE = [documentFor('a.txt'), documentFor('b.txt'), documentFor('c.txt')];

    function hideDocumentsButton() {
      return within(documentsPanel()).getByRole('button', { name: 'Hide Documents' });
    }

    function showDocumentsButton() {
      return screen.queryByRole('button', { name: 'Show Documents' });
    }

    it('offers "Hide Documents" in the panel and no "Show Documents" while the panel is visible', async () => {
      await renderWithUpload(vi.fn(), THREE);

      expect(hideDocumentsButton()).toBeTruthy();
      expect(showDocumentsButton()).toBeNull();
    });

    it('"Hide Documents" hides the panel and offers "Show Documents" with the Document count', async () => {
      await renderWithUpload(vi.fn(), THREE);

      fireEvent.click(hideDocumentsButton());

      expect(screen.queryByRole('complementary', { name: 'Documents' })).toBeNull();
      expect(screen.queryByRole('list', { name: 'Documents' })).toBeNull();
      // Only the panel goes: the reader hid it to make room for these two.
      expect(screen.getByRole('navigation', { name: 'Chat Threads' })).toBeTruthy();
      expect(screen.getByRole('region', { name: 'Chat' })).toBeTruthy();
      const show = showDocumentsButton()!;
      expect(show).toBeTruthy();
      expect(show.textContent?.replace(/\s+/g, ' ').trim()).toBe('Documents 3');
    });

    it('"Show Documents" restores the panel, goes away, and focuses "Hide Documents"', async () => {
      await renderWithUpload(vi.fn(), THREE);
      fireEvent.click(hideDocumentsButton());

      fireEvent.click(showDocumentsButton()!);

      expect(screen.getByRole('complementary', { name: 'Documents' })).toBeTruthy();
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
