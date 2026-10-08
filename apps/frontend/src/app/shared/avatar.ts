import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Initials for an avatar, from an e-mail's local part: "jane.doe@x" → "JD",
 * "ada@x" → "A". Only the separators people actually put between name parts
 * (dot, underscore, dash) split; a bare local part gives one letter rather
 * than two, since "AD" for "ada" would read as someone else's initials.
 */
export function initials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 1);
  return letters.toUpperCase();
}

/**
 * A 28 px accent circle carrying a user's initials (NBK-30, spec 01 "App
 * shell"). Presentational only: it is `aria-hidden` because the control that
 * wraps it (the sidebar's account button, a message author line
 * as well) names the user in full, so a screen reader never hears "A" alone.
 */
@Component({
  selector: 'app-avatar',
  template: `<span class="avatar" aria-hidden="true">{{ initials() }}</span>`,
  styles: `
    :host {
      display: inline-flex;
    }

    .avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: var(--app-corner-round);
      background: var(--mat-sys-primary);
      color: var(--mat-sys-on-primary);
      font: var(--mat-sys-label-medium);
      user-select: none;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Avatar {
  readonly email = input.required<string>();
  protected readonly initials = computed(() => initials(this.email()));
}
