import { EnvironmentProviders, inject, provideEnvironmentInitializer } from '@angular/core';
import { MatIconRegistry } from '@angular/material/icon';
import { DomSanitizer } from '@angular/platform-browser';
import { FLUENT_ICONS } from './fluent-icons.generated';

/** A name the registry knows; `<mat-icon svgIcon="…">` takes any of these. */
export type FluentIconName = keyof typeof FLUENT_ICONS;

export const FLUENT_ICON_NAMES = Object.keys(FLUENT_ICONS) as readonly FluentIconName[];

/**
 * Registers the app's icon set (NBK-31, spec 01 "Icons"): Fluent UI System
 * Icons as inline SVG literals in Material's icon registry, so templates use
 * `<mat-icon svgIcon="add" />` by name and nothing is fetched from Google.
 *
 * An environment initializer rather than an `APP_INITIALIZER`: the literals
 * are already in the bundle (see scripts/generate-fluent-icons.mjs), so
 * registration is synchronous and must simply happen before the first
 * `mat-icon` renders — which the root injector's creation guarantees, in the
 * app and in any TestBed that lists this provider.
 *
 * `bypassSecurityTrustHtml` is safe here because the markup is our own
 * build-time copy of the MIT assets, never user or server input.
 */
export function provideAppIcons(): EnvironmentProviders {
  return provideEnvironmentInitializer(() => {
    const registry = inject(MatIconRegistry);
    const sanitizer = inject(DomSanitizer);
    for (const name of FLUENT_ICON_NAMES) {
      registry.addSvgIconLiteral(name, sanitizer.bypassSecurityTrustHtml(FLUENT_ICONS[name]));
    }
  });
}
