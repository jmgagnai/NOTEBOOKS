import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
 * The type step the title is set in, after the places the specs put it:
 * `page` is spec 07's page-title role (40/600, the Notebook landing, NBK-81),
 * `large` a page header title (20/600, the default; the Notebook header's
 * until NBK-82), `medium` a card header (16/600, the Chat Thread title),
 * `small` a card title (14/600, a Notebook card). `page` maps onto `--app-type-page-title`, the others onto
 * the matching `--mat-sys-title-*` role.
 */
export type EditableTitleSize = 'page' | 'large' | 'medium' | 'small';

/**
 * How long a first click waits for a second before it counts as a single
 * one: under the operating systems' double-click intervals (macOS 500 ms at
 * most, Windows 500 ms by default) in practice — two clicks a reader means
 * as one double-click land within about 250 ms — without a single click
 * feeling slow.
 */
const DOUBLE_CLICK_MS = 250;

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
        matTooltipShowDelay="0"
        matTooltipClass="editable-title-tooltip"
        (click)="onClick($event)"
        (dblclick)="onDoubleClick()"
        (keydown.f2)="edit()"
      >
        {{ title() }}
      </button>
    }
  `,
  styleUrl: './editable-title.scss',
  host: {
    '[class.editable-title--page]': 'size() === "page"',
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

  /**
   * What opens the box: a click (the default), or only a double-click, for
   * a title whose single click goes somewhere — then it is `pressed`. F2
   * opens it from the keyboard either way.
   */
  readonly renameOn = input<'click' | 'doubleClick'>('click');

  /** A single click — or Enter or Space — on a title renamed by double-click. */
  readonly pressed = output<void>();

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
  private pendingPress: ReturnType<typeof setTimeout> | null = null;

  // The box appears on demand, so it is focused when it does — otherwise a
  // click on the title would leave the keyboard nowhere.
  // `focus()` as well as `select()`: browsers differ on whether selecting
  // the text also moves the focus, and closing hands the focus back only
  // from a box that had it.
  private readonly cleanup = inject(DestroyRef).onDestroy(() => this.cancelPress());

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
   * A double-click arrives as a first click, a second click, then the
   * dblclick, so a first click waits to see whether a second follows before
   * it counts as a press. Enter or Space on the button (no pointer, `detail`
   * 0) is a press straight away.
   */
  protected onClick(event: MouseEvent): void {
    if (this.renameOn() === 'click') {
      this.edit();
      return;
    }
    this.cancelPress();
    if (event.detail === 0) {
      this.pressed.emit();
    } else if (event.detail === 1) {
      this.pendingPress = setTimeout(() => {
        this.pendingPress = null;
        this.pressed.emit();
      }, DOUBLE_CLICK_MS);
    }
  }

  protected onDoubleClick(): void {
    if (this.renameOn() !== 'doubleClick') return;
    this.cancelPress();
    this.edit();
  }

  private cancelPress(): void {
    if (this.pendingPress !== null) clearTimeout(this.pendingPress);
    this.pendingPress = null;
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
