import { DeferBlockBehavior, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { of } from 'rxjs';
import { DocumentDetailPage } from './document-detail-page';
import { DocumentTransferService } from './document-transfer.service';
import { NotebookDetailPage } from '../notebooks/notebook-detail-page';
import { Elsewhere, RouterShell } from '../notebooks/notebook-detail-page.spec-helpers';
import { AuthService } from '../api/services/auth.service';
import { ChatService } from '../api/services/chat.service';
import { DocumentsService } from '../api/services/documents.service';
import { NotebooksService } from '../api/services/notebooks.service';
import { AuthStore } from '../auth/auth.store';
import { SIGNED_IN, appEventsStub, thread } from '../chat/chat-panel.spec-helpers';
import { provideAppIcons } from '../shared/fluent-icons';

// Shared by the Document page's area specs (CODING_STANDARDS.md, "Test
// helpers in a seam-3 spec").

export const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';
export const DOCUMENT_ID = '22222222-2222-2222-2222-222222222222';
export const VERSION_ID = '33333333-3333-3333-3333-333333333333';

// A Citation opens this page with the Document Version it pinned, the chunk
// it points at, that chunk's character range in the Converted Markdown and
// the Chat Thread it was cited in — see `citationParams`. The page follows
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
 * A chat client for a Notebook with no Chat Threads: what the chat pane
 * (spec 08, NBK-86) sees when a test is not about it.
 */
export function noChat(): Partial<ChatService> {
  return { listChatThreads: vi.fn().mockResolvedValue([]) as never };
}

/**
 * Renders the real page and its root stores, chat pane included, with only
 * the generated clients and the App Event stream stubbed: the seam every
 * Document page spec tests at. Signed in the way the auth guard signs the
 * app in, so the chat pane can ask.
 */
export async function renderPage(
  documentsService: Partial<DocumentsService>,
  route: ReturnType<typeof activatedRoute> = activatedRoute(),
  chatService: Partial<ChatService> = noChat(),
) {
  const appEvents = appEventsStub();
  const rendered = await render(DocumentDetailPage, {
    // An answer's Markdown renderer is a deferred block (NBK-52).
    deferBlockBehavior: DeferBlockBehavior.Playthrough,
    providers: [
      provideAppIcons(),
      route,
      { provide: DocumentsService, useValue: documentsService },
      { provide: ChatService, useValue: chatService },
      { provide: NotebooksService, useValue: { listNotebooks: vi.fn().mockResolvedValue([]) } },
      { provide: AuthService, useValue: { getCurrentUser: vi.fn().mockResolvedValue(SIGNED_IN) } },
      appEvents.provider,
    ],
  });
  await TestBed.inject(AuthStore).checkSession();
  return { ...rendered, appEvents };
}

/** The chat pane beside the Document (spec 08). */
export const chatPane = () => screen.getByRole('region', { name: 'Chat' });

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
 * The Document page and the Notebook page behind the real router, with a
 * page elsewhere to leave to: for what only navigation shows — the open
 * Chat Thread carried between pages, and a Citation followed inside the
 * page, which the router answers by reusing it rather than creating another.
 */
export async function renderRouted(
  documentsService: Partial<DocumentsService>,
  chatService: Partial<ChatService>,
) {
  const rendered = await render(RouterShell, {
    deferBlockBehavior: DeferBlockBehavior.Playthrough,
    routes: [
      { path: '', component: Elsewhere },
      { path: 'notebooks/:notebookId', component: NotebookDetailPage },
      { path: 'notebooks/:notebookId/documents/:documentId', component: DocumentDetailPage },
    ],
    providers: [
      provideAppIcons(),
      { provide: NotebooksService, useValue: { listNotebooks: vi.fn().mockResolvedValue([]) } },
      {
        provide: DocumentsService,
        useValue: { listDocuments: vi.fn().mockResolvedValue([]), ...documentsService },
      },
      { provide: ChatService, useValue: chatService },
      { provide: DocumentTransferService, useValue: {} },
      { provide: AuthService, useValue: { getCurrentUser: vi.fn().mockResolvedValue(SIGNED_IN) } },
      appEventsStub().provider,
    ],
  });
  await TestBed.inject(AuthStore).checkSession();
  return rendered;
}

/** A chat client for a Notebook holding those two Chat Threads, both empty. */
export function twoThreads(): Partial<ChatService> {
  return {
    listChatThreads: vi.fn().mockResolvedValue([OLDER_THREAD, NEWER_THREAD]) as never,
    listChatMessages: vi.fn().mockResolvedValue([]) as never,
  };
}

/**
 * What the Version-scoped read returns for an older Version of the fixture
 * Document — v1 of 2, superseded — with `overrides` on top: the shape a
 * followed Citation reads the page from.
 */
export function supersededVersionDetail(versionId: string, overrides: object = {}) {
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
    isLatestVersion: false,
    latestVersionNumber: 2,
    ...overrides,
  };
}
