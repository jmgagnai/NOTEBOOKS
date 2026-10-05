import { Component, inject, OnInit } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { AuthStore } from './auth/auth.store';

/**
 * The app shell (NBK-3): a toolbar showing who's logged in with a logout
 * action, hosting whichever page the router activates. The authenticated
 * vs. logged-out distinction for the routed content itself is the auth
 * guard's job (see auth/auth.guard.ts) — this component only reflects the
 * session state once resolved.
 */
@Component({
  imports: [MatButtonModule, MatToolbarModule, RouterOutlet],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App implements OnInit {
  protected readonly store = inject(AuthStore);
  private readonly router = inject(Router);

  ngOnInit(): void {
    void this.store.checkSession();
  }

  protected async logout(): Promise<void> {
    await this.store.logout();
    await this.router.navigateByUrl('/login');
  }
}
