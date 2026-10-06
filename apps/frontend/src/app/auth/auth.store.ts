import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { AuthService } from '../api/services/auth.service';
import { errorMessage } from '../shared/error-message';

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
  // Whether checkSession() has resolved at least once. The auth guard uses
  // this to avoid re-checking on every navigation within the same app load.
  checked: boolean;
}

const initialState: AuthState = {
  user: null,
  loading: false,
  error: null,
  checked: false,
};

/**
 * Holds the current session (NBK-3): who's logged in (if anyone), fetched
 * and mutated exclusively through the generated ng-openapi-gen AuthService.
 * The auth guard and the login/register pages all read/drive this store.
 */
export const AuthStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withMethods((store, authService = inject(AuthService)) => ({
    async register(email: string, password: string): Promise<void> {
      patchState(store, { loading: true, error: null });
      try {
        await authService.register({ body: { email, password } });
        patchState(store, { loading: false });
      } catch (err) {
        patchState(store, { loading: false, error: errorMessage(err, 'Registration failed.') });
        throw err;
      }
    },

    async login(email: string, password: string): Promise<void> {
      patchState(store, { loading: true, error: null });
      try {
        const user = await authService.login({ body: { email, password } });
        patchState(store, { user, loading: false, checked: true });
      } catch (err) {
        patchState(store, {
          loading: false,
          error: errorMessage(err, 'Invalid email or password.'),
        });
        throw err;
      }
    },

    async logout(): Promise<void> {
      try {
        await authService.logout();
      } finally {
        patchState(store, { user: null, checked: true });
      }
    },

    /**
     * Resolves whether a session cookie identifies a logged-in user.
     * Idempotent per app load: once `checked` is true it's a no-op, so the
     * guard can call this on every navigation without refetching.
     */
    async checkSession(): Promise<void> {
      if (store.checked()) return;
      try {
        const user = await authService.getCurrentUser();
        patchState(store, { user, checked: true });
      } catch {
        patchState(store, { user: null, checked: true });
      }
    },
  })),
);
