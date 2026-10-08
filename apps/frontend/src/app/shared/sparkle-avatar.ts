import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/**
 * The assistant's 24 px avatar: a sparkle on the Copilot gradient (NBK-44,
 * spec 04 "Message rendering"). Spec 01 confines that gradient to this one
 * element, which is why it is a component of its own rather than a modifier
 * on `Avatar` — nothing else is meant to be able to ask for it.
 *
 * Presentational, like `Avatar`: it is `aria-hidden` because the message it
 * sits beside carries the "Assistant" label in text.
 */
@Component({
  selector: 'app-sparkle-avatar',
  imports: [MatIconModule],
  template: `<span class="sparkle-avatar" aria-hidden="true"><mat-icon svgIcon="sparkle" /></span>`,
  styles: `
    :host {
      display: inline-flex;
    }

    .sparkle-avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--app-copilot-gradient);
      color: var(--mat-sys-on-primary);
    }

    mat-icon {
      width: 14px;
      height: 14px;
      font-size: 14px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SparkleAvatar {}
