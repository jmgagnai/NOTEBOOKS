import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { COPYCAT_MARK_SRC } from './brand';

/**
 * The mascot's head (NBK-58) wherever the app shows it: 24 px in the
 * sidebar (NBK-59, NBK-79) and 64 px above the sentence of each empty state
 * (NBK-62). It is an `<img>` rather than a registered icon because the mascot's palette is
 * fixed, not themed, and spec 06 asks for no icon-registry entry.
 *
 * Decorative by default — empty `alt` and `aria-hidden` — because an empty
 * state already says what it means in text. Give it a `label` where the mark
 * is what names something: the sidebar's home link takes its name from it.
 */
@Component({
  selector: 'app-copycat-mark',
  template: `<img
    class="copycat-mark"
    data-testid="copycat-mark"
    [src]="src"
    [alt]="label() ?? ''"
    [attr.aria-hidden]="label() ? null : 'true'"
    [height]="size()"
  />`,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }

    /* Sized by height alone: the head is wider than tall (a 120×110
       viewBox), so a square box would letterbox it. */
    .copycat-mark {
      display: block;
      width: auto;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CopycatMark {
  /** Height in px; the width follows the artwork. Empty states use 64. */
  readonly size = input(64);
  /** The accessible name; absent, the mark is decorative. */
  readonly label = input<string>();

  protected readonly src = COPYCAT_MARK_SRC;
}
