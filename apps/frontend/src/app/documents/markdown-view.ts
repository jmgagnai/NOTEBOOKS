import {
  afterNextRender,
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { marked } from 'marked';
import { markHtml } from '../shared/search-words';

/**
 * One top-level block of the rendered Markdown, with the character range of
 * the source it was rendered from.
 *
 * The range is what makes a Citation's character offset addressable in the
 * DOM: `marked`'s lexer hands back tokens whose `raw` strings concatenate
 * back to the exact input, so accumulating their lengths gives every block
 * its true position in the Converted Markdown — no searching, no guessing.
 */
interface MarkdownBlock {
  start: number;
  end: number;
  html: string;
}

/**
 * Blocks in the first slice, `LEAD` of them before the cited one: small, so
 * the reader is at the Chunk at once. Then `SLICE` at a time, larger, since
 * each slice costs a layout of the whole document so far (measured on a
 * 5,000-block Document at a 6× CPU slowdown: the Chunk on screen in 2 s,
 * the rest in 17 s, the page answering between slices).
 */
const FIRST_SLICE = 60;
const LEAD = 20;
const SLICE = 150;

/** The nearest ancestor that scrolls, or the page itself. */
function scrollingAncestor(element: HTMLElement): Element | null {
  for (let el = element.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) {
      return el;
    }
  }
  return document.scrollingElement;
}

/**
 * Renders Markdown as formatted HTML.
 *
 * NBK-1 user story 23: "I want the full Document content rendered with its
 * original structure (headings, tables, etc.), so that long or complex
 * documents stay readable rather than appearing as a wall of text" — and that
 * content can run past 200 pages, so headings and tables are what make it
 * navigable at all. The same component renders the Executive Summary, which
 * is also Markdown.
 *
 * `marked` with GitHub-flavoured tables rather than a hand-rolled renderer:
 * Docling's output uses the full Markdown vocabulary (pipe tables for
 * spreadsheets and PDF tables especially), and half-implementing that is how
 * a document silently renders wrong.
 *
 * It renders one block per top-level Markdown token rather than the document
 * in one piece, which is what lets a Citation (NBK-12) point *into* the
 * rendering. `highlightFrom`/`highlightTo` are a character range in the
 * source — per GLOSSARY.md a Chunk's text is "a verbatim, contiguous slice of
 * the Converted Markdown", so a cited chunk *has* an exact range — and the
 * blocks it overlaps are marked and scrolled to. Splitting by block, rather
 * than by the raw offsets, is deliberate: cutting a table or a list in half
 * at an arbitrary character would render it wrong, while a block boundary is
 * both safe and the unit a reader actually lands on.
 *
 * The HTML goes through Angular's `[innerHTML]` binding, which runs it
 * through Angular's own sanitizer — scripts, event handlers and
 * `javascript:` URLs are stripped, while headings, lists, tables, code and
 * links survive. That is the point of binding rather than
 * `bypassSecurityTrustHtml`: the Converted Markdown is machine-generated from
 * a file a user uploaded, so it is untrusted input and must stay sanitized.
 *
 * And it renders a long document a slice at a time. A 200-page Document is
 * about 5,000 blocks, and creating and sanitising them all in one go froze
 * the page for seconds (11 s at a 6× CPU slowdown) before it could scroll
 * to a Citation. So the first slice is the blocks around the cited one, or
 * the document's start, and the rest is added a slice at a time between
 * tasks, the page staying usable throughout; `progress` says how much is
 * there. Blocks added above the reader's position would push it
 * down, so the view moves by what they added. It does this itself, with the
 * browser's own anchoring turned off for the blocks (markdown-view.scss):
 * Safari does not anchor, and Chrome anchoring as well moved the text twice.
 */
@Component({
  selector: 'app-markdown-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="markdown-view">
    @for (block of shown(); track block.start) {
      <div
        class="markdown-view__block"
        [class.markdown-view__block--cited]="isCited(block)"
        [attr.data-testid]="isCited(block) ? 'cited-passage' : null"
        [innerHTML]="html(block)"
      ></div>
    }
  </div>`,
  styleUrl: './markdown-view.scss',
})
export class MarkdownView {
  readonly markdown = input<string | null>(null);

  /**
   * Start of the character range to mark, in the source Markdown. Null —
   * which is every use but a followed Citation — renders the document with
   * nothing highlighted.
   */
  readonly highlightFrom = input<number | null>(null);
  /** End of that range, exclusive. Falls back to `highlightFrom`. */
  readonly highlightTo = input<number | null>(null);

  /**
   * Words a search found this text by, marked in yellow (`<mark>`): inside
   * the highlighted blocks when a range is highlighted, else everywhere —
   * a chat answer is short, and all of it is the found part.
   */
  readonly markWords = input<readonly string[]>([]);

  /**
   * How much of the document is rendered, from 0 to 1: under 1 while slices
   * are still being added, then 1. A short document is 1 straight away.
   */
  readonly progress = output<number>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** The blocks rendered so far: `first` to `last`, exclusive. */
  private readonly window = signal({ first: 0, last: 0 });
  protected readonly shown = computed(() => {
    const { first, last } = this.window();
    return this.blocks().slice(first, last);
  });
  private pending: ReturnType<typeof setTimeout> | null = null;

  protected readonly blocks = computed<MarkdownBlock[]>(() => {
    const source = this.markdown();
    if (!source) return [];

    // `async: false` keeps this a pure string transform, so it can live in a
    // computed signal instead of needing an async pipe.
    const tokens = marked.lexer(source, { gfm: true });
    let offset = 0;
    const blocks: MarkdownBlock[] = [];
    for (const token of tokens) {
      const start = offset;
      offset += token.raw.length;
      const html = marked.parser([token], { async: false, gfm: true });
      // A `space` token renders to nothing; keeping an empty div would add
      // stray boxes between every paragraph.
      if (html.trim() !== '') blocks.push({ start, end: offset, html });
    }
    return blocks;
  });

  constructor() {
    // A new document starts again from its first slice; so does a new
    // Citation into this one, unless the cited block is already rendered.
    let renderedBlocks: MarkdownBlock[] | null = null;
    effect(() => {
      const blocks = this.blocks();
      const cited = this.highlightFrom() === null ? -1 : blocks.findIndex((b) => this.isCited(b));
      untracked(() => {
        const { first, last } = this.window();
        const alreadyShown = cited >= first && cited < last;
        if (blocks === renderedBlocks && (cited < 0 || alreadyShown)) return;
        renderedBlocks = blocks;
        this.startRendering(cited);
      });
    });
    inject(DestroyRef).onDestroy(() => this.stopRendering());

    // Scrolling is a side effect on the real DOM, so it waits until the
    // blocks are rendered. `scrollIntoView` is called defensively: it is
    // absent in some test environments, and failing to scroll is not worth
    // breaking a render over.
    afterRenderEffect(() => {
      if (this.highlightFrom() === null || this.blocks().length === 0) return;
      this.cited()?.scrollIntoView?.({ block: 'center' });
    });
  }

  /**
   * Renders the first slice — around block `cited`, or from the start when
   * none is — and schedules the rest.
   */
  private startRendering(cited: number): void {
    this.stopRendering();
    const total = this.blocks().length;
    const first = cited < 0 ? 0 : Math.max(0, cited - LEAD);
    this.window.set({ first, last: Math.min(total, first + FIRST_SLICE) });
    this.reportAndContinue();
  }

  /** One more slice below what is rendered, and one above, then the next. */
  private renderMore(): void {
    const total = this.blocks().length;
    const { first, last } = this.window();
    const above = Math.max(0, first - SLICE);
    const anchor = above < first ? this.anchor() : null;
    const scroller = anchor ? scrollingAncestor(this.host.nativeElement) : null;
    const anchorBefore = anchor?.getBoundingClientRect().top ?? 0;
    const scrollBefore = scroller?.scrollTop ?? 0;
    this.window.set({ first: above, last: Math.min(total, last + SLICE) });
    if (anchor && scroller) {
      // What the new blocks above added, taken back off the scroll, so the
      // text the reader is looking at stays where it is. The blocks render
      // up to a frame later, and the reader may scroll meanwhile: the anchor
      // moved by what was added less what they scrolled, so their scroll is
      // added back rather than undone.
      afterNextRender(
        {
          write: () => {
            const scrolled = scroller.scrollTop - scrollBefore;
            const added = anchor.getBoundingClientRect().top - anchorBefore + scrolled;
            if (added !== 0) scroller.scrollTop += added;
          },
        },
        { injector: this.injector },
      );
    }
    this.reportAndContinue();
  }

  private reportAndContinue(): void {
    const total = this.blocks().length;
    const { first, last } = this.window();
    const done = total === 0 || (first === 0 && last === total);
    this.progress.emit(total === 0 ? 1 : (last - first) / total);
    if (!done) this.pending = setTimeout(() => this.renderMore());
  }

  private stopRendering(): void {
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = null;
  }

  /** The first block of the cited range, once rendered. */
  private cited(): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>('[data-testid="cited-passage"]');
  }

  /** The block the reader's position is kept on: the cited one, else the first shown. */
  private anchor(): HTMLElement | null {
    return (
      this.cited() ?? this.host.nativeElement.querySelector<HTMLElement>('.markdown-view__block')
    );
  }

  /** A block's HTML, with the words to mark marked where they belong. */
  protected html(block: MarkdownBlock): string {
    const words = this.markWords();
    if (words.length === 0) return block.html;
    if (this.highlightFrom() !== null && !this.isCited(block)) return block.html;
    return markHtml(block.html, words);
  }

  /** Whether a block overlaps the highlighted range at all. */
  protected isCited(block: MarkdownBlock): boolean {
    const from = this.highlightFrom();
    if (from === null) return false;
    const to = this.highlightTo() ?? from;
    return block.start <= to && block.end > from;
  }
}
