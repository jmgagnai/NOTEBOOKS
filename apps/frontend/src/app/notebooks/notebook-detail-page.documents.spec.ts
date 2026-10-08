import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular';
import { NotebookDetailPage } from './notebook-detail-page';
import {
  NOTEBOOK_ID,
  RouterShell,
  Elsewhere,
  appEventsStub,
  pageProviders,
  documentFor,
  versionOf,
  deferred,
  renderWithUpload,
  fileNamed,
  pick,
  sentNames,
  documentRow,
  rowLink,
  rowMenuItem,
  documentsPanel,
} from './notebook-detail-page.spec-helpers';
import { tooltipOf } from '../chat/chat-panel.spec-helpers';

describe('NotebookDetailPage — Documents panel', () => {
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

    // NBK-64: the sentence is the failure reason's, so the user knows what
    // to do next; the wording is spec NBK-63's.
    it('marks a scanned PDF with a warning that says it has no selectable text', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('scan.pdf', {
          status: 'failed',
          failure: { reason: 'no-text-layer', failedAt: 'converting' },
        }),
      ]);

      const row = documentRow('scan.pdf');
      const warning = within(row).getByRole('img', {
        name: 'Ingestion failed',
        description:
          'This PDF has no selectable text (it looks like a scan). Upload a PDF whose text can be selected.',
      });
      expect(warning).toBeTruthy();
      expect(within(row).queryByRole('progressbar')).toBeNull();
      expect(within(row).queryByText('Failed')).toBeNull();
    });

    it('marks an unexplained failure with a warning that owns up to it', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('broken.pdf', {
          status: 'failed',
          failure: { reason: 'unexpected', failedAt: null },
        }),
      ]);

      const warning = within(documentRow('broken.pdf')).getByRole('img', {
        name: 'Ingestion failed',
        description: 'Something went wrong on our side while ingesting this Document.',
      });
      expect(warning).toBeTruthy();
    });

    // Spec NBK-63 story 7: which part of Ingestion failed, where that helps —
    // an unexplained failure and a timeout say which step it was.
    it.each([
      [
        { reason: 'unexpected', failedAt: 'converting' },
        'Something went wrong on our side while converting this Document.',
      ],
      [
        { reason: 'unexpected', failedAt: 'summarizing' },
        'Something went wrong on our side while summarizing this Document.',
      ],
      [
        { reason: 'unexpected', failedAt: 'indexing' },
        'Something went wrong on our side while indexing this Document.',
      ],
      [
        { reason: 'timed-out', failedAt: 'converting' },
        'Converting this file took too long. Try a smaller file, or split it.',
      ],
      [
        { reason: 'timed-out', failedAt: 'summarizing' },
        'Summarizing this file took too long. Try a smaller file, or split it.',
      ],
      [
        { reason: 'timed-out', failedAt: null },
        'Converting this file took too long. Try a smaller file, or split it.',
      ],
    ] as const)('names the step in the warning for %j', async (failure, description) => {
      await renderWithUpload(vi.fn(), [
        documentFor('step.pdf', { status: 'failed', failure: { ...failure } }),
      ]);

      expect(
        within(documentRow('step.pdf')).getByRole('img', { name: 'Ingestion failed', description }),
      ).toBeTruthy();
    });

    // NBK-67: a user watching an upload learns why it failed the moment it
    // does, and a reason never outlives the failure it explained.
    it('takes the failure reason from the status App Event and drops it once the Version moves on', async () => {
      const appEvents = appEventsStub();
      const scan = documentFor('live-scan.pdf', { status: 'converting' });
      await render(NotebookDetailPage, {
        providers: pageProviders({
          documents: { listDocuments: vi.fn().mockResolvedValue([scan]) },
          appEvents,
        }),
      });
      await screen.findByText('live-scan.pdf');
      const announce = (status: string, failure?: unknown) =>
        appEvents.events.next({
          id: `event-${status}`,
          type: 'document-version-status-changed',
          topic: `notebook:${NOTEBOOK_ID}`,
          occurredAt: '2026-01-01T00:00:01.000Z',
          data: {
            documentId: scan.id,
            versionId: scan.latestVersion.id,
            status,
            ...(failure ? { failure } : {}),
          },
        });

      announce('failed', { reason: 'no-text-layer', failedAt: 'converting' });
      expect(
        await within(documentRow('live-scan.pdf')).findByRole('img', {
          name: 'Ingestion failed',
          description:
            'This PDF has no selectable text (it looks like a scan). Upload a PDF whose text can be selected.',
        }),
      ).toBeTruthy();

      announce('queued');
      await waitFor(() =>
        expect(
          within(documentRow('live-scan.pdf')).queryByRole('img', { name: 'Ingestion failed' }),
        ).toBeNull(),
      );

      // A failure announced without a reason must not resurrect the earlier
      // one: the scan sentence would tell the user to fix the wrong thing.
      announce('failed');
      expect(
        await within(documentRow('live-scan.pdf')).findByRole('img', {
          name: 'Ingestion failed',
          description: 'Something went wrong on our side while ingesting this Document.',
        }),
      ).toBeTruthy();
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

    // One popover, not a native `title` on top of the Abstract's (NBK-47):
    // the filename the row truncates is that popover's first line.
    it('shows the full filename on hover, as the first line of the Abstract popover', async () => {
      const long = 'a-very-long-quarterly-report-name-that-will-not-fit-the-panel.pdf';
      await renderWithUpload(vi.fn(), [documentFor(long, { abstract: 'Revenue by region.' })]);

      expect(documentRow(long).querySelector('[title]')).toBeNull();
      fireEvent.mouseEnter(rowLink(long));
      await waitFor(() =>
        expect(document.querySelector('mat-tooltip-component')?.textContent?.trim()).toBe(
          `${long}\nRevenue by region.`,
        ),
      );
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
      const open = rowLink('report.txt');
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

    // Spec 03 story 21: the list is one Tab stop, "…" buttons included —
    // ArrowRight reaches a row's "…" from its link and ArrowLeft goes back.
    it('reaches the "…" button with ArrowRight from its row, without a Tab stop of its own', async () => {
      await renderWithUpload(vi.fn(), [documentFor('a.txt'), documentFor('b.txt')]);
      const more = (filename: string) =>
        within(documentRow(filename)).getByRole('button', { name: `Actions for ${filename}` });

      expect(['a.txt', 'b.txt'].map((name) => more(name).tabIndex)).toEqual([-1, -1]);

      rowLink('b.txt').focus();
      fireEvent.keyDown(rowLink('b.txt'), { key: 'ArrowRight' });
      expect(document.activeElement).toBe(more('b.txt'));

      fireEvent.keyDown(more('b.txt'), { key: 'ArrowLeft' });
      expect(document.activeElement).toBe(rowLink('b.txt'));
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
      // The Abstract is no longer on the row (NBK-42); it is the row's
      // popover and description now (NBK-47), which live outside the list.
      expect(
        within(screen.getByRole('list', { name: 'Documents' })).queryByText(
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

  // NBK-48: the panel header says how big the Notebook is and how much of it
  // is ready, and a quick filter narrows the rows by filename — client-side,
  // so it is told apart from "Search this Notebook" by never reaching the API.
  describe('NBK-48: count and filter', () => {
    function panelCount() {
      return within(documentsPanel()).getByTestId('documents-count').textContent?.trim();
    }

    it('the panel header reads "<n> Documents" when every Document is ready', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('a.txt', { status: 'ready' }),
        documentFor('b.txt', { status: 'ready' }),
      ]);
      expect(panelCount()).toBe('2 Documents');
    });

    // A failed Document is not on its way to ready: its row carries the
    // warning, and the count no longer reads as work in progress.
    it('reads "<n> Documents" when nothing is ingesting, even with a failed Document', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('a.txt', { status: 'ready' }),
        documentFor('b.txt', { status: 'failed' }),
      ]);
      expect(panelCount()).toBe('2 Documents');
    });

    it('reads "<ready>/<n> ready" while some are ingesting, and moves with App Events', async () => {
      const appEvents = appEventsStub();
      const listDocuments = vi
        .fn()
        .mockResolvedValue([
          documentFor('a.txt', { status: 'ready' }),
          documentFor('b.txt', { status: 'indexing' }),
          documentFor('c.txt', { status: 'failed' }),
        ]);
      await render(NotebookDetailPage, {
        providers: pageProviders({ documents: { listDocuments }, appEvents }),
      });
      await screen.findByText('a.txt');
      expect(panelCount()).toBe('1/3 ready');

      appEvents.events.next({
        id: 'event-1',
        type: 'document-version-status-changed',
        topic: `notebook:${NOTEBOOK_ID}`,
        occurredAt: '2026-01-01T00:00:01.000Z',
        data: { documentId: 'doc-b.txt', versionId: 'v-b.txt-1', status: 'ready' },
      });

      // b.txt was the last one ingesting; c.txt's failure is its row's to show.
      await waitFor(() => expect(panelCount()).toBe('3 Documents'));
      expect(listDocuments).toHaveBeenCalledTimes(1);
    });

    // Spec 02 / NBK-37: "Show Documents" carries the plain number, whatever
    // is still ingesting; the ready line is the panel's. An icon button since
    // NBK-82 (spec 07), so the number moved into its tooltip.
    it('"Show Documents" tells the Document count only, in its tooltip', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('a.txt', { status: 'ready' }),
        documentFor('b.txt', { status: 'queued' }),
      ]);
      expect(panelCount()).toBe('1/2 ready');

      fireEvent.click(within(documentsPanel()).getByRole('button', { name: 'Hide Documents' }));

      const show = screen.getByRole('button', { name: 'Show Documents' });
      expect(await tooltipOf(show)).toBe('Show Documents (2)');
    });

    const LIBRARY = [
      documentFor('Thesis draft.pdf', { status: 'ready' }),
      documentFor('thesis-notes.txt', { status: 'ready' }),
      documentFor('budget.xlsx', { status: 'ready' }),
    ];

    function filterBox() {
      return within(documentsPanel()).getByRole('searchbox', {
        name: 'Filter Documents',
      }) as HTMLInputElement;
    }

    function shownFilenames() {
      const list = within(documentsPanel()).queryByRole('list', { name: 'Documents' });
      if (!list) return [];
      return within(list)
        .getAllByRole('listitem')
        .map((row) =>
          LIBRARY.map((d) => d.filename).find((name) => row.textContent?.includes(name)),
        );
    }

    it('"Filter Documents" narrows the rows to filenames containing the text, ignoring case', async () => {
      await renderWithUpload(vi.fn(), LIBRARY);

      fireEvent.input(filterBox(), { target: { value: 'THESIS' } });

      expect(shownFilenames()).toEqual(['Thesis draft.pdf', 'thesis-notes.txt']);
      // The header still counts the Notebook, not the filtered rows.
      expect(panelCount()).toBe('3 Documents');
    });

    it('the clear control empties the filter and restores the full list', async () => {
      await renderWithUpload(vi.fn(), LIBRARY);
      expect(within(documentsPanel()).queryByRole('button', { name: 'Clear filter' })).toBeNull();
      fireEvent.input(filterBox(), { target: { value: 'budget' } });
      expect(shownFilenames()).toEqual(['budget.xlsx']);

      fireEvent.click(within(documentsPanel()).getByRole('button', { name: 'Clear filter' }));

      expect(filterBox().value).toBe('');
      expect(shownFilenames()).toEqual(['Thesis draft.pdf', 'thesis-notes.txt', 'budget.xlsx']);
    });

    it('says "No Documents match" when nothing matches', async () => {
      await renderWithUpload(vi.fn(), LIBRARY);

      fireEvent.input(filterBox(), { target: { value: 'invoice' } });

      expect(shownFilenames()).toEqual([]);
      expect(within(documentsPanel()).getByText('No Documents match')).toBeTruthy();
    });

    // The filter box goes with the last Document, so a filter left in it
    // would be invisible — and would hide whatever arrives next.
    it('forgets the filter when the list empties, so the next Document shows', async () => {
      await render(NotebookDetailPage, {
        providers: pageProviders({
          documents: {
            listDocuments: vi.fn().mockResolvedValue([documentFor('report.txt')]),
            deleteDocument: vi.fn().mockResolvedValue(null),
          },
          transfer: {
            uploadDocument: vi.fn().mockResolvedValue(documentFor('budget.xlsx')),
          },
        }),
      });
      await screen.findByText('report.txt');
      fireEvent.input(filterBox(), { target: { value: 'report' } });

      fireEvent.click(await rowMenuItem('report.txt', 'Delete'));
      await screen.findByText('No Documents yet.');
      pick([fileNamed('budget.xlsx')]);

      expect(await within(documentsPanel()).findByText('budget.xlsx')).toBeTruthy();
      expect(within(documentsPanel()).queryByText('No Documents match')).toBeNull();
      expect(filterBox().value).toBe('');
    });

    it('filters without any request: the list fetched on arrival is all it reads', async () => {
      const listDocuments = vi.fn().mockResolvedValue(LIBRARY);
      // Only `listDocuments` exists on the stubbed clients, so any other call —
      // a search, a refetch per keystroke — would throw or be counted here.
      await render(NotebookDetailPage, {
        providers: pageProviders({ documents: { listDocuments } }),
      });
      await screen.findByText('budget.xlsx');

      fireEvent.input(filterBox(), { target: { value: 'b' } });
      fireEvent.input(filterBox(), { target: { value: 'bu' } });

      expect(shownFilenames()).toEqual(['budget.xlsx']);
      expect(listDocuments).toHaveBeenCalledTimes(1);
    });
  });

  // NBK-47 (spec 03 "Abstract popover"): the Abstract NBK-42 took off the
  // row comes back one gesture away, on hover of the filename or keyboard
  // focus of the row, without the row growing.
  describe('NBK-47: Abstract popover', () => {
    const ABSTRACT = 'A quarterly report covering revenue growth across three regions.';

    /**
     * What the popover on screen says below its first line (the filename,
     * NBK-42), or null when none is showing.
     */
    function popoverText() {
      const text = document.querySelector('mat-tooltip-component')?.textContent?.trim();
      return text === undefined ? null : text.split('\n').slice(1).join('\n');
    }

    /** Focuses `link` the way Tab does, so the focus counts as the keyboard's. */
    function tabTo(link: HTMLElement) {
      fireEvent.keyDown(document.body, { key: 'Tab' });
      link.focus();
    }

    it('shows the Abstract when the row takes keyboard focus, and leaves the focus on the row', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('report.txt', { status: 'ready', abstract: ABSTRACT }),
      ]);

      const link = rowLink('report.txt');
      tabTo(link);

      await waitFor(() => expect(popoverText()).toBe(ABSTRACT));
      expect(document.activeElement).toBe(link);
    });

    it('hides the popover when the row loses the focus', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('report.txt', { status: 'ready', abstract: ABSTRACT }),
      ]);
      const link = rowLink('report.txt');
      tabTo(link);
      await waitFor(() => expect(popoverText()).toBe(ABSTRACT));

      link.blur();

      await waitFor(() => expect(popoverText()).toBeNull());
    });

    it('hides the popover on Escape, leaving the focus on the row', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('report.txt', { status: 'ready', abstract: ABSTRACT }),
      ]);
      const link = rowLink('report.txt');
      tabTo(link);
      await waitFor(() => expect(popoverText()).toBe(ABSTRACT));
      // Material counts the popover as open one task after it is drawn, and
      // only an open one answers Escape; no person presses it sooner.
      await new Promise((resolve) => setTimeout(resolve));

      fireEvent.keyDown(link, { key: 'Escape', keyCode: 27 });

      await waitFor(() => expect(popoverText()).toBeNull());
      expect(document.activeElement).toBe(link);
    });

    // `mouseenter` does not bubble: a pointer reaching the filename enters
    // the row's link around it too, which is where the event is sent.
    it('shows the Abstract while the pointer is on the row, and hides it when it leaves', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('report.txt', { status: 'ready', abstract: ABSTRACT }),
      ]);
      const link = rowLink('report.txt');

      fireEvent.mouseEnter(link);
      await waitFor(() => expect(popoverText()).toBe(ABSTRACT));

      fireEvent.mouseLeave(link);
      await waitFor(() => expect(popoverText()).toBeNull());
    });

    it('says the Abstract is not generated yet when the Document has none', async () => {
      await renderWithUpload(vi.fn(), [documentFor('draft.txt', { abstract: null })]);

      tabTo(rowLink('draft.txt'));

      await waitFor(() => expect(popoverText()).toBe('Abstract not generated yet.'));
    });

    // A screen reader gets the Abstract with the row, without any hover.
    it("makes the Abstract the row's accessible description", async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('report.txt', { status: 'ready', abstract: ABSTRACT }),
      ]);

      const link = rowLink('report.txt');
      await waitFor(() => expect(link.getAttribute('aria-describedby')).toBeTruthy());
      expect(document.getElementById(link.getAttribute('aria-describedby')!)?.textContent).toBe(
        `report.txt\n${ABSTRACT}`,
      );
    });

    it('keeps each row to its filename and secondary line', async () => {
      await renderWithUpload(vi.fn(), [
        documentFor('report.txt', { status: 'ready', abstract: ABSTRACT }),
      ]);

      expect(documentRow('report.txt').textContent).not.toContain(ABSTRACT);
    });
  });

  describe('NBK-49: empty state', () => {
    /** The Documents pane's own "Add Documents", at its top since NBK-82. */
    function paneAddDocuments() {
      return within(documentsPanel()).getByRole('button', {
        name: 'Add Documents',
      }) as HTMLButtonElement;
    }

    it('an empty Notebook invites the first upload where the list would be', async () => {
      await renderWithUpload(vi.fn());
      const panel = documentsPanel();

      expect(within(panel).getByText('No Documents yet.')).toBeTruthy();
      expect(within(panel).getByText(/Add Documents to start asking questions\./)).toBeTruthy();
      // NBK-82 (spec 07 story 52): no button of its own — the pane's
      // "Add Documents" sits right above it.
      expect(screen.getAllByRole('button', { name: 'Add Documents' })).toEqual([
        paneAddDocuments(),
      ]);
    });

    // NBK-62 (spec 06 "Empty states"): the cat mark replaces the Documents
    // icon above the sentence, decorative so a screen reader skips it.
    it('shows the cat mark above the sentence, hidden from assistive technology', async () => {
      await renderWithUpload(vi.fn());
      const panel = documentsPanel();
      const sentence = within(panel).getByText('No Documents yet.');
      const mark = within(panel).getByTestId('copycat-mark') as HTMLImageElement;

      expect(mark.getAttribute('src')).toBe('/copycat-mark.svg');
      expect(mark.alt).toBe('');
      expect(mark.closest('[aria-hidden="true"]')).toBeTruthy();
      expect(
        mark.compareDocumentPosition(sentence) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(panel.querySelector('mat-icon[svgicon="document"]')).toBeNull();
    });

    it('goes away while a batch runs, and stays away once a Document exists', async () => {
      const request = deferred<Record<string, unknown>>();
      await renderWithUpload(vi.fn().mockReturnValue(request.promise));

      pick([fileNamed('a.txt')]);
      await screen.findByRole('list', { name: 'Upload progress' });
      expect(screen.queryByText('No Documents yet.')).toBeNull();
      expect(screen.getAllByRole('button', { name: 'Add Documents' })).toHaveLength(1);

      request.resolve(documentFor('a.txt'));
      await screen.findByText('1 uploaded, 0 skipped, 0 failed');
      expect(screen.queryByText('No Documents yet.')).toBeNull();
      expect(screen.getAllByRole('button', { name: 'Add Documents' })).toHaveLength(1);
    });

    it('is not shown for a Notebook that has Documents', async () => {
      await renderWithUpload(vi.fn(), [documentFor('a.txt')]);

      expect(screen.queryByText('No Documents yet.')).toBeNull();
      expect(screen.getAllByRole('button', { name: 'Add Documents' })).toHaveLength(1);
    });

    it("the pane's Add Documents carries the add icon", async () => {
      await renderWithUpload(vi.fn());

      const icon = paneAddDocuments().querySelector('mat-icon');
      expect(icon?.getAttribute('data-mat-icon-name')).toBe('add');
    });
  });
});
