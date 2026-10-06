import { render, screen } from '@testing-library/angular';
import { App } from './app';
import { routes } from './app.routes';
import { AuthService } from './api/services/auth.service';
import { NotebooksService } from './api/services/notebooks.service';

// App-level seam-3 test (NBK-3): renders the real shell through the real
// app routes and auth guard, mocking only the generated ng-openapi-gen
// AuthService/NotebooksService clients — proves "a logged-in user sees an
// authenticated shell, a logged-out user is redirected to login".
describe('App', () => {
  it('shows the authenticated shell and Notebooks page when a session exists', async () => {
    const getCurrentUser = vi.fn().mockResolvedValue({
      id: '1',
      email: 'ada@example.com',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const listNotebooks = vi.fn().mockResolvedValue([]);

    await render(App, {
      providers: [
        { provide: AuthService, useValue: { getCurrentUser } },
        { provide: NotebooksService, useValue: { listNotebooks } },
      ],
      routes,
    });

    expect(await screen.findByText('ada@example.com')).toBeTruthy();
    expect(await screen.findByText('Notebooks')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();
  });

  it('redirects to the login page when no session exists', async () => {
    const getCurrentUser = vi.fn().mockRejectedValue({ status: 401 });

    await render(App, {
      providers: [{ provide: AuthService, useValue: { getCurrentUser } }],
      routes,
    });

    expect(await screen.findByText('Log in')).toBeTruthy();
    expect(screen.queryByText('Notebooks')).toBeNull();
  });
});
