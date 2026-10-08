import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { SparkleAvatar } from '../shared/sparkle-avatar';

/**
 * The starter prompts (spec 04 "Empty state", stories 20–21). Static on
 * purpose: generating them would cost an LLM call before the reader has
 * asked anything, and spec 04 leaves that out of scope.
 */
export const STARTER_PROMPTS = [
  'Summarize the Documents in this Notebook',
  'What are the key points across these Documents?',
  'What questions do these Documents answer?',
] as const;

/**
 * What the Thread card shows with nothing to read (NBK-54): no open Chat
 * Thread, or an open one with no messages and no answer streaming.
 *
 * It only emits the chosen prompt. Asking — and starting a Thread first
 * when none is open — is the Thread view's job, because the view is what
 * holds the `Composer` the question has to go through; this way a prompt is
 * asked exactly as a typed question is.
 */
@Component({
  selector: 'app-thread-empty-state',
  imports: [SparkleAvatar],
  template: `
    <div class="thread-empty-state">
      <app-sparkle-avatar class="thread-empty-state__sparkle" />
      <p class="thread-empty-state__sentence">Ask anything about the Documents in this Notebook</p>
      <ul class="thread-empty-state__prompts" aria-label="Starter prompts">
        @for (prompt of prompts; track prompt) {
          <li>
            <!--
              Closed while an answer is being written, like the composer:
              a second ask cannot go into a Thread still answering the first.
            -->
            <button
              type="button"
              class="thread-empty-state__prompt"
              [disabled]="disabled()"
              (click)="ask.emit(prompt)"
            >
              {{ prompt }}
            </button>
          </li>
        }
      </ul>
    </div>
  `,
  styleUrl: './thread-empty-state.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThreadEmptyState {
  readonly disabled = input(false);
  readonly ask = output<string>();

  protected readonly prompts = STARTER_PROMPTS;
}
