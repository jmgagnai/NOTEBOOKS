import { DeferBlockBehavior, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { render } from '@testing-library/angular';
import { of } from 'rxjs';
import { DocumentDetailPage } from './document-detail-page';
import { DocumentTransferService } from './document-transfer.service';
import { NotebookDetailPage } from '../notebooks/notebook-detail-page';
import { Elsewhere, RouterShell } from '../notebooks/notebook-detail-page.spec-helpers';
import { AuthService } from '../api/services/auth.service';
import { ChatService } from '../api/services/chat.service';
import { DocumentsService } from '../api/services/documents.service';
import { NotebooksService } from '../api/services/notebooks.service';
import { SearchService } from '../api/services/search.service';
import { SearchPage } from '../search/search-page';
import { AuthStore } from '../auth/auth.store';
import { SIGNED_IN, appEventsStub, thread } from '../chat/chat-panel.spec-helpers';
import { provideAppIcons } from '../shared/fluent-icons';
import { answeringLater } from '../shared/answer-later.spec-helpers';

// Shared by the Document page's area specs (CODING_STANDARDS.md, "Test
// helpers in a seam-3 spec").

export const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';
export const DOCUMENT_ID = '22222222-2222-2222-2222-222222222222';
export const VERSION_ID = '33333333-3333-3333-3333-333333333333';

// A Citation opens this page with the Document Version it pinned, the chunk
// it points at and that chunk's character range in the Converted Markdown
// — see `citationParams`. The page follows
// the route as it changes, so the stub offers it as observables too; one
// that never changes, which is what a page opened directly sees.
export function activatedRoute(queryParams: Record<string, string> = {}) {
  const paramMap = convertToParamMap({ notebookId: NOTEBOOK_ID, documentId: DOCUMENT_ID });
  const queryParamMap = convertToParamMap(queryParams);
  return {
    provide: ActivatedRoute,
    useValue: {
      snapshot: { paramMap, queryParamMap },
      paramMap: of(paramMap),
      queryParamMap: of(queryParamMap),
    },
  };
}

export const SUMMARIZED_DETAIL = {
  id: DOCUMENT_ID,
  notebookId: NOTEBOOK_ID,
  filename: 'quarterly.pdf',
  status: 'summarized',
  abstract: 'A short Abstract for lists.',
  chatSnippet: 'A dense Chat Snippet for the model.',
  executiveSummary:
    '## Key points\n\n- Revenue grew 18% year on year.\n- Supply-chain risk remains the main exposure.\n',
  metadata: { title: 'Quarterly Report 2025', authors: ['A. Analyst'], documentType: 'report' },
  createdAt: '2026-01-01T00:00:00.000Z',
  latestVersion: {
    id: VERSION_ID,
    versionNumber: 2,
    mimeType: 'application/pdf',
    sizeBytes: 100,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
};

export const FULL_MARKDOWN = [
  '# Quarterly Report 2025',
  '',
  '## Revenue',
  '',
  'Revenue grew to 12.4M.',
  '',
  '| Quarter | Total |',
  '| --- | --- |',
  '| Q1 | 12.4M |',
  '',
].join('\n');

/**
 * A chat client for a Notebook with no Chat Threads, for the routed Notebook
 * page when a test is not about chat. The Document page itself asks nothing
 * of it, but keeps the root Chat store for the way back (NBK-103).
 */
export function noChat(): Partial<ChatService> {
  return { listChatThreads: vi.fn().mockResolvedValue([]) as never };
}

/**
 * Renders the real page and its root stores, with only the generated
 * clients and the App Event stream stubbed: the seam every Document page
 * spec tests at. Signed in the way the auth guard signs the app in.
 */
export async function renderPage(
  documentsService: Partial<DocumentsService>,
  route: ReturnType<typeof activatedRoute> = activatedRoute(),
) {
  const appEvents = appEventsStub();
  const rendered = await render(DocumentDetailPage, {
    providers: [
      provideAppIcons(),
      route,
      { provide: DocumentsService, useValue: answeringLater(documentsService) },
      { provide: ChatService, useValue: answeringLater(noChat()) },
      { provide: NotebooksService, useValue: { listNotebooks: vi.fn().mockResolvedValue([]) } },
      { provide: AuthService, useValue: { getCurrentUser: vi.fn().mockResolvedValue(SIGNED_IN) } },
      appEvents.provider,
    ],
  });
  await TestBed.inject(AuthStore).checkSession();
  return { ...rendered, appEvents };
}

/** Two Chat Threads of the Notebook, the newer one opened by default (NBK-43). */
export const OLDER_THREAD = thread({
  id: 'thread-old',
  title: 'Older questions',
  createdAt: '2026-01-01T00:00:00Z',
});
export const NEWER_THREAD = thread({
  id: 'thread-new',
  title: 'Newer questions',
  createdAt: '2026-02-01T00:00:00Z',
});

/**
 * The Document page, the Notebook page and the Search page behind the real
 * router, with a page elsewhere to leave to: for what only navigation shows
 * — the open Chat Thread carried between pages, where the back arrow goes
 * (NBK-103), and a Citation link followed on the open page, which the
 * router answers by reusing it rather than creating another.
 */
export async function renderRouted(
  documentsService: Partial<DocumentsService>,
  chatService: Partial<ChatService>,
  searchService: Record<string, unknown> = {},
) {
  const appEvents = appEventsStub();
  const rendered = await render(RouterShell, {
    deferBlockBehavior: DeferBlockBehavior.Playthrough,
    routes: [
      { path: '', component: Elsewhere },
      { path: 'notebooks/:notebookId', component: NotebookDetailPage },
      { path: 'notebooks/:notebookId/search', component: SearchPage },
      { path: 'notebooks/:notebookId/documents/:documentId', component: DocumentDetailPage },
    ],
    providers: [
      provideAppIcons(),
      { provide: NotebooksService, useValue: { listNotebooks: vi.fn().mockResolvedValue([]) } },
      {
        provide: DocumentsService,
        useValue: answeringLater({
          listDocuments: vi.fn().mockResolvedValue([]),
          ...documentsService,
        }),
      },
      { provide: ChatService, useValue: answeringLater(chatService) },
      { provide: SearchService, useValue: answeringLater(searchService) },
      { provide: DocumentTransferService, useValue: {} },
      { provide: AuthService, useValue: { getCurrentUser: vi.fn().mockResolvedValue(SIGNED_IN) } },
      appEvents.provider,
    ],
  });
  await TestBed.inject(AuthStore).checkSession();
  return { ...rendered, appEvents };
}

/** A chat client for a Notebook holding those two Chat Threads, both empty. */
export function twoThreads(): Partial<ChatService> {
  return {
    listChatThreads: vi.fn().mockResolvedValue([OLDER_THREAD, NEWER_THREAD]) as never,
    listChatMessages: vi.fn().mockResolvedValue([]) as never,
  };
}

/**
 * What the Version-scoped read returns for a Version of the fixture
 * Document, with `overrides` on top: v1, latest unless overridden.
 */
export function versionDetail(versionId: string, overrides: object = {}) {
  return {
    documentId: DOCUMENT_ID,
    notebookId: NOTEBOOK_ID,
    filename: 'quarterly.pdf',
    documentCreatedAt: '2026-01-01T00:00:00.000Z',
    version: {
      id: versionId,
      versionNumber: 1,
      mimeType: 'application/pdf',
      sizeBytes: 90,
      createdAt: '2025-12-01T00:00:00.000Z',
    },
    status: 'ready',
    abstract: null,
    chatSnippet: null,
    executiveSummary: null,
    metadata: null,
    isLatestVersion: true,
    latestVersionNumber: 1,
    ...overrides,
  };
}

/**
 * The same for an older Version — v1 of 2, superseded: the shape a followed
 * Citation reads the page from.
 */
export function supersededVersionDetail(versionId: string, overrides: object = {}) {
  return versionDetail(versionId, { isLatestVersion: false, latestVersionNumber: 2, ...overrides });
}
