import { Routes } from '@angular/router';
import { authGuard } from './auth/auth.guard';
import { LoginPage } from './auth/login-page';
import { RegisterPage } from './auth/register-page';
import { NotebookDetailPage } from './notebooks/notebook-detail-page';
import { NotebooksPage } from './notebooks/notebooks-page';

/**
 * The Notebook page's route path, exported because the sidebar tells that
 * page apart from the other routes inside a Notebook (spec 07 story 12).
 */
export const NOTEBOOK_PAGE_PATH = 'notebooks/:notebookId';

/**
 * The Document page's route path, exported because the sidebar starts as the
 * rail there (spec 08): that page splits its width between the chat pane and
 * the Document.
 */
export const DOCUMENT_PAGE_PATH = 'notebooks/:notebookId/documents/:documentId';

export const routes: Routes = [
  { path: '', component: NotebooksPage, canActivate: [authGuard] },
  { path: NOTEBOOK_PAGE_PATH, component: NotebookDetailPage, canActivate: [authGuard] },
  // Searching a Notebook's Documents (NBK-9). Its own page rather than a
  // panel on the Notebook, so a search is a place a user can be — and link
  // to — rather than a transient state of the document list.
  {
    path: 'notebooks/:notebookId/search',
    loadComponent: () => import('./search/search-page').then((m) => m.SearchPage),
    canActivate: [authGuard],
  },
  // Opening a Document (NBK-7): its Executive Summary first, with an action
  // to expand to the full Converted Markdown.
  //
  // Lazily loaded, unlike the routes above: this is the only page that needs
  // a Markdown renderer, so `marked` stays out of the initial bundle and is
  // fetched by the users who actually open a Document.
  {
    path: DOCUMENT_PAGE_PATH,
    loadComponent: () =>
      import('./documents/document-detail-page').then((m) => m.DocumentDetailPage),
    canActivate: [authGuard],
  },
  { path: 'login', component: LoginPage },
  { path: 'register', component: RegisterPage },
];
