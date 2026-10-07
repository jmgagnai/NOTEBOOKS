import { Component, input } from '@angular/core';

/**
 * PROTOTYPE — throwaway. Inline 20 px stroke icons approximating the Fluent
 * UI System Icons set (spec 01). The real implementation registers the MIT
 * SVGs through Material's icon registry; these hand-drawn paths exist only
 * so the prototype's iconography reads as Fluent rather than Material.
 */
const PATHS: Record<string, string> = {
  add: 'M10 4v12M4 10h12',
  search: 'M8.5 3a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM12.5 12.5 17 17',
  'more-horizontal': 'M5 10h.01M10 10h.01M15 10h.01',
  delete: 'M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10M9 9v4M11 9v4',
  download: 'M10 3v10M6 9l4 4 4-4M4 16h12',
  open: 'M11 4h5v5M16 4l-7 7M14 11v4H5V6h4',
  send: 'M3 10 17 3l-3 14-4-6-7-1z',
  'chevron-down': 'M5 8l5 5 5-5',
  'chevron-right': 'M8 5l5 5-5 5',
  'chevron-left': 'M12 5l-5 5 5 5',
  'arrow-left': 'M16 10H4M9 5l-5 5 5 5',
  document: 'M6 3h5l4 4v10H6zM11 3v4h4',
  sparkle:
    'M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6zM15.5 14l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
  dismiss: 'M5 5l10 10M15 5 5 15',
  checkmark: 'M4 10.5l4 4 8-9',
  warning: 'M10 3 18 17H2zM10 8v4M10 14.5v.01',
  'panel-left-contract': 'M3 5h14v10H3zM8 5v10M13 8l-2 2 2 2',
  'panel-left-expand': 'M3 5h14v10H3zM8 5v10M11 8l2 2-2 2',
  chat: 'M4 4h12v9H8l-4 3z',
  notebook: 'M5 3h10v14H5zM5 7h2M5 10h2M5 13h2M9 3v14',
  filter: 'M3 5h14l-5.5 6v5l-3-1.5V11z',
  rename: 'M12 4l4 4-8 8H4v-4zM11 5l4 4',
  'arrow-up': 'M10 16V4M5 9l5-5 5 5',
  attach: 'M14 9l-5.5 5.5a2.5 2.5 0 0 1-3.5-3.5L11 5a1.7 1.7 0 0 1 2.4 2.4l-5.5 5.5',
  history: 'M4 10a6 6 0 1 0 2-4.5M4 4v3h3M10 7v3l2 2',
  person: 'M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 17a6 6 0 0 1 12 0',
};

@Component({
  selector: 'proto-icon',
  standalone: true,
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path [attr.d]="d" />
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      line-height: 0;
      flex: none;
    }
  `,
})
export class ProtoIcon {
  readonly name = input.required<string>();
  readonly size = input(20);

  protected get d(): string {
    return PATHS[this.name()] ?? PATHS['document'];
  }
}
