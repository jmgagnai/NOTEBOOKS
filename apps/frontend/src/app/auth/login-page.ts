import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AuthStore } from './auth.store';

/**
 * Lets an existing user log in (NBK-3). On success the auth guard lets them
 * through to the authenticated shell; on failure the store's error is shown
 * inline and the user stays on this page.
 */
@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    RouterLink,
  ],
  templateUrl: './login-page.html',
  styleUrl: './login-page.scss',
})
export class LoginPage {
  protected readonly store = inject(AuthStore);
  private readonly router = inject(Router);

  protected readonly email = signal('');
  protected readonly password = signal('');

  protected onEmailInput(event: Event): void {
    this.email.set((event.target as HTMLInputElement).value);
  }

  protected onPasswordInput(event: Event): void {
    this.password.set((event.target as HTMLInputElement).value);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    void this.doLogin();
  }

  private async doLogin(): Promise<void> {
    try {
      await this.store.login(this.email(), this.password());
      await this.router.navigateByUrl('/');
    } catch {
      // The error is surfaced via store.error(); nothing further to do here.
    }
  }
}
