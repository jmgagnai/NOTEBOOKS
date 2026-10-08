import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import { LoginPage } from './login-page';
import { AuthService } from '../api/services/auth.service';
import { APP_NAME } from '../shared/app-name';

@Component({ selector: 'app-dummy-home', standalone: true, template: 'Home shell' })
class DummyHomePage {}

// Seam-3 test (per NBK-1's testing decisions): render the real page +
// SignalStore through real routing, mocking only the generated
// ng-openapi-gen AuthService — never the store or Router internals.
//
// render() mounts LoginPage directly (not behind a <router-outlet>), so a
// successful navigateByUrl() is observed via the real Router's resulting
// url rather than via a swapped-in DOM (that's covered by the app-level
// shell/guard test instead).

/** Renders the sign-in page at /login with `login` standing in for the API client. */
async function renderLogin(login: ReturnType<typeof vi.fn>) {
  await render(LoginPage, {
    providers: [{ provide: AuthService, useValue: { login } }],
    routes: [
      { path: '', component: DummyHomePage },
      { path: 'login', component: LoginPage },
    ],
    initialRoute: 'login',
  });
}

function signInWith(email: string, password: string) {
  fireEvent.input(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.input(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginPage', () => {
  // NBK-46: the page says "Sign in" to match the shell's "Sign out", shows
  // the app name above the form and switches to register through a link.
  // NBK-60 puts the mascot logo above the name and the descriptive line
  // under it (spec 06).
  it('shows the logo, the app name and the descriptive line above a "Sign in" form that links to creating an account', async () => {
    await renderLogin(vi.fn());

    expect(screen.getByRole('img', { name: 'Copycat Notebooks' })).toBeTruthy();
    expect(screen.getByText(APP_NAME)).toBeTruthy();
    expect(screen.getByText('A Microsoft Copilot Notebooks clone')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByText('No account?')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create one' }).getAttribute('href')).toBe('/register');
  });

  it('signs in and navigates to the home route on success', async () => {
    const login = vi.fn().mockResolvedValue({
      id: '1',
      email: 'ada@example.com',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await renderLogin(login);

    signInWith('ada@example.com', 'correct-horse-battery-staple');

    expect(login).toHaveBeenCalledWith({
      body: { email: 'ada@example.com', password: 'correct-horse-battery-staple' },
    });

    const router = TestBed.inject(Router);
    await vi.waitFor(() => expect(router.url).toBe('/'));
  });

  it('shows an error and stays on the page when sign-in fails', async () => {
    const login = vi.fn().mockRejectedValue({ error: { message: 'Invalid email or password.' } });
    await renderLogin(login);

    signInWith('ada@example.com', 'wrong-password');

    expect(await screen.findByText('Invalid email or password.')).toBeTruthy();

    const router = TestBed.inject(Router);
    expect(router.url).toBe('/login');
  });
});
