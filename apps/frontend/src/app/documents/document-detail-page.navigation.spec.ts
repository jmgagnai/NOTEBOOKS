import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular';
import { DocumentDetailPage } from './document-detail-page';
import { DOCUMENT_ID, SUMMARIZED_DETAIL } from './document-detail-page.spec-helpers';
import { AuthService } from '../api/services/auth.service';
import { ChatService } from '../api/services/chat.service';
import { DocumentsService } from '../api/services/documents.service';
import { NotebooksService } from '../api/services/notebooks.service';
import { ChatStore } from '../chat/chat.store';
import { SIGNED_IN, appEventsStub, thread } from '../chat/chat-panel.spec-helpers';
import { DocumentTransferService } from './document-transfer.service';
import { NotebookDetailPage } from '../notebooks/notebook-detail-page';
import {
  Elsewhere,
  NOTEBOOK_ID,
  RouterShell,
} from '../notebooks/notebook-detail-page.spec-helpers';
import { provideAppIcons } from '../shared/fluent-icons';

/**
 * Spec 08 (NBK-86): the open Chat Thread follows the reader between the
 * Notebook page and the Document page, both ways, through the real router —
 * which destroys one page before it creates the next, so this is the only
 * seam where carrying it over can be seen to work. Entering the Notebook
 * from anywhere else still opens its newest Chat Thread (NBK-43).
 */
describe('DocumentDetailPage — the open Chat Thread between pages', () => {
  const OLDER = thread({
    id: 'thread-old',
    title: 'Older questions',
    createdAt: '2026-01-01T00:00:00Z',
  });
  const NEWER = thread({
    id: 'thread-new',
    title: 'Newer questions',
    createdAt: '2026-02-01T00:00:00Z',
  });

  async function renderApp() {
    const rendered = await render(RouterShell, {
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
          useValue: {
            listDocuments: vi.fn().mockResolvedValue([]),
            getDocument: vi.fn().mockResolvedValue(SUMMARIZED_DETAIL),
          },
        },
        {
          provide: ChatService,
          useValue: {
            listChatThreads: vi.fn().mockResolvedValue([OLDER, NEWER]),
            listChatMessages: vi.fn().mockResolvedValue([]),
          },
        },
        { provide: DocumentTransferService, useValue: {} },
        {
          provide: AuthService,
          useValue: { getCurrentUser: vi.fn().mockResolvedValue(SIGNED_IN) },
        },
        appEventsStub().provider,
      ],
    });
    return rendered;
  }

  const openThreadTitle = (title: string) => screen.findByRole('heading', { name: title });

  it('keeps the Chat Thread open from the Notebook page to the Document and back', async () => {
    const { navigate } = await renderApp();
    await navigate(`/notebooks/${NOTEBOOK_ID}`);
    await openThreadTitle('Newer questions');
    // What clicking "Older questions" in the sidebar does.
    await TestBed.inject(ChatStore).openThread(NOTEBOOK_ID, 'thread-old');
    await openThreadTitle('Older questions');

    await navigate(`/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`);
    const chat = await screen.findByRole('region', { name: 'Chat' });
    expect(await within(chat).findByRole('heading', { name: 'Older questions' })).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Back to the Notebook' }));
    // Back on the Notebook page once the Document is gone. (Not the "Chat"
    // region: the Notebook page's middle pane carries that name too.)
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 1, name: 'Quarterly Report 2025' })).toBeNull(),
    );
    expect(await openThreadTitle('Older questions')).toBeTruthy();
  });

  it('opens the newest Chat Thread again when the Notebook is entered from elsewhere', async () => {
    const { navigate } = await renderApp();
    await navigate(`/notebooks/${NOTEBOOK_ID}`);
    await openThreadTitle('Newer questions');
    await TestBed.inject(ChatStore).openThread(NOTEBOOK_ID, 'thread-old');
    await openThreadTitle('Older questions');

    await navigate('/');
    await screen.findByText('Somewhere else');
    await navigate(`/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`);

    const chat = await screen.findByRole('region', { name: 'Chat' });
    expect(await within(chat).findByRole('heading', { name: 'Newer questions' })).toBeTruthy();
  });
});
