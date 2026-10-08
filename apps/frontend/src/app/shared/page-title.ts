import { DestroyRef, effect, EffectRef, inject, Injectable } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { APP_NAME } from './brand';

/**
 * The browser tab's title (spec 06, NBK-61): "<subject> – Copycat Notebooks"
 * while a page has a subject, "Copycat Notebooks" otherwise. The only place
 * that builds the string, so the suffix and the default cannot drift apart
 * between pages.
 *
 * Deliberately not a router `TitleStrategy`: every titled page takes its
 * subject from data that loads after navigation and changes on a rename,
 * which a route's static `title` cannot express; and a strategy resetting on
 * every navigation would race the pages setting it, and clobber a page the
 * router reuses. Pages restore the default themselves when they go (see
 * `showPageTitle`), so pages without a subject need nothing at all.
 */
@Injectable({ providedIn: 'root' })
export class PageTitle {
  private readonly title = inject(Title);

  /** Shows `subject` with the suffix, or the default when there is none yet. */
  show(subject: string | null | undefined): void {
    this.title.setTitle(subject ? `${subject} – ${APP_NAME}` : APP_NAME);
  }
}

/**
 * Keeps the tab on `subject` for as long as the calling page lives, and puts
 * the default back when it is destroyed — so leaving a Notebook does not leave
 * its title on the Notebooks page. A function rather than a method so each
 * page is one line, held in a field like the pages' other effects; call it in
 * an injection context (a field initializer).
 */
export function showPageTitle(subject: () => string | null | undefined): EffectRef {
  const pageTitle = inject(PageTitle);
  inject(DestroyRef).onDestroy(() => pageTitle.show(null));
  return effect(() => pageTitle.show(subject()));
}
