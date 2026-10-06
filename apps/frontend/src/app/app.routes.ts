import { Routes } from '@angular/router';
import { authGuard } from './auth/auth.guard';
import { LoginPage } from './auth/login-page';
import { RegisterPage } from './auth/register-page';
import { NotebookDetailPage } from './notebooks/notebook-detail-page';
import { NotebooksPage } from './notebooks/notebooks-page';

export const routes: Routes = [
  { path: '', component: NotebooksPage, canActivate: [authGuard] },
  { path: 'notebooks/:notebookId', component: NotebookDetailPage, canActivate: [authGuard] },
  // Opening a Document (NBK-7): its Executive Summary first, with an action
  // to expand to the full Converted Markdown.
  //
  // Lazily loaded, unlike the routes above: this is the only page that needs
  // a Markdown renderer, so `marked` stays out of the initial bundle and is
  // fetched by the users who actually open a Document.
  {
    path: 'notebooks/:notebookId/documents/:documentId',
    loadComponent: () => import('./documents/document-detail-page').then((m) => m.DocumentDetailPage),
    canActivate: [authGuard],
  },
  { path: 'login', component: LoginPage },
  { path: 'register', component: RegisterPage },
];
