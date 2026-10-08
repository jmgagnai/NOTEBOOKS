import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { fireEvent, screen, waitFor, within } from '@testing-library/angular';
import {
  DOCUMENT_ID,
  FULL_MARKDOWN,
  NOTEBOOK_ID,
  SUMMARIZED_DETAIL,
  VERSION_ID,
  chatPane,
  renderRouted,
} from './document-detail-page.spec-helpers';
import { citation, message, thread } from '../chat/chat-panel.spec-helpers';

/**
 * Spec 08 (NBK-87): a Citation in the chat pane is followed inside the
 * Document page. To the Version on screen, it opens the full content at
 * the passage without reloading the page; to any other Document or
 * Version, it changes only the Document pane, the Chat Thread staying as it
 * is. Through the real router, which reuses the page for both rather than
 * creating another — the behaviour these tests exist for.
 */
describe('DocumentDetailPage — a Citation followed inside the page', () => {
  const OTHER_DOCUMENT_ID = '99999999-9999-9999-9999-999999999999';
  const OTHER_VERSION_ID = '88888888-8888-8888-8888-888888888888';
  const CITED = 'Revenue grew to 12.4M.';
  const FROM = FULL_MARKDOWN.indexOf(CITED);

  // One answer citing this Document's Version on screen [1] and another
  // Document [2].
  const ANSWER = message({
    id: 'a1',
    role: 'assistant',
    content: 'Revenue grew [1], and suppliers were reviewed [2].',
    citations: [
      citation({
        marker: 1,
        documentId: DOCUMENT_ID,
        documentVersionId: VERSION_ID,
        versionNumber: 2,
        filename: 'quarterly.pdf',
        charStart: FROM,
        charEnd: FROM + CITED.length,
      }),
      citation({
        id: 'citation-2',
        marker: 2,
        documentId: OTHER_DOCUMENT_ID,
        documentVersionId: OTHER_VERSION_ID,
        versionNumber: 1,
        filename: 'suppliers.pdf',
        charStart: 0,
        charEnd: 10,
      }),
    ],
  });

  const OTHER_VERSION_DETAIL = {
    documentId: OTHER_DOCUMENT_ID,
    notebookId: NOTEBOOK_ID,
    filename: 'suppliers.pdf',
    documentCreatedAt: '2026-01-01T00:00:00.000Z',
    version: {
      id: OTHER_VERSION_ID,
      versionNumber: 1,
      mimeType: 'application/pdf',
      sizeBytes: 50,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    status: 'ready',
    abstract: null,
    chatSnippet: null,
    executiveSummary: '## Suppliers\n\nTwo suppliers were reviewed.\n',
    metadata: { title: 'Supplier Review' },
    isLatestVersion: true,
    latestVersionNumber: 1,
  };

  function clients() {
    const documents = {
      getDocument: vi.fn().mockResolvedValue(SUMMARIZED_DETAIL),
      getDocumentVersion: vi.fn().mockResolvedValue(OTHER_VERSION_DETAIL),
      getDocumentVersionContent: vi.fn().mockImplementation(({ versionId }) =>
        Promise.resolve({
          versionId,
          markdown: versionId === VERSION_ID ? FULL_MARKDOWN : '# Suppliers\n\nAcme, Globex.\n',
        }),
      ),
    };
    const chat = {
      listChatThreads: vi.fn().mockResolvedValue([thread()]),
      listChatMessages: vi.fn().mockResolvedValue([ANSWER]),
    };
    return { documents, chat };
  }

  async function openTheDocumentBesideTheAnswer() {
    const { documents, chat } = clients();
    const { navigate } = await renderRouted(documents, chat as never);
    await navigate(`/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}`);
    await screen.findByRole('heading', { level: 1, name: 'Quarterly Report 2025' });
    await within(chatPane()).findByRole('link', { name: 'Citation 1' });
    return { documents, chat };
  }

  it('opens the full content at the cited passage, without reloading the Document', async () => {
    const { documents } = await openTheDocumentBesideTheAnswer();

    fireEvent.click(within(chatPane()).getByRole('link', { name: 'Citation 1' }));

    const cited = await screen.findByTestId('cited-passage');
    expect(cited.textContent).toContain(CITED);
    expect(documents.getDocument).toHaveBeenCalledTimes(1);
    expect(documents.getDocumentVersion).not.toHaveBeenCalled();
    expect(documents.getDocumentVersionContent).toHaveBeenCalledTimes(1);
    // The link is the URL, so back and copy-link reach this passage.
    expect(TestBed.inject(Router).url).toContain(`from=${FROM}`);
  });

  it('opens another Document in the Document pane, the Chat Thread staying open', async () => {
    const { chat } = await openTheDocumentBesideTheAnswer();

    fireEvent.click(within(chatPane()).getByRole('link', { name: 'Citation 2' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Supplier Review' })).toBeTruthy();
    expect(within(chatPane()).getByText('Revenue questions')).toBeTruthy();
    expect(chat.listChatMessages).toHaveBeenCalledTimes(1);
  });

  it('goes back to the Document it came from with the browser back button', async () => {
    await openTheDocumentBesideTheAnswer();
    fireEvent.click(within(chatPane()).getByRole('link', { name: 'Citation 2' }));
    await screen.findByRole('heading', { level: 1, name: 'Supplier Review' });

    TestBed.inject(Location).back();

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Quarterly Report 2025' })).toBeTruthy(),
    );
  });
});
