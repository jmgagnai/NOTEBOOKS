import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthStore } from './auth.store';

/**
 * Protects a route behind an active session (NBK-3). Resolves the session
 * once per app load (AuthStore.checkSession() is idempotent after its first
 * resolution) and redirects to /login when no user is logged in.
 */
export const authGuard: CanActivateFn = async () => {
  const store = inject(AuthStore);
  const router = inject(Router);

  await store.checkSession();

  return store.user() !== null ? true : router.createUrlTree(['/login']);
};
