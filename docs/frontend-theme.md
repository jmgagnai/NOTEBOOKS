# Frontend theme: tokens and button variants

The frontend renders in the Fluent 2 visual language by re-theming Angular
Material (ADR-0008, spec `docs/design/copilot-ui/01-fluent-theme-and-app-shell.md`).
Everything visual is a token defined once in `apps/frontend/src/styles.scss`;
component stylesheets reference tokens and never hard-code a colour, a radius
or a type size. This page is the map a later spec reaches for.
`pnpm run check:theme` enforces this for colours, corner radii and type sizes;
a deliberate exception carries a `theme-exempt: <why>` comment on its line.

## How the theme is built

`styles.scss` calls `mat.theme(...)` on `html` with the azure palette
(`theme-type: light`, no dark palette), a system-font typography map led by
Segoe UI (`bold-weight` and `medium-weight` both 600) and density `-2`, the
compact step. Material emits its `--mat-sys-*` system tokens; the same `html`
block then overrides them with the values below, so every Material component
picks them up. A few component-level `mat.*-overrides` mixins follow for
cards, buttons and menus.

Density `-2` is what gives 32 px buttons and icon buttons and 48 px outlined
form fields. Material hides the floating label at this density only for the
`fill` appearance, which the app does not use.

## Colour tokens

| Intent | Token | Value |
|---|---|---|
| Primary / accent | `--mat-sys-primary` (`--mat-sys-on-primary` white) | `#0F6CBD` |
| Primary hover / pressed | `--app-primary-hover` / `--app-primary-pressed` | `#115EA3` / `#0C3B5E` |
| Selected navigator row / its hover | `--app-selected-fill` / `--app-selected-fill-hover` | `#D6E8F9` / `#C7DEF6` |
| Accent tint (selected rows, chips, in-progress badge) | `--mat-sys-primary-container` / `--mat-sys-on-primary-container` | `#EBF3FC` / `#0C3B5E` |
| Page background (white since spec 07; was the grey canvas) | `--mat-sys-background` (`--mat-sys-on-background`) | `#FFFFFF` (`#242424`) |
| Pane / card surface | `--mat-sys-surface` | `#FFFFFF` |
| Sidebar surface (spec 07) | `--app-sidebar-surface` | `var(--mat-sys-surface-container)`, `#F5F5F5` |
| Subtle surfaces, lightest to darkest | `--mat-sys-surface-container-low` / `-container` / `-container-high` / `-container-highest` | `#FAFAFA` / `#F5F5F5` / `#F0F0F0` / `#EBEBEB` |
| Neutral chip / badge | `--mat-sys-secondary-container` / `--mat-sys-on-secondary-container` | `#F0F0F0` / `#424242` |
| Text / secondary text | `--mat-sys-on-surface` / `--mat-sys-on-surface-variant` | `#242424` / `#616161` |
| Disabled text | `--app-text-disabled` | `#BDBDBD` |
| Border / strong border | `--mat-sys-outline-variant` / `--mat-sys-outline` | `#E0E0E0` / `#D1D1D1` |
| Chat composer's focused border (in place of a focus ring) | `--app-outline-focus` | `#8A8A8A` |
| Error | `--mat-sys-error`, `--mat-sys-error-container` / `--mat-sys-on-error-container` | `#C50F1F`, `#FDE7E9` / `#C50F1F` |
| Success (`ready`) | `--mat-sys-tertiary-container` / `--mat-sys-on-tertiary-container` (`--mat-sys-tertiary`) | `#E7F5E7` / `#0E700E` |
| Dark overlays (tooltip, snack bar) | `--mat-sys-inverse-surface` / `--mat-sys-inverse-on-surface` / `--mat-sys-inverse-primary` | `#242424` / `#FFFFFF` / `#8AB9EA` |

The primary colour has two copies outside `styles.scss`, because static files
cannot read a token: `index.html`'s `<meta name="theme-color">` (a comment
there names the source) and `theme_color` in `public/manifest.webmanifest`
(JSON carries no comment, hence this note). Change all three together.

Success lives on Material's tertiary slot because it is the only spare M3
colour role; nothing else in the app uses tertiary.

## Shape and elevation

| Intent | Token | Value |
|---|---|---|
| Controls (buttons, inputs, badges, menus' items) | `--mat-sys-corner-extra-small`, `--mat-sys-corner-small`, `--mat-sys-corner-full` | 4 px |
| Menus, inner blocks (panes and `mat-card` are square since spec 07) | `--mat-sys-corner-medium`, `--mat-sys-corner-large` | 8 px |
| Chat bubbles | `--mat-sys-corner-extra-large` | 12 px |
| Fully round: avatars, Citation chips, the composer's send button | `--app-corner-round` | 9999 px |
| The composer's pill (spec 07, the app's one pill) | `--app-corner-pill` | 28 px |
| Elevation | `--mat-sys-level0` to `--mat-sys-level2` | `none` (a 1 px border instead) |
| Floating overlays (menus, dialogs) | `--mat-sys-level3` to `--mat-sys-level5` | soft shadow |

`corner-full` at 4 px is what keeps Material's filled and outlined buttons
from rendering as pills, which is also why anything drawn as a circle
(`<app-avatar>`, `<app-sparkle-avatar>`, the account button) or a round chip
(Citation chips, spec 04) takes `--app-corner-round` instead.

## Flat surfaces

Since spec 07 (NBK-78) the app has no grey canvas and no pane cards: every
page is flat white, and panes are separated by 1 px `outline-variant` lines,
the way Copilot Notebooks looks. `mat-card` is overridden to match (white,
square, no border, no shadow, whatever its appearance), so the Document and
Search pages' cards read as the page itself. On the Notebook page the panes
come from the `card`/`head`/`title`/`body` mixins in
`apps/frontend/src/app/_workspace-card.scss` (white, no border, no corner);
the workspace grid draws the lines by having a 1 px gap over an
`outline-variant` background (there is no page header row since NBK-82).
The only surface that is not white is the sidebar, on
`--app-sidebar-surface`. Items inside a pane (Notebook cards on the home,
search results, the upload batch block) keep their own borders.

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
| Chip number (off the scale) | `label-small` | 600 11/16 | the number in a Citation chip (spec 04, NBK-52) only |

`styles.scss` also styles bare `h1`/`h2`/`h3`–`h6` with the title roles
(font only; margins stay the browser's or the component's), so page headings
sit on the scale without per-page rules. Rendered Markdown
(`markdown-view.scss`) keeps a taller hierarchy for document headings
(`headline-small` 24 px, then `title-large`, `title-medium`).

### Spec 07 roles

Three larger roles for the pages that copy Copilot's big type (spec 07,
NBK-78). No Material component reads them, so they are app tokens:
`--app-type-<role>` is the shorthand (`font: var(--app-type-page-title)`),
with `-weight`, `-size` and `-line-height` parts. They are defined from the
`$app-type-scale` map in `styles.scss`.

| Role | Token | Value | Used by |
|---|---|---|---|
| Page title | `--app-type-page-title` | 600 40/52 | the Notebooks home title and the Notebook landing title only |
| Row title | `--app-type-row-title` | 400 20/28 | a Notebook's title in a row of the home list |
| Reading | `--app-type-reading` | 400 16/26 | questions and answers in a Chat Thread: long prose, generous line height |

The Documents pane does not take the reading role: it keeps the dense 14 px
body (`body-medium`).

## Layout tokens

| Token | Value | Meaning |
|---|---|---|
| `--app-control-height` | 32 px | buttons, icon buttons, the plain `.app-button` variants |
| `--app-icon-size-small` | 14 px | a glyph inside a 24 px avatar (the assistant's sparkle) |
| `--app-copilot-gradient` | azure → violet → magenta at 135° | the Copilot sparkle; used by `<app-sparkle-avatar>` (the assistant's chat avatar) and nowhere else, per spec 01 |

`app-root` is a flex row exactly the viewport high (spec 07, NBK-79): the
sidebar (`app-sidebar`, about 280 px, a 56 px rail when collapsed, on
`--app-sidebar-surface`), then `main.app-shell__main`, a flex column that
scrolls. The routed page element inside it gets `flex: 1 0 auto`, so it is
at least the column's height and a longer page scrolls the column, not the
window. A page that wants panes scrolling inside the viewport sets
`height: 100%` on its own root (as `notebook-detail-page.scss` does) and
lets the children scroll. `body` carries the page background
(`--mat-sys-background`, white since spec 07).

## Focus

Every focusable control shows `outline: 2px solid var(--mat-sys-on-surface)`
at `outline-offset: 1px` on `:focus-visible`. Material buttons are named
explicitly (`.mat-mdc-button-base:focus-visible`) because `.mdc-button`
resets `outline`. `matInput` inside a `mat-form-field` is excluded: the field
draws its own focused outline. `mat-checkbox` keeps its native input
invisible over the box it draws, so there the ring goes on
`.mdc-checkbox__background` (through `:has(:focus-visible)`) instead. The
chat composer (spec 04) is the intended
exception and opts out with its own `.<class>:focus-visible { outline: none }`
rule, darkening its border to `--app-outline-focus` through `:focus-within`
instead (`chat/composer.scss`, NBK-45).

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

## Status badge

One component, `<app-status-badge [status]="…" />`
(`apps/frontend/src/app/shared/status-badge.ts`), renders a Document
Version's ingestion status and an upload step's status everywhere they appear
(spec 01 "Status badge", NBK-32). The host element is the badge: 12/600
`label-medium`, 2 px / 8 px padding, `corner-extra-small`, sentence-case
label (`statusLabel`: "Ready", "Converting", "New version"). Its colour is
the status's *tone* (`statusTone`), carried as a class on the host:

| Tone | Class | Colours | Statuses |
|---|---|---|---|
| neutral | `.app-badge` alone | `secondary-container` | `waiting`, `uploading`, `skipped` |
| in progress | `.app-badge--progress` | `primary-container` (accent tint) | `queued`, `converting`, `converted`, `summarizing`, `summarized`, `indexing` |
| success | `.app-badge--success` | `tertiary-container` | `ready`, `uploaded`, `new-version` |
| error | `.app-badge--error` | `error-container` | `failed` |

Tests query the badge by its label text and read the tone class off the same
element; nothing asserts a colour.

## Icons

The icon set is Fluent UI System Icons (MIT), regular style on a 20 px grid,
registered as inline SVG literals in Material's `MatIconRegistry` by
`provideAppIcons()` (`apps/frontend/src/app/shared/fluent-icons.ts`, listed
in `app.config.ts`; NBK-31, spec 01 "Icons"). A template imports
`MatIconModule` and uses an icon by name:

```html
<mat-icon svgIcon="arrow-left" />
```

Registered names: `add`, `history` (the Chat Threads navigator's title,
NBK-43), `search`, `more-horizontal`, `delete`,
`arrow-download`, `open`, `rename`, `chevron-down`, `notebook`,
`document`, `sparkle`, `dismiss`, `checkmark`, `warning`, `arrow-left`,
`panel-right-contract`, `panel-right-expand`, `sign-out`,
`panel-left-contract` and `panel-left-expand` (the sidebar's collapse
toggle, NBK-79), and the Document
rows' type icons (NBK-42) `document-pdf`, `document-text` (Word),
`document-one-page` (text, Markdown), `document-table` (Excel, CSV), with
`document` for anything else, and `folder` (the Notebook rows on the home
and the Notebook landing, spec 07), and `arrow-up` (the composer's send
button, NBK-83, which retired `send`). `FluentIconName`
is the union of them. An unknown name renders an empty icon and logs through
the `ErrorHandler`; it does not break the page.

`mat-icon` is 20 px globally (and 20 px inside menu items), matching the
icon button's `icon-size`. The icon is `aria-hidden`; an icon-only control
carries its accessible name itself (`aria-label` plus a `matTooltip`), and an
icon beside a label adds nothing to the name.

The literals live in `fluent-icons.generated.ts`, written by
`pnpm --filter frontend icons:generate` from the `@fluentui/svg-icons` dev
dependency (`apps/frontend/scripts/generate-fluent-icons.mjs` holds the name
list). The MIT notice is `fluent-icons.LICENSE.md` beside them. To add an
icon, add its name to the script and regenerate; never edit the generated
file. Nothing is fetched from Google Fonts any more: `index.html` carries no
`<link>` to it.

## Brand

The product is Copycat Notebooks (spec 06). The name and the two mascot
images are constants in `apps/frontend/src/app/shared/brand.ts` — `APP_NAME`,
`COPYCAT_MARK_SRC` and `COPYCAT_LOGO_SRC` — and every template and spec reads
them from there. The only literal copies are in the static files that cannot
import it: `index.html` (`<title>`, favicons) and `public/manifest.webmanifest`.

| Image | Path | Where, at what size |
|---|---|---|
| Mark (the cat's head alone) | `/copycat-mark.svg` (`COPYCAT_MARK_SRC`) | sidebar, 24 px, named by `APP_NAME` as the home link; the two empty states (Notebooks home, a Notebook's Documents panel; the Chat Thread one went in NBK-81), 64 px, decorative |
| Logo (the full scene) | `/copycat-logo.svg` (`COPYCAT_LOGO_SRC`) | sign-in and register pages, 96 px (`<app-auth-brand>`) |

The mark is always `<app-copycat-mark>` (`shared/copycat-mark.ts`), an
`<img>` rather than a registered icon because the mascot's colours are fixed,
not themed. Inputs: `size`, its height in px (default 64; the width follows
the artwork, which is wider than tall), and an optional `label`. Without a
label the mark is decorative (empty `alt`, `aria-hidden`), which is right
wherever text beside it already says what it means; with one, the label is
its `alt`, as in the sidebar where the mark names the home link.

The empty states no longer show the `sparkle` or `document` icons; the mark
replaced them (NBK-62). Both icons stay registered for their other uses.

## Material components with Fluent overrides

- `mat-card`: flat white, square, no border, no shadow (spec 07; was 8 px with a 1 px border).
- Menus (`.mat-mdc-menu-panel`): white, 8 px, 1 px border, `level3` shadow.
- Tooltips: dark `inverse-surface` on light, via the system tokens alone.
- Snack bar (the undo offer after a delete, `shared/undo-snack-bar.ts`):
  the same inverse tokens through `mat.snack-bar-overrides`, with a 13 px
  line — spec 01's one size between the body and caption steps.

## Adding a token

Add it to the `html` block in `styles.scss` next to its neighbours, as a
`--mat-sys-*` override when Material has a slot for the intent and as an
`--app-*` token otherwise; then add the row here. Never introduce a hex value
in a component stylesheet.
