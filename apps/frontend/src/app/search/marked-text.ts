import { Component, input } from '@angular/core';
import { TextSegment } from './search.store';

/**
 * A message's text with the query's words in bold (NBK-97), from segments
 * rather than markup: interpolated text only, so whatever a message holds —
 * `<script>` included — shows as the characters it is.
 */
@Component({
  selector: 'app-marked-text',
  standalone: true,
  // One line, or the runs pick up spaces between them.
  // prettier-ignore
  template: `@for (segment of segments(); track $index) {@if (segment.match) {@if (marker() === 'mark') {<mark class="search-hit">{{ segment.text }}</mark>} @else {<strong>{{ segment.text }}</strong>}} @else {{{ segment.text }}}}`,
})
export class MarkedText {
  readonly segments = input.required<readonly TextSegment[]>();
  /**
   * How a match shows: bold in a search result's Excerpt, yellow (`<mark>`)
   * where the result opens, inside the Exchange it found.
   */
  readonly marker = input<'strong' | 'mark'>('strong');
}
