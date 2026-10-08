import { afterEveryRender, Component, computed, ElementRef, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Citation } from './chat.store';
import { answerSegments, citationLink, citationParams, citationTitle } from './citations';
import { MarkdownView } from '../documents/markdown-view';

/** Escapes a value for a double-quoted HTML attribute inside Markdown source. */
function escapeAttribute(value: string): string {
  // `|` too: the link may sit in a table row, and the table is split into
  // cells before any inline HTML is recognised.
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;');
}

/**
 * The prose of one answer — or of one streamed block of it — rendered as
 * Markdown with its Citation markers as chips (NBK-52, spec 04
 * "Markdown with Citations").
 *
 * Each marker that has a Citation is swapped for a link *before* parsing,
 * rather than rendered between prose segments, so it survives inside a
 * heading, a list item or a table cell; real answers put markers in table
 * cells, which segment-by-segment rendering would split apart.
 *
 * `MarkdownView` (and `marked` with it) is behind `@defer (on idle)`: the
 * Notebook page is in the initial bundle and that bundle is already over its
 * budget, so the renderer is fetched once the page is idle, in the chunk the
 * lazy Document route already shares. Until then the answer reads as plain
 * wrapped text whose markers are already links, so nothing is unreachable
 * while it loads.
 */
@Component({
  selector: 'app-answer-body',
  standalone: true,
  imports: [MarkdownView, RouterLink],
  templateUrl: './answer-body.html',
  styleUrl: './answer-body.scss',
  host: { '(click)': 'followInAppLink($event)' },
})
export class AnswerBody {
  readonly notebookId = input.required<string>();
  readonly content = input.required<string>();
  readonly citations = input.required<Citation[]>();

  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly segments = computed(() => answerSegments(this.content(), this.citations()));

  /**
   * The answer's Markdown with each resolved marker replaced by an `<a>` to
   * the same URL the router would build for the Citation. Only `href`,
   * `class` and `title` are written: they are what Angular's sanitizer keeps.
   */
  protected readonly markdown = computed(() =>
    this.segments()
      .map(({ text, citation }) =>
        citation
          ? `<a class="answer-body__marker" href="${escapeAttribute(this.href(citation))}"` +
            ` title="${escapeAttribute(citationTitle(citation))}">${citation.marker}</a>`
          : text,
      )
      .join(''),
  );

  protected readonly link = (citation: Citation) => citationLink(this.notebookId(), citation);
  protected readonly params = citationParams;
  protected readonly title = citationTitle;

  constructor() {
    // The sanitizer strips ARIA attributes from rendered HTML, so the
    // accessible name "Citation <n>" is put back on the marker links once
    // they are in the DOM. After every render rather than once, because the
    // deferred renderer arrives — and a streamed block re-renders — on its
    // own schedule.
    afterEveryRender(() => {
      const unnamed = this.host.nativeElement.querySelectorAll<HTMLAnchorElement>(
        'app-markdown-view a.answer-body__marker:not([aria-label])',
      );
      for (const marker of unnamed) {
        marker.setAttribute('aria-label', `Citation ${marker.textContent?.trim()}`);
      }
    });
  }

  /**
   * Clicks on in-app links inside the rendered HTML go through the router:
   * they are plain `<a href>`s, not `routerLink`s, and left alone they would
   * reload the whole app. Modified clicks (new tab, new window) and links
   * that already handled themselves are left to the browser.
   */
  protected followInAppLink(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest('a');
    const href = anchor?.getAttribute('href');
    if (!href || !href.startsWith('/') || href.startsWith('//')) return;
    event.preventDefault();
    void this.router.navigateByUrl(href);
  }

  private href(citation: Citation): string {
    return this.router.serializeUrl(
      this.router.createUrlTree(this.link(citation), { queryParams: citationParams(citation) }),
    );
  }
}
