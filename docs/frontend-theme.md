# Frontend theme: tokens and button variants

The frontend renders in the Fluent 2 visual language by re-theming Angular
Material (ADR-0008, spec `docs/design/copilot-ui/01-fluent-theme-and-app-shell.md`).
Everything visual is a token defined once in `apps/frontend/src/styles.scss`;
component stylesheets reference tokens and never hard-code a colour, a radius
or a type size. This page is the map a later spec reaches for.

## How the theme is built

`styles.scss` calls `mat.theme(...)` on `html` with the azure palette
(`theme-type: light`, no dark palette), a system-font typography map led by
Segoe UI (`bold-weight` and `medium-weight` both 600) and density `-2`, the
compact step. Material emits its `--mat-sys-*` system tokens; the same `html`
block then overrides them with the values below, so every Material component
picks them up. A few component-level `mat.*-overrides` mixins follow for the
toolbar, cards, buttons and menus.

Density `-2` is what gives 32 px buttons and icon buttons and 48 px outlined
form fields. Material hides the floating label at this density only for the
`fill` appearance, which the app does not use.

## Colour tokens

| Intent | Token | Value |
|---|---|---|
| Primary / accent | `--mat-sys-primary` (`--mat-sys-on-primary` white) | `#0F6CBD` |
| Primary hover / pressed | `--app-primary-hover` / `--app-primary-pressed` | `#115EA3` / `#0C3B5E` |
| Accent tint (selected rows, chips, in-progress badge) | `--mat-sys-primary-container` / `--mat-sys-on-primary-container` | `#EBF3FC` / `#0C3B5E` |
| Page canvas | `--mat-sys-background` (`--mat-sys-on-background`) | `#F5F5F5` (`#242424`) |
| Pane / card surface | `--mat-sys-surface` | `#FFFFFF` |
| Subtle surfaces, lightest to darkest | `--mat-sys-surface-container-low` / `-container` / `-container-high` / `-container-highest` | `#FAFAFA` / `#F5F5F5` / `#F0F0F0` / `#EBEBEB` |
| Neutral chip / badge | `--mat-sys-secondary-container` / `--mat-sys-on-secondary-container` | `#F0F0F0` / `#424242` |
| Text / secondary text | `--mat-sys-on-surface` / `--mat-sys-on-surface-variant` | `#242424` / `#616161` |
| Disabled text | `--app-text-disabled` | `#BDBDBD` |
| Border / strong border | `--mat-sys-outline-variant` / `--mat-sys-outline` | `#E0E0E0` / `#D1D1D1` |
| Error | `--mat-sys-error`, `--mat-sys-error-container` / `--mat-sys-on-error-container` | `#C50F1F`, `#FDE7E9` / `#C50F1F` |
| Success (`ready`) | `--mat-sys-tertiary-container` / `--mat-sys-on-tertiary-container` (`--mat-sys-tertiary`) | `#E7F5E7` / `#0E700E` |
| Dark overlays (tooltip, snack bar) | `--mat-sys-inverse-surface` / `--mat-sys-inverse-on-surface` / `--mat-sys-inverse-primary` | `#242424` / `#FFFFFF` / `#8AB9EA` |

Success lives on Material's tertiary slot because it is the only spare M3
colour role; nothing else in the app uses tertiary.

## Shape and elevation

| Intent | Token | Value |
|---|---|---|
| Controls (buttons, inputs, badges, menus' items) | `--mat-sys-corner-extra-small`, `--mat-sys-corner-small`, `--mat-sys-corner-full` | 4 px |
| Cards, panes, menus | `--mat-sys-corner-medium`, `--mat-sys-corner-large` | 8 px |
| Chat bubbles | `--mat-sys-corner-extra-large` | 12 px |
| Elevation | `--mat-sys-level0` to `--mat-sys-level2` | `none` (a 1 px border instead) |
| Floating overlays (menus, dialogs) | `--mat-sys-level3` to `--mat-sys-level5` | soft shadow |

`corner-full` at 4 px is what keeps Material's filled and outlined buttons
from rendering as pills. Every `mat-card` gets a 1 px `outline-variant`
border and no shadow, whatever its appearance.

## Type scale

Spec 01's four steps are mapped onto the Material roles components already
read. Each role has a shorthand token (`--mat-sys-<role>`, usable as
`font: var(...)`) and `-weight`, `-size`, `-line-height`, `-font` and
`-tracking` parts. Tracking is 0 everywhere.

| Step | Role(s) | Value | Used by |
|---|---|---|---|
| Title | `title-large` | 600 20/28 | `h1`, `mat-card-title`, toolbar |
| Section | `title-medium` | 600 16/22 | `h2`, card subtitles |
| Small title | `title-small`, `label-large` | 600 14/20 | `h3`–`h6`; button labels |
| Body | `body-medium`, `body-large` | 400 14/20 | `body`, inputs, list rows |
| Caption | `body-small`, `label-medium` (600) | 12/16 | metadata, badges, tooltips |

`styles.scss` also styles bare `h1`/`h2`/`h3`–`h6` with the title roles
(font only; margins stay the browser's or the component's), so page headings
sit on the scale without per-page rules. Rendered Markdown
(`markdown-view.scss`) keeps a taller hierarchy for document headings
(`headline-small` 24 px, then `title-large`, `title-medium`).

## Layout tokens

| Token | Value | Meaning |
|---|---|---|
| `--app-title-bar-height` | 48 px | the `mat-toolbar` height; pages fill `100vh` minus it |
| `--app-control-height` | 32 px | buttons, icon buttons, the plain `.app-button` variants |

`app-root` is a flex column; the routed page element (whatever follows the
toolbar) gets `flex: 1 1 auto; min-height: 0`, so a page that wants panes
scrolling inside the viewport sets `height: 100%` (or `display: flex`) on its
own root and lets the children scroll. `body` carries the page canvas colour.

## Focus

Every focusable control shows `outline: 2px solid var(--mat-sys-on-surface)`
at `outline-offset: 1px` on `:focus-visible`. Material buttons are named
explicitly (`.mat-mdc-button-base:focus-visible`) because `.mdc-button`
resets `outline`. `matInput` inside a `mat-form-field` is excluded: the field
draws its own focused outline. The chat composer (spec 04) is the intended
exception and opts out with its own `.<class>:focus-visible { outline: none }`
rule, darkening its border instead.

## Button variants

Four variants, by name. On Material buttons they are the directives; on plain
`<button>`/`<a>` elements (panes built outside Material) they are the
`.app-button` classes, drawn from the same tokens.

| Variant | Material directive | Plain class | Look |
|---|---|---|---|
| Primary | `mat-flat-button` | `.app-button .app-button--primary` | filled `primary`, white text; hover `--app-primary-hover`, pressed `--app-primary-pressed` |
| Secondary | `mat-stroked-button` | `.app-button .app-button--secondary` | white, 1 px `outline` border, text colour |
| Subtle | `mat-button` | `.app-button` alone | no border, text colour; hover `surface-container-high` |
| Icon button | `mat-icon-button` | `.app-button .app-button--icon` | 32 px square, subtle, 20 px icon; needs a `matTooltip` carrying the accessible name |

All variants are 32 px high with 4 px corners and a 14/600 label; disabled
state uses `--app-text-disabled` on `surface-container-high` (primary) or a
transparent / `outline-variant` border (others). The `color="primary"`
attribute on a Material button or toolbar does nothing under an M3
`mat.theme` and can be dropped when a template is next touched.

## Material components with Fluent overrides

- `mat-toolbar`: white, text colour, 48 px (`--app-title-bar-height`), 1 px
  bottom border.
- `mat-card`: white, 8 px, 1 px border, no shadow.
- Menus (`.mat-mdc-menu-panel`): white, 8 px, 1 px border, `level3` shadow.
- Tooltips and the snack bar: dark `inverse-surface` on light, via the system
  tokens alone.

## Adding a token

Add it to the `html` block in `styles.scss` next to its neighbours, as a
`--mat-sys-*` override when Material has a slot for the intent and as an
`--app-*` token otherwise; then add the row here. Never introduce a hex value
in a component stylesheet.
