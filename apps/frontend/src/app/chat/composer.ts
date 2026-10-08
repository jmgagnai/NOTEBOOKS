import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  linkedSignal,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatStore } from './chat.store';

/**
 * The question box of the open Chat Thread (NBK-45, spec 04 "Composer"):
 * one bordered box holding the growing textarea, the keyboard hint and the
 * icon send button.
 *
 * Split out of the Thread view so the view's template is the message list
 * and nothing else, and so the empty state's starter prompts (spec 04) have
 * one thing to send through. It reads the ChatStore directly rather than
 * taking the open Thread as an input: the draft, the send and the answering
 * state are all facts about the store's open Thread, and a second copy of
 * "which Thread is open" would only be one more thing to keep in step.
 */
@Component({
  selector: 'app-composer',
  standalone: true,
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './composer.html',
  styleUrl: './composer.scss',
})
export class Composer {
  readonly notebookId = input.required<string>();

  protected readonly store = inject(ChatStore);

  /**
   * The question being typed. Moves out of the box on send (NBK-70) and
   * back in if the ask fails, so asking again works; dropped when another
   * Thread is opened: it was asked of this one.
   */
  protected readonly draft = linkedSignal<string | null, string>({
    source: () => this.store.activeThreadId(),
    computation: () => '',
  });

  /** Nothing to ask into until a Chat Thread is open. */
  protected readonly hasThread = computed(() => this.store.activeThreadId() !== null);

  /**
   * The answering state (spec 04): from the send until the recorded answer
   * arrives or the ask fails. That is exactly the store's `sending` — it
   * flips on in `sendMessage` and off when the response settles either way
   * — and deliberately not `streamingAnswer`: a preview can be on screen
   * for someone else's question in this shared Thread, and that must not
   * close this user's box; and a preview that has already finished
   * (`done`) is still not the recorded message the box waits for.
   */
  protected readonly answering = computed(() => this.store.sending());

  /** The box is closed without a Thread to ask into, and while answering. */
  protected readonly closed = computed(() => !this.hasThread() || this.answering());

  /** Whitespace is not a question: the same rule `send` applies, shown on the button. */
  protected readonly canSend = computed(() => !this.closed() && this.draft().trim().length > 0);

  protected readonly hint = computed(() => {
    if (this.answering()) return 'Answering… the box reopens when the answer is in';
    if (!this.hasThread()) return 'Open or start a Chat Thread to ask';
    return 'Enter to send · Shift+Enter for a new line';
  });

  private readonly textarea = viewChild.required<ElementRef<HTMLTextAreaElement>>('textarea');
  private readonly injector = inject(Injector);

  /**
   * Hands focus back when the answering state ends. Disabling the textarea
   * drops its focus, so without this the keyboard would land on the body
   * after every answer. The focus waits for the render that re-enables the
   * box: a focus call on a disabled element is silently ignored.
   */
  private readonly refocusWhenReopened = effect(() => {
    const answering = this.answering();
    if (!answering && this.wasAnswering) {
      afterNextRender(() => this.textarea().nativeElement.focus(), { injector: this.injector });
    }
    this.wasAnswering = answering;
  });
  private wasAnswering = false;

  /**
   * Sends `content` as this user's question in the open Thread and reports
   * whether the exchange landed. Public so a caller outside the box — the
   * empty state's starter prompts (spec 04) — sends through the same path
   * the keyboard does.
   *
   * The text leaves the box as it is sent, since it now shows in the Thread
   * as the pending question (NBK-70), and comes back if the ask fails: a
   * failed ask records nothing, so asking again is the retry (spec 04, "a
   * failed ask keeps the draft"). A starter prompt lands in the box the
   * same way, ready to be asked again.
   */
  async ask(content: string): Promise<boolean> {
    const threadId = this.store.activeThreadId();
    const question = content.trim();
    if (!threadId || !question || this.store.sending()) return false;
    this.setDraft('');
    const landed = await this.store.sendMessage(this.notebookId(), threadId, question);
    // Not into another Thread's box, if one was opened meanwhile: the
    // question was asked of this one.
    if (!landed && this.store.activeThreadId() === threadId) this.setDraft(content);
    return landed;
  }

  /**
   * Enter sends and Shift+Enter breaks the line (spec 04, story 2). Enter
   * pressed to confirm an IME composition is neither: the text is not in
   * the box yet, so that one is left to the editor.
   */
  protected onEnter(event: Event): void {
    const key = event as KeyboardEvent;
    if (key.shiftKey || key.isComposing) return;
    event.preventDefault();
    void this.send();
  }

  protected async send(): Promise<void> {
    await this.ask(this.draft());
  }

  private setDraft(text: string): void {
    this.draft.set(text);
    // The textarea's value follows the next render; its height must too.
    afterNextRender(() => this.fit(), { injector: this.injector });
  }

  /**
   * Grows the textarea with the draft, to the stylesheet's `max-height`
   * (about six lines, story 4), and shrinks it back when lines go. The
   * height is reset first so a shorter draft does not keep the taller box.
   */
  protected fit(): void {
    const el = this.textarea().nativeElement;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }
}
