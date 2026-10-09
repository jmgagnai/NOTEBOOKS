import { inject } from '@angular/core';
import { PRIMARY_OUTLET, Router } from '@angular/router';
import { ChatStore } from './chat.store';

/**
 * What a page of the Notebook `notebookId` — the Notebook page, the
 * Document page (spec 08), which shows no Chat Thread since NBK-103 but
 * keeps the open one for the way back — does with the root-provided Chat
 * store when it is destroyed. Call in an injection context; call the result from
 * `ngOnDestroy`.
 *
 * Moving to another page of the same Notebook keeps the open Chat Thread, so
 * a reader who opens a Document, then goes back with its arrow, finds the
 * Thread they were in. Leaving the Notebook drops it, so entering again — this Notebook
 * or another — opens its newest Chat Thread (NBK-43) and never shows one
 * Notebook's Thread in another. The router destroys a page before it creates
 * the next one, so the navigation under way is the only thing that can tell
 * the two apart.
 */
export function injectLeaveChat(notebookId: string): () => void {
  const router = inject(Router);
  const chat = inject(ChatStore);
  return () => {
    // `/notebooks/:notebookId/…`, the shape of NOTEBOOK_PAGE_PATH and the
    // paths under it in app.routes.ts — spelled out here because importing
    // the routes from a page's helper would make an import cycle.
    const next = router.currentNavigation()?.finalUrl;
    const segments = next?.root.children[PRIMARY_OUTLET]?.segments ?? [];
    const staysInNotebook = segments[0]?.path === 'notebooks' && segments[1]?.path === notebookId;
    if (staysInNotebook) chat.stopWatching();
    else chat.reset();
  };
}
