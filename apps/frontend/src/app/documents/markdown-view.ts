import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { marked } from 'marked';

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
  template: `<div class="markdown-view" [innerHTML]="html()"></div>`,
  styleUrl: './markdown-view.scss',
})
export class MarkdownView {
  readonly markdown = input<string | null>(null);

  protected readonly html = computed(() => {
    const source = this.markdown();
    if (!source) return '';
    // `async: false` keeps this a pure string transform, so it can live in a
    // computed signal instead of needing an async pipe.
    return marked.parse(source, { async: false, gfm: true, breaks: false });
  });
}
