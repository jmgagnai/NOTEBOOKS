import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import { LoginPage } from './login-page';
import { AuthService } from '../api/services/auth.service';

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
describe('LoginPage', () => {
  it('logs in and navigates to the home route on success', async () => {
    const login = vi
      .fn()
      .mockResolvedValue({
        id: '1',
        email: 'ada@example.com',
        createdAt: '2026-01-01T00:00:00.000Z',
      });

    await render(LoginPage, {
      providers: [{ provide: AuthService, useValue: { login } }],
      routes: [
        { path: '', component: DummyHomePage },
        { path: 'login', component: LoginPage },
      ],
      initialRoute: 'login',
    });

    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.input(screen.getByLabelText('Password'), {
      target: { value: 'correct-horse-battery-staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(login).toHaveBeenCalledWith({
      body: { email: 'ada@example.com', password: 'correct-horse-battery-staple' },
    });

    const router = TestBed.inject(Router);
    await vi.waitFor(() => expect(router.url).toBe('/'));
  });

  it('shows an error and stays on the page when login fails', async () => {
    const login = vi.fn().mockRejectedValue({ error: { message: 'Invalid email or password.' } });

    await render(LoginPage, {
      providers: [{ provide: AuthService, useValue: { login } }],
      routes: [
        { path: '', component: DummyHomePage },
        { path: 'login', component: LoginPage },
      ],
      initialRoute: 'login',
    });

    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('Invalid email or password.')).toBeTruthy();

    const router = TestBed.inject(Router);
    expect(router.url).toBe('/login');
  });
});
