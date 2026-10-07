import { Component, inject, OnInit } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatToolbarModule } from '@angular/material/toolbar';
import { AuthStore } from './auth/auth.store';
import { Avatar } from './shared/avatar';

/**
 * The app shell (NBK-3): a title bar showing who's signed in behind an
 * avatar menu with a sign-out action (NBK-30), hosting whichever page the
 * router activates. The authenticated vs. signed-out distinction for the
 * routed content itself is the auth guard's job (see auth/auth.guard.ts) —
 * this component only reflects the session state once resolved.
 */
@Component({
  imports: [Avatar, MatIconModule, MatMenuModule, MatToolbarModule, RouterOutlet],
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

  protected async signOut(): Promise<void> {
    await this.store.logout();
    await this.router.navigateByUrl('/login');
  }
}
