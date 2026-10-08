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
  untracked,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChatStore } from './chat.store';
import { NEW_THREAD_TITLE } from './thread-navigator';

/**
 * The question box (NBK-45, spec 04 "Composer"; a Copilot-style pill since
 * NBK-83, spec 07): the growing textarea and the round send button in one
 * box, the keyboard hint and, in an open Thread, the AI caveat under it. It asks
 * in the open Chat Thread, or, on the Notebook landing where none is open,
 * starts one and asks there (NBK-81).
 *
 * Split out of the Thread view so the view's template is the message list
 * and nothing else. It reads the ChatStore directly rather than
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
   * back in if the ask fails (`restoreFailedQuestion`); dropped when
   * another Thread is opened: it was typed into this one.
   */
  protected readonly draft = linkedSignal<string | null, string>({
    source: () => this.store.activeThreadId(),
    computation: () => '',
  });

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

  /**
   * The box is closed while answering, and while a Chat Thread is being
   * started — by this box or the navigator's button — so a second send
   * cannot start a second Thread (spec 07 story 35). With no Thread open it
   * is open: sending starts one (NBK-81).
   */
  protected readonly closed = computed(() => this.answering() || this.store.creatingThread());

  /**
   * Whether a Chat Thread is open: the caveat under the box (spec 07 story
   * 44) is about answers, so it shows where answers are, not on the landing.
   */
  protected readonly threadOpen = computed(() => this.store.activeThreadId() !== null);

  /** Whitespace is not a question: the same rule `send` applies, shown on the button. */
  protected readonly canSend = computed(() => !this.closed() && this.draft().trim().length > 0);

  protected readonly hint = computed(() => {
    if (this.answering()) return 'Answering… the box reopens when the answer is in';
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
   * Takes back the text of a question that failed in the open Thread, so
   * asking again is the retry (spec 04, "a failed ask keeps the draft").
   * Driven by the store rather than by `ask`'s result because the ask can
   * fail while another Thread is open: the text then waits with its own
   * Thread and comes back here when that Thread is next opened (NBK-69
   * story 7), instead of landing in the wrong box or being dropped.
   */
  private readonly restoreFailedQuestion = effect(() => {
    const threadId = this.store.activeThreadId();
    const failed = threadId === null ? undefined : this.store.failedQuestions()[threadId];
    if (!failed) return;
    untracked(() => {
      this.setDraft(failed.content);
      this.store.forgetFailedQuestion(threadId!);
    });
  });

  /**
   * Sends `content` as this user's question and reports whether the
   * exchange landed.
   *
   * With no Thread open (the Notebook landing) it first starts one, titled
   * as the navigator's "New Chat Thread" button titles one, so a Thread is
   * the same thing however it was started — the sequence NBK-54's starter
   * prompts ran, moved here when they went (NBK-81). `createThread` makes the
   * new Thread the open one, which is what the question is then asked in; if
   * it failed, nothing is open, the store's error row says why, and the text
   * stays in the box.
   *
   * The text leaves the box as it is sent, since it now shows in the Thread
   * as the pending question (NBK-70), and comes back through
   * `restoreFailedQuestion` if the ask fails.
   */
  private async ask(content: string): Promise<boolean> {
    const question = content.trim();
    if (!question || this.closed()) return false;
    if (this.store.activeThreadId() === null) {
      await this.store.createThread(this.notebookId(), NEW_THREAD_TITLE);
    }
    const threadId = this.store.activeThreadId();
    if (!threadId) return false;
    this.setDraft('');
    return this.store.sendMessage(this.notebookId(), threadId, question);
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
