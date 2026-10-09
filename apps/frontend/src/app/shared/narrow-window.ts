import { DOCUMENT } from '@angular/common';
import { inject } from '@angular/core';

/**
 * Below this viewport width a page starts in its narrow layout: the sidebar
 * as the rail (spec 07 "Collapse"). Mirrors `$stack-below` in
 * notebooks/notebook-detail-page.scss, where the Notebook page stacks its
 * panes, which a TypeScript constant cannot share: change both together.
 */
export const NARROW_BELOW_PX = 900;

/** Whether the window is narrow as the app opens a page; call in an injection context. */
export function isNarrowWindow(): boolean {
  return (inject(DOCUMENT).defaultView?.innerWidth ?? Infinity) < NARROW_BELOW_PX;
}
