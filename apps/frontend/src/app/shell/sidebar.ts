import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
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
import { DOCUMENT_PAGE_PATH, NOTEBOOK_PAGE_PATH } from '../app.routes';
import { ThreadNavigator } from '../chat/thread-navigator';
import { Avatar } from '../shared/avatar';
import { APP_NAME } from '../shared/brand';
import { CopycatMark } from '../shared/copycat-mark';
import { isNarrowWindow } from '../shared/narrow-window';

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

  private readonly page = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => leafOf(this.router.routerState.snapshot.root)),
    ),
    { initialValue: leafOf(this.router.routerState.snapshot.root) },
  );

  /** The Notebook the current route is inside, if any. */
  protected readonly notebookId = computed(() => this.page().paramMap.get('notebookId'));

  /** Only the Notebook page itself, not its Search or Document pages (spec 07 story 12). */
  protected readonly onNotebookPage = computed(
    () => this.page().routeConfig?.path === NOTEBOOK_PAGE_PATH,
  );

  /**
   * Component state only, like the Documents pane's hidden state: a reload
   * starts expanded again, or collapsed on a narrow window.
   */
  protected readonly collapsed = signal(isNarrowWindow());

  private readonly onDocumentPage = computed(
    () => this.page().routeConfig?.path === DOCUMENT_PAGE_PATH,
  );

  /**
   * Entering the Document page collapses the sidebar to the rail (spec 08),
   * which splits its width between the chat pane and the Document. Only on
   * entering: expanding it there, or moving from one Document to another,
   * is left alone.
   */
  private readonly railOnDocumentPage = effect(() => {
    if (this.onDocumentPage()) this.collapsed.set(true);
  });

  /** The collapse control's name and tooltip, which say what it will do. */
  protected readonly toggleLabel = computed(() =>
    this.collapsed() ? 'Expand sidebar' : 'Collapse sidebar',
  );

  protected toggle(): void {
    this.collapsed.update((collapsed) => !collapsed);
  }
}
