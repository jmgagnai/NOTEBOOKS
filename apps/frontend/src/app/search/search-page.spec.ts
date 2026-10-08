import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular';
import { SearchPage } from './search-page';
import { NotebooksService } from '../api/services/notebooks.service';
import { SearchService } from '../api/services/search.service';
import { Elsewhere, RouterShell } from '../notebooks/notebook-detail-page.spec-helpers';
import { APP_NAME } from '../shared/brand';
import { provideAppIcons } from '../shared/fluent-icons';

const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';
const SEARCH_URL = `/notebooks/${NOTEBOOK_ID}/search`;

/** A search result as the generated client returns it (NBK-96: with its title and best Chunk). */
function result(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'doc-1',
    notebookId: NOTEBOOK_ID,
    filename: 'mars.pdf',
    status: 'ready',
    abstract: 'A survey of the Martian surface, its geology and its atmosphere.',
    createdAt: '2026-01-01T00:00:00.000Z',
    latestVersion: {
      id: 'v-1',
      versionNumber: 2,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    title: 'The Red Planet',
    match: { versionId: 'v-1', chunkId: 'chunk-7', charStart: 120, charEnd: 340 },
    score: 0.82,
    ...overrides,
  };
}

/**
 * The page behind the real router (NBK-96): the query lives in the URL, and
 * a result is a link to the Document page — whose stand-in here is a page
 * elsewhere, so Back from it re-creates the Search page as the app does.
 */
async function renderSearch(
  searchNotebook: ReturnType<typeof vi.fn>,
  { url = SEARCH_URL, notebooks = [] as unknown[] } = {},
) {
  const rendered = await render(RouterShell, {
    routes: [
      { path: 'notebooks/:notebookId/search', component: SearchPage },
      { path: 'notebooks/:notebookId/documents/:documentId', component: Elsewhere },
      { path: 'notebooks/:notebookId', component: Elsewhere },
    ],
    providers: [
      provideAppIcons(),
      {
        provide: NotebooksService,
        useValue: { listNotebooks: vi.fn().mockResolvedValue(notebooks) },
      },
      { provide: SearchService, useValue: { searchNotebook } },
    ],
  });
  await rendered.navigate(url);
  return rendered;
}

const box = () => screen.findByLabelText('Search this Notebook') as Promise<HTMLInputElement>;

/** Types a query into the box and presses Enter — the only way to search. */
async function searchFor(query: string): Promise<void> {
  const input = await box();
  fireEvent.input(input, { target: { value: query } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

// Seam-3 test (NBK-1, NBK-9): the real page and store, only the generated
// client (SearchService) mocked.
describe('SearchPage', () => {
  describe('the frame (NBK-96)', () => {
    it('is headed "Search · <Notebook title>", with ✕ back to the Notebook', async () => {
      await renderSearch(vi.fn(), {
        notebooks: [{ id: NOTEBOOK_ID, title: 'Research', createdAt: '2026-01-01T00:00:00.000Z' }],
      });

      const header = await screen.findByTestId('search-page-header');
      expect(await within(header).findByText('Search · Research')).toBeTruthy();
      const close = within(header).getByRole('link', { name: 'Back to the Notebook' });
      expect(close.getAttribute('href')).toBe(`/notebooks/${NOTEBOOK_ID}`);
      expect(screen.queryByText(/← Back to the Notebook/)).toBeNull();
    });

    it('offers a search box with no Search button, and sends nothing while typing', async () => {
      const searchNotebook = vi.fn().mockResolvedValue([]);
      await renderSearch(searchNotebook);

      const input = await box();
      expect(input.getAttribute('placeholder')).toBe("Search this Notebook's Documents");
      expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
      fireEvent.input(input, { target: { value: 'mars' } });
      expect(searchNotebook).not.toHaveBeenCalled();
    });

    it('puts the Notebook title in the browser tab, and the default back on leaving', async () => {
      document.title = 'A stale title';
      const { fixture } = await renderSearch(vi.fn(), {
        notebooks: [{ id: NOTEBOOK_ID, title: 'Research', createdAt: '2026-01-01T00:00:00.000Z' }],
      });

      await waitFor(() => expect(document.title).toBe(`Research – ${APP_NAME}`));
      fixture.destroy();
      expect(document.title).toBe(APP_NAME);
    });
  });

  describe('the query in the URL', () => {
    it('searches on Enter and puts the query in the URL', async () => {
      const searchNotebook = vi.fn().mockResolvedValue([result()]);
      await renderSearch(searchNotebook);

      await searchFor('red planet');

      await screen.findByRole('link', { name: /The Red Planet/ });
      expect(searchNotebook).toHaveBeenCalledWith({ notebookId: NOTEBOOK_ID, q: 'red planet' });
      expect(TestBed.inject(Router).url).toBe(`${SEARCH_URL}?q=red%20planet`);
    });

    it('runs the query a link arrives with, and shows it in the box', async () => {
      const searchNotebook = vi.fn().mockResolvedValue([result()]);
      await renderSearch(searchNotebook, { url: `${SEARCH_URL}?q=geology` });

      await screen.findByRole('link', { name: /The Red Planet/ });
      expect((await box()).value).toBe('geology');
      expect(searchNotebook).toHaveBeenCalledWith({ notebookId: NOTEBOOK_ID, q: 'geology' });
    });

    it('shows the same results again on coming Back from a Document, without searching again', async () => {
      const searchNotebook = vi.fn().mockResolvedValue([result()]);
      await renderSearch(searchNotebook);
      await searchFor('red planet');
      fireEvent.click(await screen.findByRole('link', { name: /The Red Planet/ }));
      await screen.findByText('Somewhere else');

      TestBed.inject(Location).back();

      expect(await screen.findByRole('link', { name: /The Red Planet/ })).toBeTruthy();
      expect((await box()).value).toBe('red planet');
      expect(searchNotebook).toHaveBeenCalledTimes(1);
    });

    it('does not search on an empty query', async () => {
      const searchNotebook = vi.fn();
      await renderSearch(searchNotebook);

      await searchFor('   ');

      expect(searchNotebook).not.toHaveBeenCalled();
    });
  });

  describe('results', () => {
    it("shows each Document's type icon, title, filename and Version, and Abstract", async () => {
      await renderSearch(
        vi
          .fn()
          .mockResolvedValue([
            result(),
            result({ id: 'doc-2', filename: 'notes.txt', title: null, abstract: null }),
          ]),
      );
      await searchFor('mars');

      const first = await screen.findByRole('link', { name: /The Red Planet/ });
      expect(within(first).getByText('mars.pdf · v2')).toBeTruthy();
      expect(
        within(first).getByText('A survey of the Martian surface, its geology and its atmosphere.'),
      ).toBeTruthy();
      expect(first.querySelector('mat-icon')?.getAttribute('data-mat-icon-name')).toBe(
        'document-pdf',
      );
      // No extracted title: the filename heads the row, and isn't repeated.
      const second = screen.getByRole('link', { name: /notes\.txt/ });
      expect(within(second).getByText('notes.txt')).toBeTruthy();
      expect(within(second).getByText('Abstract not generated yet.')).toBeTruthy();
    });

    it('links each result to its best-matching Chunk, the way a Citation does', async () => {
      await renderSearch(vi.fn().mockResolvedValue([result()]));
      await searchFor('mars');

      const link = await screen.findByRole('link', { name: /The Red Planet/ });
      const href = new URL(link.getAttribute('href')!, 'http://app');
      expect(href.pathname).toBe(`/notebooks/${NOTEBOOK_ID}/documents/doc-1`);
      expect(Object.fromEntries(href.searchParams)).toEqual({
        version: 'v-1',
        chunk: 'chunk-7',
        from: '120',
        to: '340',
      });
    });

    it('leaves the range out of the link when the Chunk could not be located', async () => {
      await renderSearch(
        vi.fn().mockResolvedValue([
          result({
            match: { versionId: 'v-1', chunkId: 'chunk-7', charStart: null, charEnd: null },
          }),
        ]),
      );
      await searchFor('mars');

      const link = await screen.findByRole('link', { name: /The Red Planet/ });
      const params = new URL(link.getAttribute('href')!, 'http://app').searchParams;
      expect(Object.fromEntries(params)).toEqual({ version: 'v-1', chunk: 'chunk-7' });
    });
  });

  describe('states', () => {
    it('distinguishes "no matches" from "nothing searched yet"', async () => {
      await renderSearch(vi.fn().mockResolvedValue([]));
      expect(await screen.findByText(/Search finds Documents by meaning/)).toBeTruthy();

      await searchFor('nothing like this');

      expect(
        await screen.findByText('No Documents in this Notebook match "nothing like this".'),
      ).toBeTruthy();
    });

    it("surfaces the backend's message when a search fails", async () => {
      await renderSearch(
        vi.fn().mockRejectedValue({
          error: { message: 'Search is unavailable: no embedding model is configured.' },
        }),
      );
      await searchFor('mars');

      expect(
        await screen.findByText('Search is unavailable: no embedding model is configured.'),
      ).toBeTruthy();
    });
  });

  describe('against stale answers (review)', () => {
    it("shows the latest query's results when an earlier search answers after it", async () => {
      let answerFirst!: (results: unknown) => void;
      const searchNotebook = vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
        .mockResolvedValue([result({ id: 'doc-2', title: 'Phobos and Deimos' })]);
      await renderSearch(searchNotebook);

      await searchFor('mars');
      await waitFor(() => expect(searchNotebook).toHaveBeenCalledTimes(1));
      await searchFor('moons');
      await screen.findByRole('link', { name: /Phobos and Deimos/ });
      answerFirst([result()]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(screen.getByRole('link', { name: /Phobos and Deimos/ })).toBeTruthy();
      expect(screen.queryByRole('link', { name: /The Red Planet/ })).toBeNull();
    });

    it('does not search on Enter while an input method is composing', async () => {
      const searchNotebook = vi.fn().mockResolvedValue([]);
      await renderSearch(searchNotebook);
      const input = await box();
      fireEvent.input(input, { target: { value: 'にほ' } });

      fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
      // A search starts after the router has moved to `?q=`: give it time.
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(searchNotebook).not.toHaveBeenCalled();
      expect(TestBed.inject(Router).url).toBe(SEARCH_URL);
    });

    it('shows a spinner while searching', async () => {
      await renderSearch(vi.fn().mockReturnValue(new Promise(() => {})));

      await searchFor('mars');

      expect(await screen.findByRole('progressbar')).toBeTruthy();
    });

    it('shows the 503 when search is not configured', async () => {
      await renderSearch(
        vi.fn().mockRejectedValue({
          status: 503,
          error: {
            message: 'Search is not configured on this server: OPENROUTER_API_KEY is not set.',
          },
        }),
      );

      await searchFor('mars');

      expect(await screen.findByText(/OPENROUTER_API_KEY is not set/)).toBeTruthy();
    });

    it('starts afresh after leaving for the Notebook, searching the query again', async () => {
      const searchNotebook = vi.fn().mockResolvedValue([result()]);
      const { navigate } = await renderSearch(searchNotebook);
      await searchFor('mars');
      await screen.findByRole('link', { name: /The Red Planet/ });

      fireEvent.click(screen.getByRole('link', { name: 'Back to the Notebook' }));
      await screen.findByText('Somewhere else');
      await navigate(`${SEARCH_URL}?q=mars`);

      await screen.findByRole('link', { name: /The Red Planet/ });
      expect(searchNotebook).toHaveBeenCalledTimes(2);
    });
  });
});
