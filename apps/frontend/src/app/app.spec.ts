import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular';
import { App } from './app';
import { routes } from './app.routes';
import { AuthService } from './api/services/auth.service';
import { NotebooksService } from './api/services/notebooks.service';
import { SearchService } from './api/services/search.service';
import { provideAppIcons } from './shared/fluent-icons';
import { APP_NAME } from './shared/brand';

// App-level seam-3 test (NBK-3): renders the real shell through the real
// app routes and auth guard, mocking only the generated ng-openapi-gen
// AuthService/NotebooksService clients — proves "a logged-in user sees an
// authenticated shell, a logged-out user is redirected to sign-in".

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

    expect(screen.getByText(APP_NAME)).toBeTruthy();
    expect(avatarFor('ada@example.com')).toBeTruthy();
  });

  // NBK-59: the mark carries the name for assistive tech, so the visible
  // name beside it must stay out of the link's name or it is read twice.
  it('links the cat mark and name, announced once, to the Notebooks home', async () => {
    await renderSignedIn('ada@example.com');

    const home = screen.getByRole('link', { name: APP_NAME });
    expect(home.getAttribute('href')).toBe('/');
    expect(screen.getByRole('img', { name: APP_NAME }).closest('a')).toBe(home);
  });

  // Spec 06: the title bar shows the same mark as the empty states, so it is
  // the one <app-copycat-mark> — here at 24 px and named, not decorative.
  it('shows the shared cat mark at 24 px in the title bar', async () => {
    await renderSignedIn('ada@example.com');

    const home = screen.getByRole('link', { name: APP_NAME });
    const mark = within(home).getByTestId('copycat-mark') as HTMLImageElement;
    expect(mark.getAttribute('src')).toBe('/copycat-mark.svg');
    expect(mark.getAttribute('height')).toBe('24');
    expect(mark.getAttribute('aria-hidden')).toBeNull();
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

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Account menu/ })).toBeNull();
  });

  it('shows two initials for a dotted e-mail local part', async () => {
    await renderSignedIn('jane.doe@example.com');

    expect(avatarFor('jane.doe@example.com').textContent?.trim()).toBe('JD');
  });

  // NBK-61: pages put the default title back themselves when they go, so
  // the router leaving a titled page for the Notebooks home must not leave
  // the Notebook's title in the tab.
  it('shows the default browser title on the Notebooks home after leaving a titled page', async () => {
    document.title = 'A stale title';
    const notebookId = '11111111-1111-1111-1111-111111111111';
    const { navigate } = await render(App, {
      providers: [
        provideAppIcons(),
        {
          provide: AuthService,
          useValue: {
            getCurrentUser: vi.fn().mockResolvedValue({
              id: '1',
              email: 'ada@example.com',
              createdAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        },
        {
          provide: NotebooksService,
          useValue: {
            listNotebooks: vi
              .fn()
              .mockResolvedValue([
                { id: notebookId, title: 'Research', createdAt: '2026-01-01T00:00:00.000Z' },
              ]),
          },
        },
        { provide: SearchService, useValue: { searchNotebook: vi.fn() } },
      ],
      routes,
    });
    await navigate(`/notebooks/${notebookId}/search`);
    await waitFor(() => expect(document.title).toBe(`Research – ${APP_NAME}`));

    fireEvent.click(screen.getByRole('link', { name: APP_NAME }));

    expect(await screen.findByRole('heading', { name: 'Notebooks' })).toBeTruthy();
    expect(document.title).toBe(APP_NAME);
  });

  it('redirects to the sign-in page when no session exists', async () => {
    const getCurrentUser = vi.fn().mockRejectedValue({ status: 401 });

    await render(App, {
      providers: [{ provide: AuthService, useValue: { getCurrentUser } }],
      routes,
    });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('Notebooks')).toBeNull();
  });
});
