import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The mascot's head (`/copycat-mark.svg`, NBK-58) as decoration: spec 06
 * puts it at 64 px above the sentence of each empty state (NBK-62). It is
 * an `<img>` rather than a registered icon because the mascot's palette is
 * fixed, not themed, and spec 06 asks for no icon-registry entry.
 *
 * Always decorative — empty `alt` and `aria-hidden` — because every place it
 * sits already says what it means in text; a named logo is a different use
 * (the sign-in pages' full scene).
 */
@Component({
  selector: 'app-copycat-mark',
  template: `<img
    class="copycat-mark"
    data-testid="copycat-mark"
    src="/copycat-mark.svg"
    alt=""
    aria-hidden="true"
    [width]="size()"
    [height]="size()"
  />`,
  styles: `
    :host {
      display: inline-flex;
    }

    .copycat-mark {
      display: block;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CopycatMark {
  /** Edge in px; the head is square. Spec 06 sizes empty states at 64. */
  readonly size = input(64);
}
