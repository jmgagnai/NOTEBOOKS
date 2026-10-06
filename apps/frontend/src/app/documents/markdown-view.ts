import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
} from '@angular/core';
import { marked } from 'marked';

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
 */
@Component({
  selector: 'app-markdown-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="markdown-view">
    @for (block of blocks(); track block.start) {
      <div
        class="markdown-view__block"
        [class.markdown-view__block--cited]="isCited(block)"
        [attr.data-testid]="isCited(block) ? 'cited-passage' : null"
        [innerHTML]="block.html"
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

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

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
    // Scrolling is a side effect on the real DOM, so it waits until the
    // blocks are rendered. `scrollIntoView` is called defensively: it is
    // absent in some test environments, and failing to scroll is not worth
    // breaking a render over.
    afterRenderEffect(() => {
      if (this.highlightFrom() === null || this.blocks().length === 0) return;
      const cited = this.host.nativeElement.querySelector<HTMLElement>('[data-testid="cited-passage"]');
      cited?.scrollIntoView?.({ block: 'center' });
    });
  }

  /** Whether a block overlaps the highlighted range at all. */
  protected isCited(block: MarkdownBlock): boolean {
    const from = this.highlightFrom();
    if (from === null) return false;
    const to = this.highlightTo() ?? from;
    return block.start <= to && block.end > from;
  }
}
