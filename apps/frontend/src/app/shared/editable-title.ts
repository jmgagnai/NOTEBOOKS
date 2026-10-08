import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';

/**
 * The type step the title is set in, after the three places the specs put
 * it: `large` is a page title (20/600, the Notebook header), `medium` a card
 * header (16/600, the Chat Thread title), `small` a card title (14/600, a
 * Notebook card). Each maps onto the matching `--mat-sys-title-*` role.
 */
export type EditableTitleSize = 'large' | 'medium' | 'small';

/**
 * A title that is renamed in place (NBK-41, spec 02 "Header"): a button that
 * reads as text — its accessible name is the title itself, the tooltip says
 * what activating it does — which swaps to a text box prefilled with the
 * title. Enter or leaving the box commits, Escape discards, and a commit
 * that would not change anything (same text, or nothing but whitespace)
 * emits nothing, so a click-and-click-away costs no request.
 *
 * It knows no store: the owner binds `title` and acts on `titleChange`, so
 * the Notebook header, a Notebook card and the Chat Thread title can share
 * it while each commits through its own store.
 */
@Component({
  selector: 'app-editable-title',
  imports: [MatTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (editing()) {
      <input
        #box
        class="editable-title__input"
        type="text"
        [attr.aria-label]="editLabel()"
        [value]="draft()"
        (input)="draft.set($any($event.target).value)"
        (keydown.enter)="commit()"
        (keydown.escape)="cancel()"
        (blur)="commit()"
      />
    } @else {
      <button
        #button
        type="button"
        class="editable-title__button"
        [matTooltip]="tooltip()"
        (click)="edit()"
      >
        {{ title() }}
      </button>
    }
  `,
  styleUrl: './editable-title.scss',
  host: {
    '[class.editable-title--large]': 'size() === "large"',
    '[class.editable-title--medium]': 'size() === "medium"',
    '[class.editable-title--small]': 'size() === "small"',
    '[class.editable-title--editing]': 'editing()',
  },
})
export class EditableTitle {
  /** The title as it stands; what the button reads and what the box opens with. */
  readonly title = input.required<string>();

  /** The box's accessible name, e.g. "Notebook title" — what it is, not what it does. */
  readonly editLabel = input.required<string>();

  /** The button's tooltip, e.g. "Rename Notebook" — what activating it does. */
  readonly tooltip = input('');

  readonly size = input<EditableTitleSize>('large');

  /** The committed title, only when it differs from `title`. */
  readonly titleChange = output<string>();

  /**
   * The box closed, whether committed or discarded (NBK-56): an owner that
   * shows the control only while renaming, like a Notebook card, puts its
   * own title back on this. `refocus` says the box still had the focus
   * (Enter or Escape), so an owner that removes this control has to give the
   * focus a new home; when the box was left for another control it is false,
   * and the focus is already where the user put it.
   */
  readonly editClosed = output<{ refocus: boolean }>();

  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  private readonly box = viewChild<ElementRef<HTMLInputElement>>('box');
  private readonly button = viewChild<ElementRef<HTMLButtonElement>>('button');
  private readonly injector = inject(Injector);

  // The box appears on demand, so it is focused when it does — otherwise a
  // click on the title would leave the keyboard nowhere.
  // `focus()` as well as `select()`: browsers differ on whether selecting
  // the text also moves the focus, and closing hands the focus back only
  // from a box that had it.
  private readonly focusBox = effect(() => {
    const box = this.box()?.nativeElement;
    box?.focus();
    box?.select();
  });

  /**
   * Opens the box, as activating the title does. Public for owners that
   * start the rename from elsewhere — a Notebook card's "…" menu (NBK-56).
   */
  edit(): void {
    this.draft.set(this.title());
    this.editing.set(true);
  }

  /**
   * Enter and leaving the box both commit. Commit is a no-op once the box is
   * gone: Enter closes it, and some browsers then fire the blur of the
   * removed element, which must not rename a second time.
   */
  protected commit(): void {
    if (!this.editing()) return;
    this.close();
    const title = this.draft().trim();
    if (!title || title === this.title()) return;
    this.titleChange.emit(title);
  }

  protected cancel(): void {
    if (!this.editing()) return;
    this.close();
  }

  /**
   * Swaps the box back for the title. Enter and Escape remove the focused
   * box, which would drop the keyboard at the start of the page, so the
   * focus goes back to the title it came from (NBK-41, spec 02); a box left
   * for another control leaves the focus there.
   */
  private close(): void {
    const refocus = this.box()?.nativeElement === document.activeElement;
    this.editing.set(false);
    this.editClosed.emit({ refocus });
    if (refocus) {
      afterNextRender(() => this.button()?.nativeElement.focus(), { injector: this.injector });
    }
  }
}
