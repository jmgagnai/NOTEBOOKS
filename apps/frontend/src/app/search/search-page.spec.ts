import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { fireEvent, render, screen, waitFor } from '@testing-library/angular';
import { SearchPage } from './search-page';
import { NotebooksService } from '../api/services/notebooks.service';
import { SearchService } from '../api/services/search.service';
import { APP_NAME } from '../shared/app-name';

const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';

function activatedRouteFor(notebookId: string) {
  return {
    provide: ActivatedRoute,
    useValue: { snapshot: { paramMap: convertToParamMap({ notebookId }) } },
  };
}

/** A search result as the generated client returns it: a Document + a score. */
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
      versionNumber: 1,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    score: 0.82,
    ...overrides,
  };
}

async function renderPage(searchNotebook: ReturnType<typeof vi.fn>) {
  return render(SearchPage, {
    providers: [
      activatedRouteFor(NOTEBOOK_ID),
      { provide: NotebooksService, useValue: { listNotebooks: vi.fn().mockResolvedValue([]) } },
      { provide: SearchService, useValue: { searchNotebook } },
    ],
  });
}

/** Types a query into the search box and submits it. */
async function searchFor(query: string): Promise<void> {
  const input = await screen.findByLabelText('Search this Notebook');
  fireEvent.input(input, { target: { value: query } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
}

// Seam-3 test (per NBK-1's testing decisions, and explicitly called for by
// NBK-9's acceptance criteria): render the real page + SignalStore, mocking
// only the generated ng-openapi-gen client interface (SearchService) — never
// the store or any Angular service internals.
describe('SearchPage', () => {
  it('shows each matched Document with its Abstract', async () => {
    const searchNotebook = vi.fn().mockResolvedValue([
      result(),
      result({
        id: 'doc-2',
        filename: 'venus.pdf',
        abstract: 'What the Venera landers found beneath the clouds of Venus.',
        score: 0.41,
      }),
    ]);
    await renderPage(searchNotebook);

    await searchFor('martian geology');

    // The Abstract is the whole point of a search result: per GLOSSARY.md it
    // is the 50-100 word artifact "used in search results, search-result
    // previews, and document cards", and NBK-1's story is that a user can
    // "judge relevance before opening the full document".
    expect(
      await screen.findByText('A survey of the Martian surface, its geology and its atmosphere.'),
    ).toBeTruthy();
    expect(
      screen.getByText('What the Venera landers found beneath the clouds of Venus.'),
    ).toBeTruthy();
    expect(screen.getByText('mars.pdf')).toBeTruthy();
    expect(screen.getByText('venus.pdf')).toBeTruthy();
    expect(searchNotebook).toHaveBeenCalledWith({ notebookId: NOTEBOOK_ID, q: 'martian geology' });
  });

  it('asks nothing of the API until a search is submitted', async () => {
    const searchNotebook = vi.fn();
    await renderPage(searchNotebook);

    expect(await screen.findByLabelText('Search this Notebook')).toBeTruthy();
    expect(searchNotebook).not.toHaveBeenCalled();
    // Nothing asked yet is not the same as nothing found, so the empty-result
    // wording must not be on screen.
    expect(screen.queryByText(/No Documents in this Notebook match/)).toBeNull();
  });

  it('distinguishes "no matches" from "nothing searched yet"', async () => {
    const searchNotebook = vi.fn().mockResolvedValue([]);
    await renderPage(searchNotebook);

    await searchFor('nothing like this');

    expect(
      await screen.findByText('No Documents in this Notebook match "nothing like this".'),
    ).toBeTruthy();
  });

  it("surfaces the backend's message when a search fails", async () => {
    // What the route answers with no OPENROUTER_API_KEY configured: a 503
    // saying why, which the user needs to see rather than an empty list that
    // looks like "your Notebook has nothing in it".
    const searchNotebook = vi.fn().mockRejectedValue({
      error: { message: 'Search is unavailable: no embedding model is configured.' },
    });
    await renderPage(searchNotebook);

    await searchFor('anything');

    expect(
      await screen.findByText('Search is unavailable: no embedding model is configured.'),
    ).toBeTruthy();
  });

  it('does not search on an empty query', async () => {
    const searchNotebook = vi.fn().mockResolvedValue([]);
    await renderPage(searchNotebook);

    await searchFor('   ');

    expect(searchNotebook).not.toHaveBeenCalled();
  });

  it('links each result to the Document it matched', async () => {
    const searchNotebook = vi.fn().mockResolvedValue([result()]);
    await renderPage(searchNotebook);

    await searchFor('martian geology');

    const open = await screen.findByLabelText('Open mars.pdf');
    expect(open.getAttribute('href')).toBe(`/notebooks/${NOTEBOOK_ID}/documents/doc-1`);
  });

  // NBK-61: the tab names the Notebook being searched, like the Notebook page.
  it('puts the Notebook title in the browser tab, and the default back on leaving', async () => {
    document.title = 'A stale title';
    const { fixture } = await render(SearchPage, {
      providers: [
        activatedRouteFor(NOTEBOOK_ID),
        {
          provide: NotebooksService,
          useValue: {
            listNotebooks: vi
              .fn()
              .mockResolvedValue([
                { id: NOTEBOOK_ID, title: 'Research', createdAt: '2026-01-01T00:00:00.000Z' },
              ]),
          },
        },
        { provide: SearchService, useValue: { searchNotebook: vi.fn() } },
      ],
    });

    await waitFor(() => expect(document.title).toBe(`Research – ${APP_NAME}`));

    fixture.destroy();
    expect(document.title).toBe(APP_NAME);
  });
});
