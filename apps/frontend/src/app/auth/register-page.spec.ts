import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import { RegisterPage } from './register-page';
import { AuthService } from '../api/services/auth.service';

@Component({ selector: 'app-dummy-login', standalone: true, template: 'Login shell' })
class DummyLoginPage {}

// Seam-3 test (per NBK-1's testing decisions): render the real page +
// SignalStore through real routing, mocking only the generated
// ng-openapi-gen AuthService.
describe('RegisterPage', () => {
  it('registers and navigates to the login route on success', async () => {
    const register = vi.fn().mockResolvedValue({
      id: '1',
      email: 'ada@example.com',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    await render(RegisterPage, {
      providers: [{ provide: AuthService, useValue: { register } }],
      routes: [
        { path: 'login', component: DummyLoginPage },
        { path: 'register', component: RegisterPage },
      ],
      initialRoute: 'register',
    });

    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.input(screen.getByLabelText('Password'), {
      target: { value: 'correct-horse-battery-staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

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

    await render(RegisterPage, {
      providers: [{ provide: AuthService, useValue: { register } }],
      routes: [
        { path: 'login', component: DummyLoginPage },
        { path: 'register', component: RegisterPage },
      ],
      initialRoute: 'register',
    });

    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.input(screen.getByLabelText('Password'), {
      target: { value: 'correct-horse-battery-staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    expect(await screen.findByText('An account with this email already exists.')).toBeTruthy();

    const router = TestBed.inject(Router);
    expect(router.url).toBe('/register');
  });
});
