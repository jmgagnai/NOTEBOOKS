import { fireEvent, render, screen } from '@testing-library/angular';
import { App } from './app';
import { routes } from './app.routes';
import { AuthService } from './api/services/auth.service';
import { NotebooksService } from './api/services/notebooks.service';
import { provideAppIcons } from './shared/fluent-icons';

// App-level seam-3 test (NBK-3): renders the real shell through the real
// app routes and auth guard, mocking only the generated ng-openapi-gen
// AuthService/NotebooksService clients — proves "a logged-in user sees an
// authenticated shell, a logged-out user is redirected to login".

/** Renders the shell with a live session for `email`, settled on the Notebooks page. */
async function renderSignedIn(email: string) {
  const getCurrentUser = vi.fn().mockResolvedValue({
    id: '1',
    email,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const logout = vi.fn().mockResolvedValue(null);
  const listNotebooks = vi.fn().mockResolvedValue([]);

  await render(App, {
    providers: [
      provideAppIcons(),
      { provide: AuthService, useValue: { getCurrentUser, logout } },
      { provide: NotebooksService, useValue: { listNotebooks } },
    ],
    routes,
  });
  await screen.findByText('Notebooks');
}

const avatarFor = (email: string) =>
  screen.getByRole('button', { name: `Account menu for ${email}` });

describe('App', () => {
  it('shows the authenticated shell and Notebooks page when a session exists', async () => {
    await renderSignedIn('ada@example.com');

    expect(screen.getByText('RAG Notebook')).toBeTruthy();
    expect(avatarFor('ada@example.com')).toBeTruthy();
  });

  // NBK-30: the identity in the bar is the avatar alone; the e-mail is only
  // reachable through its menu.
  it('keeps the e-mail out of the title bar until the avatar menu opens', async () => {
    await renderSignedIn('ada@example.com');

    expect(screen.queryByText('ada@example.com')).toBeNull();

    fireEvent.click(avatarFor('ada@example.com'));

    const emailItem = await screen.findByRole('menuitem', { name: 'ada@example.com' });
    expect((emailItem as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
  });

  // NBK-31: the first Fluent icon on screen. It decorates the item without
  // joining its name, so the menu still reads "Sign out" to assistive tech.
  it('shows an icon on the Sign out item without changing its accessible name', async () => {
    await renderSignedIn('ada@example.com');

    fireEvent.click(avatarFor('ada@example.com'));

    const signOut = await screen.findByRole('menuitem', { name: 'Sign out' });
    expect(signOut.querySelector('svg')).not.toBeNull();
  });

  it('signs out from the avatar menu and lands on the sign-in page', async () => {
    await renderSignedIn('ada@example.com');

    fireEvent.click(avatarFor('ada@example.com'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    expect(await screen.findByText('Log in')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Account menu/ })).toBeNull();
  });

  it('shows two initials for a dotted e-mail local part', async () => {
    await renderSignedIn('jane.doe@example.com');

    expect(avatarFor('jane.doe@example.com').textContent?.trim()).toBe('JD');
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
