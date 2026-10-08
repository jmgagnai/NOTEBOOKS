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
  template: `@for (segment of segments(); track $index) {@if (segment.match) {<strong>{{ segment.text }}</strong>} @else {{{ segment.text }}}}`,
})
export class MarkedText {
  readonly segments = input.required<TextSegment[]>();
}
