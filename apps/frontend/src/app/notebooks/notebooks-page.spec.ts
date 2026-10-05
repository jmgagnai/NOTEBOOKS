import { fireEvent, render, screen } from '@testing-library/angular';
import { NotebooksPage } from './notebooks-page';
import { NotebooksService } from '../api/services/notebooks.service';

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
      providers: [{ provide: NotebooksService, useValue: { listNotebooks } }],
    });

    expect(await screen.findByText('Q3 Contracts')).toBeTruthy();
    expect(screen.getByText('Onboarding Docs')).toBeTruthy();
    expect(listNotebooks).toHaveBeenCalled();
  });

  it('shows an empty state when the Notebook list is empty', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([]);

    await render(NotebooksPage, {
      providers: [{ provide: NotebooksService, useValue: { listNotebooks } }],
    });

    expect(await screen.findByText('No Notebooks yet.')).toBeTruthy();
  });

  it('creates a Notebook through the form', async () => {
    const listNotebooks = vi.fn().mockResolvedValue([]);
    const createNotebook = vi.fn().mockResolvedValue({
      id: '1',
      title: 'New Research',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    await render(NotebooksPage, {
      providers: [{ provide: NotebooksService, useValue: { listNotebooks, createNotebook } }],
    });

    await screen.findByText('No Notebooks yet.');

    fireEvent.input(screen.getByLabelText('New Notebook title'), {
      target: { value: 'New Research' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('New Research')).toBeTruthy();
    expect(createNotebook).toHaveBeenCalledWith({ body: { title: 'New Research' } });
  });

  it('renames a Notebook', async () => {
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
      providers: [{ provide: NotebooksService, useValue: { listNotebooks, renameNotebook } }],
    });

    await screen.findByText('Q3 Contracts');

    fireEvent.click(screen.getByRole('button', { name: 'Rename Q3 Contracts' }));
    fireEvent.input(screen.getByLabelText('Rename Q3 Contracts'), {
      target: { value: 'Q4 Contracts' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Q4 Contracts')).toBeTruthy();
    expect(renameNotebook).toHaveBeenCalledWith({ id: '1', body: { title: 'Q4 Contracts' } });
  });

  it('deletes a Notebook, removing it from the list', async () => {
    const listNotebooks = vi
      .fn()
      .mockResolvedValue([
        { id: '1', title: 'Q3 Contracts', createdAt: '2026-01-01T00:00:00.000Z' },
      ]);
    const deleteNotebook = vi.fn().mockResolvedValue(null);

    await render(NotebooksPage, {
      providers: [{ provide: NotebooksService, useValue: { listNotebooks, deleteNotebook } }],
    });

    await screen.findByText('Q3 Contracts');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Q3 Contracts' }));

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
      providers: [
        { provide: NotebooksService, useValue: { listNotebooks, deleteNotebook, restoreNotebook } },
      ],
    });

    await screen.findByText('Q3 Contracts');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Q3 Contracts' }));
    await screen.findByText('No Notebooks yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(restoreNotebook).toHaveBeenCalledWith({ id: '1' });
    expect(await screen.findByText('Q3 Contracts')).toBeTruthy();
  });
});
