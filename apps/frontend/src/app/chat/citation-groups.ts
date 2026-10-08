import { Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { Citation } from './chat.store';
import { citationLink, citationName, citationParams, citationTitle } from './citations';

/** The Citations of one answer into one Document Version. */
interface CitationGroup {
  documentVersionId: string;
  filename: string;
  versionNumber: number;
  citations: Citation[];
}

/**
 * The Citations under an answer, one row per Document Version cited
 * (spec 04 "Citation groups", NBK-52): a document icon, the filename, "v<n>"
 * and the marker numbers as chips, each still a link to its own Chunk.
 *
 * Grouped by Version rather than by Document: two Versions of one Document
 * are two different texts, and a row naming a superseded Version is how a
 * reader learns the answer was grounded in the older one.
 */
@Component({
  selector: 'app-citation-groups',
  standalone: true,
  imports: [MatIconModule, RouterLink],
  template: `
    <ul class="citation-groups" aria-label="Citations">
      @for (group of groups(); track group.documentVersionId) {
        <li class="citation-groups__group">
          <mat-icon class="citation-groups__icon" svgIcon="document" aria-hidden="true" />
          <span class="citation-groups__filename">{{ group.filename }}</span>
          <span class="citation-groups__version">v{{ group.versionNumber }}</span>
          <span class="citation-groups__chips">
            @for (citation of group.citations; track citation.id) {
              <!--
                Named after the Chunk, not just "Citation <n>": the bare
                number is the marker's name in the prose, and a chip here
                has no sentence around it to say what it cites.
              -->
              <a
                class="citation-groups__chip"
                data-testid="chat-citation"
                [attr.aria-label]="'Citation ' + citation.marker + ': ' + name(citation)"
                [title]="title(citation)"
                [routerLink]="link(citation)"
                [queryParams]="params(citation)"
                >{{ citation.marker }}</a
              >
            }
          </span>
        </li>
      }
    </ul>
  `,
  styleUrl: './citation-groups.scss',
})
export class CitationGroups {
  readonly notebookId = input.required<string>();
  readonly citations = input.required<Citation[]>();

  protected readonly groups = computed<CitationGroup[]>(() => {
    const byVersion = new Map<string, CitationGroup>();
    // Sorted first, so rows come out in the order of their lowest marker and
    // each row's chips are already ascending.
    for (const citation of [...this.citations()].sort((a, b) => a.marker - b.marker)) {
      const group = byVersion.get(citation.documentVersionId);
      if (group) {
        group.citations.push(citation);
      } else {
        byVersion.set(citation.documentVersionId, {
          documentVersionId: citation.documentVersionId,
          filename: citation.filename,
          versionNumber: citation.versionNumber,
          citations: [citation],
        });
      }
    }
    return [...byVersion.values()];
  });

  protected readonly link = (citation: Citation) => citationLink(this.notebookId(), citation);
  protected readonly params = citationParams;
  protected readonly name = citationName;
  protected readonly title = citationTitle;
}
