import { Location } from '@angular/common';
import { ApplicationRef } from '@angular/core';
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
 * Document page. To the Version on screen, it opens the full Converted
 * Markdown at the cited Chunk without reading the Document again; to any
 * other Document or Version, it changes only the Document pane, the Chat
 * Thread staying as it is. Through the real router, which reuses the page
 * for both rather than creating another — the behaviour these tests exist
 * for.
 */
describe('DocumentDetailPage — a Citation followed inside the page', () => {
  const OTHER_DOCUMENT_ID = '99999999-9999-9999-9999-999999999999';
  const OTHER_VERSION_ID = '88888888-8888-8888-8888-888888888888';
  const CITED = 'Revenue grew to 12.4M.';
  const FROM = FULL_MARKDOWN.indexOf(CITED);

  // One answer citing this Document's Version on screen [1], another
  // Document [2], and this Document's superseded v1 [3].
  const OLD_VERSION_ID = '77777777-7777-7777-7777-777777777777';
  const ANSWER = message({
    id: 'a1',
    role: 'assistant',
    content: 'Revenue grew [1], suppliers were reviewed [2], and it was 11% before [3].',
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
      citation({
        id: 'citation-3',
        marker: 3,
        chunkId: 'chunk-3',
        documentId: DOCUMENT_ID,
        documentVersionId: OLD_VERSION_ID,
        versionNumber: 1,
        filename: 'quarterly.pdf',
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

  // What the Version-scoped read returns for this Document's superseded v1.
  const OLD_VERSION_DETAIL = {
    ...OTHER_VERSION_DETAIL,
    documentId: DOCUMENT_ID,
    filename: 'quarterly.pdf',
    version: { ...OTHER_VERSION_DETAIL.version, id: OLD_VERSION_ID },
    executiveSummary: '## Key points\n\n- Revenue grew 11% year on year.\n',
    metadata: { title: 'Quarterly Report 2024' },
    isLatestVersion: false,
    latestVersionNumber: 2,
  };

  const versionDetail = ({ versionId }: { versionId: string }) =>
    Promise.resolve(versionId === OLD_VERSION_ID ? OLD_VERSION_DETAIL : OTHER_VERSION_DETAIL);

  function clients() {
    const documents = {
      getDocument: vi.fn().mockResolvedValue(SUMMARIZED_DETAIL),
      getDocumentVersion: vi.fn().mockImplementation(versionDetail),
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

  it('opens the full Converted Markdown at the cited Chunk, without reading the Document again', async () => {
    const { documents } = await openTheDocumentBesideTheAnswer();

    fireEvent.click(within(chatPane()).getByRole('link', { name: 'Citation 1' }));

    const cited = await screen.findByTestId('cited-passage');
    expect(cited.textContent).toContain(CITED);
    expect(documents.getDocument).toHaveBeenCalledTimes(1);
    expect(documents.getDocumentVersion).not.toHaveBeenCalled();
    expect(documents.getDocumentVersionContent).toHaveBeenCalledTimes(1);
    // The link is the URL, so back and copy-link reach this Chunk.
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

  it('opens another Version of this Document in the Document pane', async () => {
    const { chat } = await openTheDocumentBesideTheAnswer();

    fireEvent.click(within(chatPane()).getByRole('link', { name: 'Citation 3' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Quarterly Report 2024' }),
    ).toBeTruthy();
    expect(screen.getByTestId('cited-version-notice')).toBeTruthy();
    expect(chat.listChatMessages).toHaveBeenCalledTimes(1);
  });

  it('opens the latest Version again on going back to the plain Document link', async () => {
    const { documents } = await openTheDocumentBesideTheAnswer();
    fireEvent.click(within(chatPane()).getByRole('link', { name: 'Citation 3' }));
    await screen.findByRole('heading', { level: 1, name: 'Quarterly Report 2024' });

    TestBed.inject(Location).back();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Quarterly Report 2025' }),
    ).toBeTruthy();
    expect(screen.queryByTestId('cited-version-notice')).toBeNull();
    expect(documents.getDocument).toHaveBeenCalledTimes(2);
  });

  it('opens the cited Chunk again when its Citation is followed after hiding it', async () => {
    await openTheDocumentBesideTheAnswer();
    fireEvent.click(within(chatPane()).getByRole('link', { name: 'Citation 1' }));
    await screen.findByTestId('cited-passage');

    fireEvent.click(screen.getByRole('button', { name: 'Hide the full Document' }));
    expect(screen.queryByTestId('cited-passage')).toBeNull();
    fireEvent.click(within(chatPane()).getByRole('link', { name: 'Citation 1' }));

    expect(await screen.findByTestId('cited-passage')).toBeTruthy();
  });

  it('shows the Citation followed last when an earlier one answers after it', async () => {
    const { documents } = await openTheDocumentBesideTheAnswer();
    let answerLate!: (detail: unknown) => void;
    documents.getDocumentVersion.mockImplementationOnce(
      () => new Promise((resolve) => (answerLate = resolve)),
    );

    fireEvent.click(within(chatPane()).getByRole('link', { name: 'Citation 2' }));
    await waitFor(() => expect(documents.getDocumentVersion).toHaveBeenCalledTimes(1));
    fireEvent.click(within(chatPane()).getByRole('link', { name: 'Citation 3' }));
    await screen.findByRole('heading', { level: 1, name: 'Quarterly Report 2024' });
    answerLate(OTHER_VERSION_DETAIL);
    // Long enough for the late answer to land and render, had it been let in.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await TestBed.inject(ApplicationRef).whenStable();

    expect(screen.getByRole('heading', { level: 1, name: 'Quarterly Report 2024' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Supplier Review' })).toBeNull();
  });

  it('fetches a Version once when its Citation is followed while it is still arriving', async () => {
    const { documents } = clients();
    let deliver!: (content: unknown) => void;
    documents.getDocumentVersionContent.mockImplementationOnce(
      () => new Promise((resolve) => (deliver = resolve)),
    );
    documents.getDocumentVersion.mockResolvedValue({
      ...OTHER_VERSION_DETAIL,
      documentId: DOCUMENT_ID,
      filename: 'quarterly.pdf',
      version: { ...OTHER_VERSION_DETAIL.version, id: VERSION_ID, versionNumber: 2 },
      metadata: { title: 'Quarterly Report 2025' },
      latestVersionNumber: 2,
    });
    const { navigate } = await renderRouted(documents, clients().chat as never);
    await navigate(
      `/notebooks/${NOTEBOOK_ID}/documents/${DOCUMENT_ID}?version=${VERSION_ID}&from=0&to=5`,
    );
    await waitFor(() => expect(documents.getDocumentVersionContent).toHaveBeenCalledTimes(1));

    fireEvent.click(await within(chatPane()).findByRole('link', { name: 'Citation 1' }));
    // Followed — the page has the Citation's link — before the first fetch answers.
    await waitFor(() => expect(TestBed.inject(Router).url).toContain(`from=${FROM}`));
    deliver({ versionId: VERSION_ID, markdown: FULL_MARKDOWN });

    // The mark moves from the link's first range to this Citation's.
    await waitFor(() => expect(screen.getByTestId('cited-passage').textContent).toContain(CITED));
    expect(documents.getDocumentVersionContent).toHaveBeenCalledTimes(1);
  });
});
