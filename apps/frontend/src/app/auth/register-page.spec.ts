import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import { RegisterPage } from './register-page';
import { AuthService } from '../api/services/auth.service';
import { APP_NAME } from '../shared/brand';

@Component({ selector: 'app-dummy-login', standalone: true, template: 'Login shell' })
class DummyLoginPage {}

// Seam-3 test (per NBK-1's testing decisions): render the real page +
// SignalStore through real routing, mocking only the generated
// ng-openapi-gen AuthService.

/** Renders the register page at /register with `register` standing in for the API client. */
async function renderRegister(register: ReturnType<typeof vi.fn>) {
  await render(RegisterPage, {
    providers: [{ provide: AuthService, useValue: { register } }],
    routes: [
      { path: 'login', component: DummyLoginPage },
      { path: 'register', component: RegisterPage },
    ],
    initialRoute: 'register',
  });
}

function createAccountWith(email: string, password: string) {
  fireEvent.input(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.input(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
}

describe('RegisterPage', () => {
  // NBK-46: the page says "Create account" (alongside "Sign in" / "Sign
  // out"), shows the app name above the form and switches to sign-in
  // through a link.
  // NBK-60 puts the mascot logo above the name and the descriptive line
  // under it (spec 06).
  it('shows the logo, the app name and the descriptive line above a "Create account" form that links to signing in', async () => {
    await renderRegister(vi.fn());

    expect(screen.getByRole('img', { name: APP_NAME })).toBeTruthy();
    expect(screen.getByText(APP_NAME)).toBeTruthy();
    expect(screen.getByText('A Microsoft Copilot Notebooks clone')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Create account' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();
    expect(screen.getByText('Already have an account?')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
  });

  it('creates the account and navigates to the sign-in route on success', async () => {
    const register = vi.fn().mockResolvedValue({
      id: '1',
      email: 'ada@example.com',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await renderRegister(register);

    createAccountWith('ada@example.com', 'correct-horse-battery-staple');

    expect(register).toHaveBeenCalledWith({
      body: { email: 'ada@example.com', password: 'correct-horse-battery-staple' },
    });

    const router = TestBed.inject(Router);
    await vi.waitFor(() => expect(router.url).toBe('/login'));
  });

  it('shows an error and stays on the page when registration fails', async () => {
    const register = vi
      .fn()
      .mockRejectedValue({ error: { message: 'An account with this email already exists.' } });
    await renderRegister(register);

    createAccountWith('ada@example.com', 'correct-horse-battery-staple');

    expect(await screen.findByText('An account with this email already exists.')).toBeTruthy();

    const router = TestBed.inject(Router);
    expect(router.url).toBe('/register');
  });
});
