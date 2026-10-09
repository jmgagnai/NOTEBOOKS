import { Router } from '@angular/router';

/**
 * The navigation state a search result opens the Document page with
 * (NBK-103), so its back arrow returns to those results rather than to the
 * Notebook.
 */
export const OPENED_FROM_SEARCH = { openedFromSearch: true } as const;

/**
 * Whether the navigation under way was a search result opened in this run
 * of the app; call while the router is activating the page, the only moment
 * the navigation's state is at hand. A reload restores the history entry's
 * state too, but not the results it pointed back to, so the app's first
 * navigation never counts.
 */
export function isOpenedFromSearch(router: Router): boolean {
  const state = router.currentNavigation()?.extras.state;
  return router.navigated && state?.['openedFromSearch'] === OPENED_FROM_SEARCH.openedFromSearch;
}
