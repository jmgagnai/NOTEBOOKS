import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { fireEvent, render, screen, waitFor } from '@testing-library/angular';
import { NotebooksPage } from './notebooks-page';
import { NotebooksService } from '../api/services/notebooks.service';
import { provideAppIcons } from '../shared/fluent-icons';

/** Where "Create Notebook" lands; the real Notebook page is not under test here. */
@Component({ selector: 'app-opened-notebook', template: 'Opened Notebook' })
class OpenedNotebook {}

/** The page's providers, with `notebooksService` standing in for the API client. */
function pageProviders(notebooksService: Partial<Record<keyof NotebooksService, unknown>>) {
  return [{ provide: NotebooksService, useValue: notebooksService }, provideAppIcons()];
}

/**
 * Opens the card's "…" menu for `title` and picks `action` from it (NBK-56):
 * Rename and Delete live behind "Actions for <title>" rather than on the card.
 */
async function chooseFromCardMenu(title: string, action: 'Rename' | 'Delete') {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${title}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: `${action} ${title}` }));
}

// Seam-3 test (per NBK-1's testing decisions): render the real page +
// SignalStore, mocking only the generated ng-openapi-gen client interface —
// never the store or any Angular service internals directly.
describe('NotebooksPage', () => {
  it('renders the Notebooks returned by the generated client', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([
      { id: '1', title: 'Q3 Contracts', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: '2', title: 'Onboarding Docs', createdAt: '2026-01-02T00:00:00.000Z' },
    ]);

    await render(NotebooksPage, {
      providers: pageProviders({ listNotebooks }),
    });

    expect(await screen.findByText('Q3 Contracts')).toBeTruthy();
    expect(screen.getByText('Onboarding Docs')).toBeTruthy();
    expect(listNotebooks).toHaveBeenCalled();
  });

  // NBK-55: a Notebook is a card whose body is a link into it, so opening
  // one is a single click (or Enter) rather than a separate "Open" button.
  it('shows each Notebook as a card linking to it, with its creation date', async () => {
    const listNotebooks = vi
      .fn()
      .mockResolvedValue([
        { id: '1', title: 'Q3 Contracts', createdAt: '2026-01-15T12:00:00.000Z' },
      ]);

    await render(NotebooksPage, {
      providers: pageProviders({ listNotebooks }),
    });

    const card = await screen.findByRole('link', { name: /Q3 Contracts/ });
    expect(card.getAttribute('href')).toBe('/notebooks/1');
    expect(card.textContent).toContain('Created Jan 15, 2026');
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it('shows an empty state with the Create button when the Notebook list is empty', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([]);

    await render(NotebooksPage, {
      providers: pageProviders({ listNotebooks }),
    });

    expect(await screen.findByText('No Notebooks yet.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Notebooks' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create Notebook' })).toBeTruthy();
    expect(screen.queryByLabelText('New Notebook title')).toBeNull();
  });

  // NBK-55 (spec 05 "Create"): no title is asked for up front — the new
  // Notebook opens straight away, where its header title is editable.
  it('creates an "Untitled Notebook" and opens it with its title ready to type over', async () => {
    const listNotebooks = vi
      .fn()
      .mockResolvedValue([
        { id: '1', title: 'Q3 Contracts', createdAt: '2026-01-15T12:00:00.000Z' },
      ]);
    const createNotebook = vi.fn().mockResolvedValue({
      id: '7',
      title: 'Untitled Notebook',
      createdAt: '2026-01-16T12:00:00.000Z',
    });

    await render(NotebooksPage, {
      providers: pageProviders({ listNotebooks, createNotebook }),
      routes: [{ path: 'notebooks/:notebookId', component: OpenedNotebook }],
    });
    await screen.findByText('Q3 Contracts');

    fireEvent.click(screen.getByRole('button', { name: 'Create Notebook' }));

    expect(createNotebook).toHaveBeenCalledWith({ body: { title: 'Untitled Notebook' } });
    const router = TestBed.inject(Router);
    await vi.waitFor(() => expect(router.url).toBe('/notebooks/7'));
    // The Notebook page's cue to open its title for editing (spec 05 story
    // 3); that page's own spec covers what it does with it.
    expect(router.lastSuccessfulNavigation()?.extras.state).toEqual({ editTitle: true });
  });

  it('stays on the page and says why when creating fails', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([]);
    const createNotebook = vi
      .fn()
      .mockRejectedValue({ error: { message: 'Title must not be empty.' } });

    await render(NotebooksPage, {
      providers: pageProviders({ listNotebooks, createNotebook }),
      routes: [{ path: 'notebooks/:notebookId', component: OpenedNotebook }],
    });
    await screen.findByText('No Notebooks yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Create Notebook' }));

    expect(await screen.findByText('Title must not be empty.')).toBeTruthy();
    expect(TestBed.inject(Router).url).toBe('/');
  });

  // NBK-56: the card keeps only its link and a "…" button; the menu holds
  // the actions, and opening it must not open the Notebook underneath.
  it('offers Rename and Delete from the card\'s "…" menu without opening the Notebook', async () => {
    const listNotebooks = vi
      .fn()
      .mockResolvedValue([
        { id: '1', title: 'Q3 Contracts', createdAt: '2026-01-01T00:00:00.000Z' },
      ]);

    await render(NotebooksPage, {
      providers: pageProviders({ listNotebooks }),
      routes: [{ path: 'notebooks/:notebookId', component: OpenedNotebook }],
    });
    await screen.findByText('Q3 Contracts');

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Q3 Contracts' }));

    expect(await screen.findByRole('menuitem', { name: 'Rename Q3 Contracts' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete Q3 Contracts' })).toBeTruthy();
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('renames a Notebook in place, committing on Enter', async () => {
    const listNotebooks = vi
      .fn()
      .mockResolvedValue([
        { id: '1', title: 'Q3 Contracts', createdAt: '2026-01-01T00:00:00.000Z' },
      ]);
    const renameNotebook = vi.fn().mockResolvedValue({
      id: '1',
      title: 'Q4 Contracts',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    await render(NotebooksPage, {
      providers: pageProviders({ listNotebooks, renameNotebook }),
    });
    await screen.findByText('Q3 Contracts');

    await chooseFromCardMenu('Q3 Contracts', 'Rename');
    const box = await screen.findByLabelText('Notebook title');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.input(box, { target: { value: 'Q4 Contracts' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(renameNotebook).toHaveBeenCalledWith({ id: '1', body: { title: 'Q4 Contracts' } });
    const card = await screen.findByRole('link', { name: /Q4 Contracts/ });
    expect(screen.queryByLabelText('Notebook title')).toBeNull();
    // The keyboard is back on the card it renamed, not dropped on the page.
    await waitFor(() => expect(document.activeElement).toBe(card));
  });

  it('puts the title back when the rename is abandoned with Escape', async () => {
    const listNotebooks = vi
      .fn()
      .mockResolvedValue([
        { id: '1', title: 'Q3 Contracts', createdAt: '2026-01-01T00:00:00.000Z' },
      ]);
    const renameNotebook = vi.fn();

    await render(NotebooksPage, {
      providers: pageProviders({ listNotebooks, renameNotebook }),
    });
    await screen.findByText('Q3 Contracts');

    await chooseFromCardMenu('Q3 Contracts', 'Rename');
    const box = await screen.findByLabelText('Notebook title');
    fireEvent.input(box, { target: { value: 'Mistake' } });
    fireEvent.keyDown(box, { key: 'Escape' });

    expect(renameNotebook).not.toHaveBeenCalled();
    const card = await screen.findByRole('link', { name: /Q3 Contracts/ });
    expect(screen.queryByLabelText('Notebook title')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(card));
  });

  it('deletes a Notebook, removing it from the list', async () => {
    const listNotebooks = vi
      .fn()
      .mockResolvedValue([
        { id: '1', title: 'Q3 Contracts', createdAt: '2026-01-01T00:00:00.000Z' },
      ]);
    const deleteNotebook = vi.fn().mockResolvedValue(null);

    await render(NotebooksPage, {
      providers: pageProviders({ listNotebooks, deleteNotebook }),
    });

    await screen.findByText('Q3 Contracts');

    await chooseFromCardMenu('Q3 Contracts', 'Delete');

    expect(deleteNotebook).toHaveBeenCalledWith({ id: '1' });
    await screen.findByText('No Notebooks yet.');
  });

  it('restores a deleted Notebook via Undo', async () => {
    const listNotebooks = vi
      .fn()
      .mockResolvedValue([
        { id: '1', title: 'Q3 Contracts', createdAt: '2026-01-01T00:00:00.000Z' },
      ]);
    const deleteNotebook = vi.fn().mockResolvedValue(null);
    const restoreNotebook = vi.fn().mockResolvedValue({
      id: '1',
      title: 'Q3 Contracts',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    await render(NotebooksPage, {
      providers: pageProviders({ listNotebooks, deleteNotebook, restoreNotebook }),
    });

    await screen.findByText('Q3 Contracts');
    await chooseFromCardMenu('Q3 Contracts', 'Delete');
    await screen.findByText('No Notebooks yet.');

    // The offer is a snack bar (NBK-33), which only becomes visible to
    // assistive technology once Material has announced it.
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    expect(restoreNotebook).toHaveBeenCalledWith({ id: '1' });
    expect(await screen.findByText('Q3 Contracts')).toBeTruthy();
  });

  // NBK-33: the undo offer is a snack bar, not a line in the page, so the
  // list no longer jumps when something is deleted.
  it('announces a deleted Notebook in a snack bar instead of an inline line', async () => {
    const listNotebooks = vi
      .fn()
      .mockResolvedValue([
        { id: '1', title: 'Q3 Contracts', createdAt: '2026-01-01T00:00:00.000Z' },
      ]);
    const deleteNotebook = vi.fn().mockResolvedValue(null);

    await render(NotebooksPage, {
      providers: pageProviders({ listNotebooks, deleteNotebook }),
    });

    await screen.findByText('Q3 Contracts');
    await chooseFromCardMenu('Q3 Contracts', 'Delete');

    expect(await screen.findByText('Q3 Contracts deleted')).toBeTruthy();
    expect(screen.queryByText(/"Q3 Contracts" deleted\./)).toBeNull();
  });

  it('replaces the undo offer when a second Notebook is deleted', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([
      { id: '1', title: 'Q3 Contracts', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: '2', title: 'Onboarding Docs', createdAt: '2026-01-02T00:00:00.000Z' },
    ]);
    const deleteNotebook = vi.fn().mockResolvedValue(null);

    await render(NotebooksPage, {
      providers: pageProviders({ listNotebooks, deleteNotebook }),
    });

    await screen.findByText('Q3 Contracts');
    await chooseFromCardMenu('Q3 Contracts', 'Delete');
    await screen.findByText('Q3 Contracts deleted');

    await chooseFromCardMenu('Onboarding Docs', 'Delete');

    expect(await screen.findByText('Onboarding Docs deleted')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Q3 Contracts deleted')).toBeNull());
  });

  it('withdraws the undo offer by itself after 8 seconds', async () => {
    const listNotebooks = vi
      .fn()
      .mockResolvedValue([
        { id: '1', title: 'Q3 Contracts', createdAt: '2026-01-01T00:00:00.000Z' },
      ]);
    const deleteNotebook = vi.fn().mockResolvedValue(null);

    await render(NotebooksPage, {
      providers: pageProviders({ listNotebooks, deleteNotebook }),
    });
    await screen.findByText('Q3 Contracts');

    // Only timeouts are faked, so the queries' polling and Angular's own
    // scheduling keep running on real time; `shouldAdvanceTime` lets the
    // snack bar's short opening delays elapse without being stepped by hand.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      await chooseFromCardMenu('Q3 Contracts', 'Delete');
      await screen.findByText('Q3 Contracts deleted');

      await vi.advanceTimersByTimeAsync(7_000);
      expect(screen.getByText('Q3 Contracts deleted')).toBeTruthy();

      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => expect(screen.queryByText('Q3 Contracts deleted')).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});
