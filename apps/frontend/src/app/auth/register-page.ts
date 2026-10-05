import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AuthStore } from './auth.store';

/**
 * Lets a new user create an account (NBK-3). Registration doesn't issue a
 * session (only /auth/login does), so on success this sends the user to the
 * login page rather than straight into the authenticated shell.
 */
@Component({
  selector: 'app-register-page',
  standalone: true,
  imports: [
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    RouterLink,
  ],
  templateUrl: './register-page.html',
  styleUrl: './register-page.scss',
})
export class RegisterPage {
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
    void this.doRegister();
  }

  private async doRegister(): Promise<void> {
    try {
      await this.store.register(this.email(), this.password());
      await this.router.navigateByUrl('/login');
    } catch {
      // The error is surfaced via store.error(); nothing further to do here.
    }
  }
}
