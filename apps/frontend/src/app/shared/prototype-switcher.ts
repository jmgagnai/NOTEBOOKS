import { Component, computed, HostListener, input, isDevMode } from '@angular/core';
import { Router } from '@angular/router';

/** One UI variant a prototype offers. */
export interface PrototypeVariant {
  key: string;
  name: string;
}

/**
 * PROTOTYPE — throwaway. The floating bottom bar that flips a page between
 * its UI variants via the `?variant=` query parameter (see
 * .claude/skills/prototype/UI.md). Hidden outside dev builds so a stray merge
 * can never ship it. Navigates by rewriting the current URL's query so it
 * works on any route without depending on `ActivatedRoute` (whose test stubs
 * carry only `snapshot.paramMap`).
 */
@Component({
  selector: 'app-prototype-switcher',
  standalone: true,
  template: `
    @if (visible) {
      <div class="proto-switcher" role="group" aria-label="Prototype variant">
        <button
          type="button"
          class="proto-switcher__arrow"
          aria-label="Previous variant"
          (click)="step(-1)"
        >
          ‹
        </button>
        <span class="proto-switcher__label">{{ label() }}</span>
        <button
          type="button"
          class="proto-switcher__arrow"
          aria-label="Next variant"
          (click)="step(1)"
        >
          ›
        </button>
      </div>
    }
  `,
  styles: `
    .proto-switcher {
      position: fixed;
      // Bottom-left rather than UI.md's bottom-centre: every variant pins
      // its composer bottom-centre, and the bar must not sit on the thing
      // being judged.
      left: 12px;
      bottom: 12px;
      z-index: 10000;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 6px;
      border-radius: 999px;
      background: #111;
      color: #fff;
      font:
        600 12px/1 ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      border: 2px solid #ffd60a;
    }
    .proto-switcher__label {
      padding: 0 8px;
      white-space: nowrap;
    }
    .proto-switcher__arrow {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      border: 0;
      background: #333;
      color: #fff;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
    }
    .proto-switcher__arrow:hover {
      background: #555;
    }
  `,
})
export class PrototypeSwitcher {
  readonly variants = input.required<PrototypeVariant[]>();
  /** The active key; `null` means the page is showing its real, non-prototype rendering. */
  readonly current = input<string | null>(null);

  protected readonly visible = isDevMode();

  protected readonly label = computed(() => {
    const key = this.current();
    const v = this.variants().find((x) => x.key === key);
    return v ? `${v.key} (${v.name})` : 'current (no prototype)';
  });

  constructor(private readonly router: Router) {}

  @HostListener('document:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    if (!this.visible) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
    if (event.key === 'ArrowLeft') this.step(-1);
    if (event.key === 'ArrowRight') this.step(1);
  }

  /** Cycles through [current page, ...variants], wrapping at both ends. */
  protected step(delta: number): void {
    const keys: (string | null)[] = [null, ...this.variants().map((v) => v.key)];
    const at = keys.indexOf(this.current());
    const next = keys[(at + delta + keys.length) % keys.length];
    const tree = this.router.parseUrl(this.router.url);
    const { variant: _dropped, ...rest } = tree.queryParams;
    tree.queryParams = next === null ? rest : { ...rest, variant: next };
    void this.router.navigateByUrl(tree, { replaceUrl: true });
  }
}
