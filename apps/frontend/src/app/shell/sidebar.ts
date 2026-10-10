import { DOCUMENT } from '@angular/common';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRouteSnapshot,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
} from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { filter, map } from 'rxjs';
import { NOTEBOOK_PAGE_PATH } from '../app.routes';
import { ThreadNavigator } from '../chat/thread-navigator';
import { Avatar } from '../shared/avatar';
import { APP_NAME } from '../shared/brand';
import { CopycatMark } from '../shared/copycat-mark';
import { isNarrowWindow } from '../shared/narrow-window';

/**
 * Where the browser keeps whether the sidebar is collapsed (NBK-114): only
 * the toggle changes it, so the choice outlasts a page change and a reload.
 */
export const SIDEBAR_COLLAPSED_KEY = 'sidebar.collapsed';

/**
 * The saved choice, or null when there is none. Storage the browser refuses
 * (private mode, a blocked site) reads as no choice: the sidebar is a
 * convenience, never a reason for the shell to fail.
 */
function savedCollapsed(window: Window | null): boolean | null {
  try {
    const saved = window?.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    return saved === 'true' ? true : saved === 'false' ? false : null;
  } catch {
    return null;
  }
}

function saveCollapsed(window: Window | null, collapsed: boolean): void {
  try {
    window?.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    // Not remembered, as before NBK-114; the toggle still works.
  }
}

/** The deepest activated route: the app's routes are flat, so it is the page's. */
function leafOf(route: ActivatedRouteSnapshot): ActivatedRouteSnapshot {
  return route.firstChild ? leafOf(route.firstChild) : route;
}

/**
 * The app's left sidebar (NBK-79, spec 07 "App shell → sidebar"), replacing
 * the title bar: the brand linking home, "Notebooks", "Search" while inside a
 * Notebook, that Notebook's Chat Threads on its page, and the account menu at
 * the bottom. It collapses to an icon rail.
 *
 * The shell sits outside the router outlet, so its own `ActivatedRoute` is
 * the root: it reads the current Notebook from the router's state after each
 * navigation instead. The Chat Threads it shows are the root-provided
 * `ChatStore`'s, which the Notebook page loads — the sidebar only renders
 * them, so collapsing it (which drops the navigator) leaves the open Thread
 * and its live stream alone.
 */
@Component({
  selector: 'app-sidebar',
  imports: [
    Avatar,
    CopycatMark,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatTooltipModule,
    RouterLink,
    RouterLinkActive,
    ThreadNavigator,
  ],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
})
export class Sidebar {
  /** Who is signed in; the shell only renders the sidebar with a session. */
  readonly email = input.required<string>();
  readonly signOut = output();

  protected readonly appName = APP_NAME;

  private readonly router = inject(Router);
  private readonly window = inject(DOCUMENT).defaultView;

  private readonly page = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => leafOf(this.router.routerState.snapshot.root)),
    ),
    { initialValue: leafOf(this.router.routerState.snapshot.root) },
  );

  /** The Notebook the current route is inside, if any. */
  protected readonly notebookId = computed(() => this.page().paramMap.get('notebookId'));

  /**
   * Changed by the toggle alone (NBK-114): no page collapses or expands it.
   * It starts as the user last left it; with nothing saved yet, expanded, or
   * collapsed on a narrow window (spec 07 story 17). A saved choice wins over
   * the window's width, because the user made it.
   */
  protected readonly collapsed = signal(savedCollapsed(this.window) ?? isNarrowWindow());

  /**
   * The page whose open Chat Thread the sidebar switches: the Notebook page
   * (spec 07 story 12) alone. Not Search, and no longer the Document page,
   * which is for reading only (NBK-103).
   */
  protected readonly showsChatThreads = computed(
    () => this.page().routeConfig?.path === NOTEBOOK_PAGE_PATH,
  );

  /** The collapse control's name and tooltip, which say what it will do. */
  protected readonly toggleLabel = computed(() =>
    this.collapsed() ? 'Expand sidebar' : 'Collapse sidebar',
  );

  protected toggle(): void {
    this.collapsed.update((collapsed) => !collapsed);
    saveCollapsed(this.window, this.collapsed());
  }
}
