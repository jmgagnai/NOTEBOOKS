import { ActivatedRoute } from '@angular/router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular';
import { NotebookDetailPage } from './notebook-detail-page';
import {
  NOTEBOOK_ID,
  RouterShell,
  Elsewhere,
  pageProviders,
  documentFor,
  deferred,
  heldUploads,
  renderWithUpload,
  fileNamed,
  pick,
  sentNames,
  panelRow,
  documentRow,
  documentsPanel,
} from './notebook-detail-page.spec-helpers';

describe('NotebookDetailPage — upload batches', () => {
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

  describe('NBK-50: batch panel', () => {
    /** The Upload batch block, which spec 03 places inside the Documents panel. */
    const batchBlock = () => within(documentsPanel()).getByRole('region', { name: 'Upload batch' });

    it('shows the batch at the top of the Documents panel, above the list, one badged row per file', async () => {
      const uploads = heldUploads();
      await renderWithUpload(uploads.uploadDocument, [documentFor('a.txt', { status: 'ready' })]);

      pick([fileNamed('b.txt'), fileNamed('c.txt')]);

      const block = batchBlock();
      const list = within(documentsPanel()).getByRole('list', { name: 'Documents' });
      expect(block.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const rows = within(
        within(block).getByRole('list', { name: 'Upload progress' }),
      ).getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      ['b.txt', 'c.txt'].forEach((filename, index) => {
        expect(within(rows[index]).getByText(filename)).toBeTruthy();
        // The per-file status is the shared badge (NBK-32), not page-local text.
        expect(within(rows[index]).getByText('Uploading').classList).toContain('app-badge');
      });
    });

    it('asks the conflict question inside the batch block, and steers the batch from there', async () => {
      const existing = documentFor('report.txt', { status: 'ready' });
      const uploads = heldUploads();
      await renderWithUpload(uploads.uploadDocument, [existing]);

      pick([fileNamed('report.txt'), fileNamed('fresh.txt')]);

      const question = await within(batchBlock()).findByRole('dialog', {
        name: 'Document already exists',
      });
      expect(within(batchBlock()).getByRole('button', { name: 'Cancel' })).toBeTruthy();

      fireEvent.click(within(question).getByRole('button', { name: 'Skip' }));
      uploads.fail('fresh.txt');

      expect(await within(batchBlock()).findByText('0 uploaded, 1 skipped, 1 failed')).toBeTruthy();
      expect(within(batchBlock()).getByRole('button', { name: 'Retry failed' })).toBeTruthy();
      fireEvent.click(within(batchBlock()).getByRole('button', { name: 'Dismiss' }));
      expect(within(documentsPanel()).queryByRole('region', { name: 'Upload batch' })).toBeNull();
    });
  });
});
