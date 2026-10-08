import { Component } from '@angular/core';
import { convertToParamMap, ActivatedRoute, RouterOutlet } from '@angular/router';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { NotebookDetailPage } from './notebook-detail-page';
import { NotebooksService } from '../api/services/notebooks.service';
import { ChatService } from '../api/services/chat.service';
import { DocumentsService } from '../api/services/documents.service';
import { DocumentTransferService } from '../documents/document-transfer.service';
import { AppEvent, AppEventsService } from '../events/app-events.service';
import { provideAppIcons } from '../shared/fluent-icons';

export const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';

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
export class RouterShell {}

/** Any other page of the app, to navigate away to. */
@Component({ selector: 'app-elsewhere', standalone: true, template: '<p>Somewhere else</p>' })
export class Elsewhere {}

export function activatedRouteFor(notebookId: string) {
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
export function chatServiceStub() {
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
export function appEventsStub() {
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
export function pageProviders({
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

export function documentFor(filename: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: `doc-${filename}`,
    notebookId: NOTEBOOK_ID,
    filename,
    status: 'queued',
    failure: null,
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
export function versionOf(filename: string, mimeType: string) {
  return {
    id: `v-${filename}-1`,
    versionNumber: 1,
    mimeType,
    sizeBytes: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A promise the test resolves or rejects by hand, to hold a request "in flight". */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An upload client whose every request stays in flight until the test settles it. */
export function heldUploads() {
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
export const RESEARCH = {
  id: NOTEBOOK_ID,
  title: 'Research',
  createdAt: '2026-01-01T00:00:00.000Z',
};

/**
 * The page on its Notebook, listing `existing`, with `uploadDocument` as the
 * upload client. The header tests (NBK-35) name the `notebook` so the title
 * shows, and hand over `renameNotebook` as the rename client; both are
 * waited for, since the title lands after the Document list.
 */
export async function renderWithUpload(
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
  if (notebook) await landingTitle(notebook.title);
  return result;
}

/**
 * The Notebook title on the landing (NBK-81): the Notebook has no Chat
 * Threads here, so the Chat region is the landing. Scoped to it because the
 * page header shows the same title button until NBK-82 removes the header.
 */
export async function landingTitle(title: string) {
  const heading = await within(elsewhereOnThePage()).findByRole('heading', { name: title });
  return within(heading).getByRole('button', { name: title });
}

/** Opens the landing's "Research" title for editing and types `title` into it. */
export async function typeTitle(title: string) {
  fireEvent.click(await landingTitle(RESEARCH.title));
  const input = screen.getByLabelText('Notebook title') as HTMLInputElement;
  expect(input.value).toBe(RESEARCH.title);
  fireEvent.input(input, { target: { value: title } });
  return input;
}

/** A one-byte file, when only its name matters. */
export function fileNamed(name: string) {
  return new File(['x'], name);
}

/** Selects `files` in the picker. */
export function pick(files: File[]) {
  const input = screen.getByLabelText('Upload Documents') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
  return input;
}

/** The filenames `uploadDocument` was asked to send, in order. */
export function sentNames(uploadDocument: ReturnType<typeof vi.fn>) {
  return uploadDocument.mock.calls.map(([, file]) => (file as File).name);
}

/** The progress panel's row for `filename`. */
export function panelRow(filename: string) {
  const panel = screen.getByRole('list', { name: 'Upload progress' });
  return within(panel)
    .getAllByRole('listitem')
    .find((row) => within(row).queryByText(filename) !== null)!;
}

// Document row helpers (NBK-42): the Documents list is one row per Document,
// with Open, Download and Delete behind the row's "…" menu.

/** The Documents list's row for `filename`. */
export function documentRow(filename: string) {
  const list = screen.getByRole('list', { name: 'Documents' });
  return within(list)
    .getAllByRole('listitem')
    .find((row) => within(row).queryByText(filename) !== null)!;
}

/** The row's link: the one Tab stop of a row, named by its filename. */
export function rowLink(filename: string) {
  return within(documentRow(filename)).getByRole('link', { name: new RegExp(filename) });
}

/** Opens the row's "…" menu and returns its `action` item, named "<action> <filename>". */
export async function rowMenuItem(filename: string, action: 'Open' | 'Download' | 'Delete') {
  fireEvent.click(
    within(documentRow(filename)).getByRole('button', { name: `Actions for ${filename}` }),
  );
  return screen.findByRole('menuitem', { name: `${action} ${filename}` });
}

// Drag-and-drop helpers (NBK-18, NBK-36), at module scope because NBK-37's
// hidden panel has to come back for a drag too.
/** A dropped folder: what a file manager hands over for a directory. */
export interface Folder {
  folder: string;
}

/**
 * A DataTransfer as a drop of `entries` would carry it. A folder arrives
 * as an item whose entry `isDirectory`, backed by a size-0 File named
 * after it — which is what Chromium and Firefox actually put in `files`.
 */
export function dataTransferOf(entries: (File | Folder)[]) {
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
export function documentsPanel() {
  return screen.getByRole('complementary', { name: 'Documents' });
}

/** Somewhere else on the page, for a drag moving between its elements. */
export function elsewhereOnThePage() {
  return screen.getByRole('region', { name: 'Chat' });
}

export const DROP_HINT = 'Drop files to upload them into this Notebook';
export const DRAG_OVER = 'notebook-detail-page__panel--drag-over';

/** Whether files dragged over the page light up the Documents panel, and only it. */
export function highlightsDocumentsPanel() {
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
