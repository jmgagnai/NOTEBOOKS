import { Routes } from '@angular/router';
import { authGuard } from './auth/auth.guard';
import { LoginPage } from './auth/login-page';
import { RegisterPage } from './auth/register-page';
import { NotebookDetailPage } from './notebooks/notebook-detail-page';
import { NotebooksPage } from './notebooks/notebooks-page';

export const routes: Routes = [
  { path: '', component: NotebooksPage, canActivate: [authGuard] },
  { path: 'notebooks/:notebookId', component: NotebookDetailPage, canActivate: [authGuard] },
  { path: 'login', component: LoginPage },
  { path: 'register', component: RegisterPage },
];
