import { Component, inject, OnInit } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { AuthStore } from './auth/auth.store';
import { Sidebar } from './shell/sidebar';

/**
 * The app shell (NBK-3): the left sidebar (NBK-79, which replaced the title
 * bar of NBK-30) for whoever is signed in, beside whichever page the router
 * activates. The authenticated vs. signed-out distinction for the routed
 * content itself is the auth guard's job (see auth/auth.guard.ts) — this
 * component only reflects the session state once resolved, which is why the
 * sign-in and register pages show no sidebar.
 */
@Component({
  imports: [RouterOutlet, Sidebar],
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
