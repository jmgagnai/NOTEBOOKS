import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { App } from './app';
import { routes } from './app.routes';
import { AuthService } from './api/services/auth.service';
import { ChatService } from './api/services/chat.service';
import { DocumentsService } from './api/services/documents.service';
import { NotebooksService } from './api/services/notebooks.service';
import { SearchService } from './api/services/search.service';
import { AppEvent, AppEventsService } from './events/app-events.service';
import { provideAppIcons } from './shared/fluent-icons';
import { APP_NAME } from './shared/brand';
import { pinToday } from './chat/chat-panel.spec-helpers';

// App-level seam-3 test (NBK-3): renders the real shell through the real
// app routes and auth guard, mocking only the generated ng-openapi-gen
// clients (and the App Event stream) — proves "a logged-in user sees an
// authenticated shell, a logged-out user is redirected to sign-in". Since
// spec 07 (NBK-79) the shell is a left sidebar, so this is also where the
// sidebar's routes-dependent items are covered: the pages' own tests render
// the pages without the shell.

const NOTEBOOK_ID = '11111111-1111-1111-1111-111111111111';
const RESEARCH = { id: NOTEBOOK_ID, title: 'Research', createdAt: '2026-01-01T00:00:00.000Z' };

function thread(id: string, title: string, createdAt: string) {
  return {
    id,
    notebookId: NOTEBOOK_ID,
    title,
    author: { id: 'user-alice', email: 'alice@example.com' },
    createdAt,
  };
}

/**
 * Renders the shell with a live session for `email` at `url` (the Notebooks
 * home by default), with every client a page of the app can reach stubbed:
 * the Notebook "Research" exists, it has no Documents, and its Chat Threads
 * are `threads`.
 */
async function renderSignedIn(
  email: string,
  { url = '/', threads = [] as unknown[] }: { url?: string; threads?: unknown[] } = {},
) {
  const getCurrentUser = vi.fn().mockResolvedValue({
    id: '1',
    email,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const logout = vi.fn().mockResolvedValue(null);
  const events = new Subject<AppEvent>();

  const rendered = await render(App, {
    providers: [
      provideAppIcons(),
      { provide: AuthService, useValue: { getCurrentUser, logout } },
      {
        provide: NotebooksService,
        useValue: { listNotebooks: vi.fn().mockResolvedValue([RESEARCH]) },
      },
      {
        provide: DocumentsService,
        useValue: {
          listDocuments: vi.fn().mockResolvedValue([]),
          getDocument: vi.fn().mockReturnValue(new Promise(() => {})),
        },
      },
      {
        provide: ChatService,
        useValue: {
          listChatThreads: vi.fn().mockResolvedValue(threads),
          listChatMessages: vi.fn().mockResolvedValue([]),
          createChatThread: vi
            .fn()
            .mockImplementation(({ body }: { body: { title: string } }) =>
              Promise.resolve(thread('thread-started', body.title, '2026-02-01T00:00:00.000Z')),
            ),
        },
      },
      { provide: SearchService, useValue: { searchNotebook: vi.fn() } },
      { provide: AppEventsService, useValue: { stream: () => events.asObservable() } },
    ],
    routes,
  });
  // The Notebooks home's own title, not the sidebar item of the same name.
  await screen.findByRole('heading', { name: 'Notebooks' });
  if (url !== '/') {
    await rendered.navigate(url);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Notebooks' })).toBeNull());
  }
  return rendered;
}

const sidebar = () => screen.getByRole('navigation', { name: 'Sidebar' });

/** A Document page of the Notebook. */
const DOCUMENT_URL = `/notebooks/${NOTEBOOK_ID}/documents/22222222-2222-2222-2222-222222222222`;

/** The Notebook page's chat pane. */
const chatPane = () => screen.getByRole('region', { name: 'Chat' });

const avatarFor = (email: string) =>
  screen.getByRole('button', { name: `Account menu for ${email}` });

const notebooksItem = () => within(sidebar()).getByRole('link', { name: 'Notebooks' });

const collapseToggle = () => within(sidebar()).getByRole('button', { name: /sidebar$/ });

describe('App', () => {
  it('shows the sidebar, and no title bar, when a session exists', async () => {
    await renderSignedIn('ada@example.com');

    expect(within(sidebar()).getByText(APP_NAME)).toBeTruthy();
    expect(
      within(sidebar()).getByRole('button', { name: 'Account menu for ada@example.com' }),
    ).toBeTruthy();
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(document.querySelector('mat-toolbar')).toBeNull();
  });

  // NBK-59: the mark carries the name for assistive tech, so the visible
  // name beside it must stay out of the link's name or it is read twice.
  it('links the cat mark and name, announced once, to the Notebooks home', async () => {
    await renderSignedIn('ada@example.com');

    const home = screen.getByRole('link', { name: APP_NAME });
    expect(home.getAttribute('href')).toBe('/');
    expect(screen.getByRole('img', { name: APP_NAME }).closest('a')).toBe(home);
  });

  // Spec 06: the sidebar shows the same mark as the empty states, so it is
  // the one <app-copycat-mark> — here at 24 px and named, not decorative.
  it('shows the shared cat mark at 24 px in the sidebar', async () => {
    await renderSignedIn('ada@example.com');

    const home = screen.getByRole('link', { name: APP_NAME });
    const mark = within(home).getByTestId('copycat-mark') as HTMLImageElement;
    expect(mark.getAttribute('src')).toBe('/copycat-mark.svg');
    expect(mark.getAttribute('height')).toBe('24');
    expect(mark.getAttribute('aria-hidden')).toBeNull();
  });

  describe('NBK-79: sidebar navigation', () => {
    afterEach(() => vi.useRealTimers());

    it('marks "Notebooks" as the current page on the Notebooks home', async () => {
      await renderSignedIn('ada@example.com');

      expect(notebooksItem().getAttribute('href')).toBe('/');
      expect(notebooksItem().getAttribute('aria-current')).toBe('page');
    });

    it('offers no Search on the Notebooks home', async () => {
      await renderSignedIn('ada@example.com');

      expect(screen.queryByRole('link', { name: 'Search this Notebook' })).toBeNull();
    });

    it("offers Search inside a Notebook, opening that Notebook's search", async () => {
      await renderSignedIn('ada@example.com', { url: `/notebooks/${NOTEBOOK_ID}` });

      const search = within(sidebar()).getByRole('link', { name: 'Search this Notebook' });
      expect(search.getAttribute('href')).toBe(`/notebooks/${NOTEBOOK_ID}/search`);
      expect(notebooksItem().getAttribute('aria-current')).toBeNull();

      fireEvent.click(search);

      expect(await screen.findByRole('searchbox')).toBeTruthy();
      expect(
        within(sidebar())
          .getByRole('link', { name: 'Search this Notebook' })
          .getAttribute('aria-current'),
      ).toBe('page');
    });

    it("lists the Notebook's Chat Threads in the sidebar on the Notebook page", async () => {
      // Midday, so the date is Jan 1 in any time zone; this year, so it
      // shows without one (NBK-98).
      pinToday('2026-06-01T12:00:00.000Z');
      await renderSignedIn('ada@example.com', {
        url: `/notebooks/${NOTEBOOK_ID}`,
        threads: [
          thread('thread-1', 'Revenue questions', '2026-01-01T12:00:00.000Z'),
          thread('thread-2', 'Hiring plan', '2026-01-02T12:00:00.000Z'),
        ],
      });

      const threads = within(sidebar()).getByRole('navigation', { name: 'Chat Threads' });
      expect(within(threads).getByRole('button', { name: 'New Chat Thread' })).toBeTruthy();
      // Loaded by the Notebook page, which opens the newest one (NBK-43).
      const newest = await within(threads).findByRole('button', { name: 'Open Hiring plan' });
      expect(newest.getAttribute('aria-current')).toBe('true');
      expect(within(threads).getByText('alice@example.com · Jan 1')).toBeTruthy();
    });

    it('says so in the sidebar when the Notebook has no Chat Threads', async () => {
      await renderSignedIn('ada@example.com', { url: `/notebooks/${NOTEBOOK_ID}` });

      const threads = within(sidebar()).getByRole('navigation', { name: 'Chat Threads' });
      expect(await within(threads).findByText('No Chat Threads yet.')).toBeTruthy();
    });

    // NBK-103: the Document page is for reading only, so its sidebar lists
    // no Chat Threads — they open on the Notebook page. It starts as the
    // rail there, so this expands it.
    it('shows no Chat Threads on the Document page, even expanded', async () => {
      await renderSignedIn('ada@example.com', {
        url: DOCUMENT_URL,
        threads: [thread('thread-1', 'Revenue questions', '2026-01-01T00:00:00.000Z')],
      });
      fireEvent.click(collapseToggle());

      expect(within(sidebar()).getByRole('link', { name: 'Search this Notebook' })).toBeTruthy();
      expect(screen.queryByRole('navigation', { name: 'Chat Threads' })).toBeNull();
    });

    it('shows no Chat Threads on the Notebooks home', async () => {
      await renderSignedIn('ada@example.com');

      expect(screen.queryByRole('navigation', { name: 'Chat Threads' })).toBeNull();
    });

    it('shows no Chat Threads on the Search page, even inside the Notebook', async () => {
      await renderSignedIn('ada@example.com', { url: `/notebooks/${NOTEBOOK_ID}/search` });

      expect(within(sidebar()).getByRole('link', { name: 'Search this Notebook' })).toBeTruthy();
      expect(screen.queryByRole('navigation', { name: 'Chat Threads' })).toBeNull();
    });
  });

  describe('NBK-79: collapsing the sidebar', () => {
    it('names the toggle for what it does and reports the state', async () => {
      await renderSignedIn('ada@example.com');

      expect(collapseToggle().getAttribute('aria-label')).toBe('Collapse sidebar');
      expect(collapseToggle().getAttribute('aria-expanded')).toBe('true');

      fireEvent.click(collapseToggle());

      expect(collapseToggle().getAttribute('aria-label')).toBe('Expand sidebar');
      expect(collapseToggle().getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps the brand, Notebooks, Search and the avatar as named icons in the rail', async () => {
      await renderSignedIn('ada@example.com', { url: `/notebooks/${NOTEBOOK_ID}` });

      fireEvent.click(collapseToggle());

      // The labels go; every destination stays, under the same name.
      expect(within(sidebar()).queryByText(APP_NAME)).toBeNull();
      expect(within(sidebar()).queryByText('Notebooks')).toBeNull();
      expect(within(sidebar()).queryByText('ada@example.com')).toBeNull();
      expect(screen.getByRole('link', { name: APP_NAME })).toBeTruthy();
      expect(notebooksItem()).toBeTruthy();
      expect(within(sidebar()).getByRole('link', { name: 'Search this Notebook' })).toBeTruthy();
      expect(avatarFor('ada@example.com')).toBeTruthy();
    });

    it('hides the Chat Threads while collapsed, keeping the open Thread', async () => {
      await renderSignedIn('ada@example.com', {
        url: `/notebooks/${NOTEBOOK_ID}`,
        threads: [thread('thread-1', 'Revenue questions', '2026-01-01T00:00:00.000Z')],
      });
      await screen.findByRole('button', { name: 'Open Revenue questions' });

      fireEvent.click(collapseToggle());

      expect(screen.queryByRole('navigation', { name: 'Chat Threads' })).toBeNull();
      // The Thread stays open in the page while its list is out of sight.
      expect(
        within(chatPane()).getByRole('button', {
          name: 'Revenue questions',
        }),
      ).toBeTruthy();

      fireEvent.click(collapseToggle());

      const open = await screen.findByRole('button', { name: 'Open Revenue questions' });
      expect(open.getAttribute('aria-current')).toBe('true');
    });

    // Spec 08 (NBK-86): the Document page gives the reading column the
    // width, so the sidebar gives up its own.
    it('starts as the rail on the Document page, and expands from there', async () => {
      await renderSignedIn('ada@example.com', {
        url: DOCUMENT_URL,
      });

      expect(collapseToggle().getAttribute('aria-expanded')).toBe('false');
      // The rail has no room for the Chat Thread rows (spec 07 story 16).
      expect(screen.queryByRole('navigation', { name: 'Chat Threads' })).toBeNull();
      fireEvent.click(collapseToggle());
      expect(collapseToggle().getAttribute('aria-expanded')).toBe('true');
    });

    describe('on a narrow window', () => {
      let width: number;
      beforeEach(() => {
        width = window.innerWidth;
        window.innerWidth = 800;
      });
      afterEach(() => {
        window.innerWidth = width;
      });

      it('starts collapsed below 900 px', async () => {
        await renderSignedIn('ada@example.com');

        expect(collapseToggle().getAttribute('aria-expanded')).toBe('false');
        expect(within(sidebar()).queryByText(APP_NAME)).toBeNull();
      });
    });
  });

  // Spec 07 (NBK-79): the identity sits at the bottom of the sidebar —
  // avatar and e-mail — and opens the account menu it opened in the title bar.
  it('shows the e-mail beside the avatar and in the account menu', async () => {
    await renderSignedIn('ada@example.com');

    expect(within(avatarFor('ada@example.com')).getByText('ada@example.com')).toBeTruthy();

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

  it('signs out from the avatar menu and lands on the sign-in page, without the sidebar', async () => {
    await renderSignedIn('ada@example.com');

    fireEvent.click(avatarFor('ada@example.com'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Account menu/ })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();
  });

  it('shows two initials for a dotted e-mail local part', async () => {
    await renderSignedIn('jane.doe@example.com');

    expect(within(avatarFor('jane.doe@example.com')).getByText('JD')).toBeTruthy();
  });

  // NBK-61: pages put the default title back themselves when they go, so
  // the router leaving a titled page for the Notebooks home must not leave
  // the Notebook's title in the tab.
  it('shows the default browser title on the Notebooks home after leaving a titled page', async () => {
    document.title = 'A stale title';
    await renderSignedIn('ada@example.com', { url: `/notebooks/${NOTEBOOK_ID}/search` });
    await waitFor(() => expect(document.title).toBe(`Research – ${APP_NAME}`));

    fireEvent.click(screen.getByRole('link', { name: APP_NAME }));

    expect(await screen.findByRole('heading', { name: 'Notebooks' })).toBeTruthy();
    expect(document.title).toBe(APP_NAME);
  });

  it('redirects to the sign-in page, with no sidebar, when no session exists', async () => {
    const getCurrentUser = vi.fn().mockRejectedValue({ status: 401 });

    await render(App, {
      providers: [{ provide: AuthService, useValue: { getCurrentUser } }],
      routes,
    });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('Notebooks')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();
  });
});
