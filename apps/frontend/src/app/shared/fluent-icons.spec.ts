import { Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { render } from '@testing-library/angular';
import { FLUENT_ICON_NAMES, provideAppIcons } from './fluent-icons';

// NBK-31: the icon set is wired through Material's registry at startup, so
// the seam is `<mat-icon svgIcon="…">` itself with the real provider — a
// registered name renders inline SVG, an unknown one degrades to an empty
// icon instead of breaking the page that holds it.

@Component({
  imports: [MatIconModule],
  template: `<mat-icon [svgIcon]="name()" data-testid="icon" />`,
})
class IconHost {
  readonly name = input.required<string>();
}

async function renderIcon(name: string) {
  const { container } = await render(IconHost, {
    inputs: { name },
    providers: [provideAppIcons()],
  });
  return container.querySelector('[data-testid="icon"]') as HTMLElement;
}

describe('Fluent icons', () => {
  it('renders a registered name as inline SVG', async () => {
    const icon = await renderIcon('add');

    const svg = icon.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 20 20');
  });

  it.each(FLUENT_ICON_NAMES)('registers %s', async (name) => {
    const icon = await renderIcon(name);

    expect(icon.querySelector('svg')).not.toBeNull();
  });

  it('renders an unknown name as an empty icon without throwing', async () => {
    // MatIcon reports an unknown name through Angular's ErrorHandler, which
    // logs; the page itself must keep rendering.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const icon = await renderIcon('no-such-icon');

    expect(icon.querySelector('svg')).toBeNull();
    consoleError.mockRestore();
  });
});
