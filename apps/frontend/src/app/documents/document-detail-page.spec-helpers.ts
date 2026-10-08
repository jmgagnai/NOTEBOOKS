import { DeferBlockBehavior, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { render } from '@testing-library/angular';
import { DocumentDetailPage } from './document-detail-page';
import { AuthService } from '../api/services/auth.service';
import { ChatService } from '../api/services/chat.service';
import { DocumentsService } from '../api/services/documents.service';
import { NotebooksService } from '../api/services/notebooks.service';
import { AuthStore } from '../auth/auth.store';
import { SIGNED_IN, appEventsStub } from '../chat/chat-panel.spec-helpers';
import { provideAppIcons } from '../shared/fluent-icons';

// Shared by the Document page's area specs (CODING_STANDARDS.md, "Test
// helpers in a seam-3 spec").

export const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';
export const DOCUMENT_ID = '22222222-2222-2222-2222-222222222222';
export const VERSION_ID = '33333333-3333-3333-3333-333333333333';

// A Citation opens this page with the Document Version it pinned, the chunk
// it points at and that chunk's character range in the Converted Markdown —
// see `ThreadView.citationParams`.
export function activatedRoute(queryParams: Record<string, string> = {}) {
  return {
    provide: ActivatedRoute,
    useValue: {
      snapshot: {
        paramMap: convertToParamMap({ notebookId: NOTEBOOK_ID, documentId: DOCUMENT_ID }),
        queryParamMap: convertToParamMap(queryParams),
      },
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
