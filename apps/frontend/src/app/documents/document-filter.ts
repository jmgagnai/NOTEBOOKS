import { ChangeDetectionStrategy, Component, model } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

/**
 * The Documents panel's quick filter (NBK-48, spec 03 "Filter"): a
 * search-styled box that narrows the rows by filename as the user types,
 * with a clear control once there is something to clear. It only holds the
 * text; the page does the matching against the list it already has, so a
 * keystroke never reaches the API — finding the words inside Documents is
 * "Search this Notebook" and its own page. Its own component so its styles stay out
 * of the page stylesheet, which is close to its size budget.
 */
@Component({
  selector: 'app-document-filter',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, MatTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-icon class="document-filter__icon" svgIcon="search" />
    <input
      class="document-filter__input"
      type="search"
      aria-label="Filter Documents"
      placeholder="Filter Documents"
      autocomplete="off"
      [value]="query()"
      (input)="query.set($any($event.target).value)"
    />
    @if (query()) {
      <button
        mat-icon-button
        type="button"
        class="document-filter__clear"
        aria-label="Clear filter"
        matTooltip="Clear filter"
        (click)="query.set('')"
      >
        <mat-icon svgIcon="dismiss" />
      </button>
    }
  `,
  styleUrl: './document-filter.scss',
  host: { class: 'document-filter' },
})
export class DocumentFilter {
  /** The text typed so far; two-way bound by the page. */
  readonly query = model('');
}
