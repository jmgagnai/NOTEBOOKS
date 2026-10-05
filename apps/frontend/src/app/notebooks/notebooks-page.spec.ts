import { render, screen } from '@testing-library/angular';
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
});
