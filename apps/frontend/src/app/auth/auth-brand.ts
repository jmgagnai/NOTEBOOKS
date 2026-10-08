import { ChangeDetectionStrategy, Component } from '@angular/core';
import { APP_NAME, COPYCAT_LOGO_SRC } from '../shared/brand';

/**
 * The block that opens the sign-in and register pages: the full mascot logo,
 * the app name and the descriptive line (NBK-60, spec 06). A component rather
 * than markup in each page so the two pages cannot drift apart — the same
 * reason `_auth-page.scss` is shared.
 *
 * The logo is the full scene (`COPYCAT_LOGO_SRC`), not the head-only mark the
 * title bar uses: at 96 px the cat, notebook and pencil read, and spec 06
 * reserves the full scene for these pages. The descriptive line is plain text
 * on purpose — spec 06 forbids any Microsoft or Copilot logo or icon.
 */
@Component({
  selector: 'app-auth-brand',
  template: `
    <img class="auth-brand__logo" [src]="logoSrc" [alt]="appName" width="96" height="96" />
    <p class="auth-brand__name">{{ appName }}</p>
    <p class="auth-brand__line">A Microsoft Copilot Notebooks clone</p>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }

    .auth-brand__logo {
      display: block;
      width: 96px;
      height: 96px;
      margin-bottom: 1rem;
    }

    .auth-brand__name {
      margin: 0;
      font: var(--mat-sys-title-large);
      color: var(--mat-sys-on-surface);
    }

    .auth-brand__line {
      margin: 0.25rem 0 0;
      font: var(--mat-sys-body-medium);
      color: var(--mat-sys-on-surface-variant);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthBrand {
  protected readonly appName = APP_NAME;
  protected readonly logoSrc = COPYCAT_LOGO_SRC;
}
