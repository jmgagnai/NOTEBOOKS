# 01 — Fluent theme and app shell

## Problem Statement

The app is meant to be a clone of Microsoft Copilot Notebooks, but at first
glance it reads as a generic Angular Material demo: violet pill buttons, a
coloured toolbar, elevated cards floating in a white page, oversized
headings, and — because the Roboto webfont is never loaded — Material
components fall back to a serif font (Times) while body text falls back to
Helvetica. A user who knows Copilot Notebooks does not recognise it.

## Solution

Re-theme the existing Angular Material 3 setup so it renders in the Fluent 2
visual language (Segoe UI / system font, Fluent blue accent, 4 px / 8 px
corners, borders instead of shadows, compact density, Fluent icons), and
replace the coloured toolbar by a slim white title bar with an avatar menu.
No component library is swapped; Material stays, re-skinned through its
theme tokens and a small set of global overrides.

## User Stories

1. As a user, I want the app to use my system's UI font (Segoe UI on Windows, San Francisco on macOS), so that it feels like a native Microsoft 365 surface rather than a web demo.
2. As a user, I want the primary colour to be Fluent blue instead of violet, so that buttons and links look like Copilot's.
3. As a user, I want buttons and inputs with small 4 px corners and cards with 8 px corners, so that nothing reads as a Material "pill".
4. As a user, I want surfaces separated by light borders and neutral greys rather than drop shadows, so that the page looks flat and calm like Copilot.
5. As a user, I want a 48 px white title bar with the app name on the left, so that the chrome is light and the content has the room.
6. As a user, I want my identity shown as a round avatar with my initials instead of my full e-mail address in the bar, so that the bar is uncluttered.
7. As a user, I want to click the avatar to see my e-mail address and a "Sign out" action, so that signing out is still one click away.
8. As a user, I want headings sized for a dense productivity app (20 px section titles, 14 px body, 12 px metadata), so that lists and panes hold more without scrolling.
9. As a user, I want icons drawn in the Fluent style, so that the iconography matches Copilot.
10. As a user, I want keyboard focus rings that are visible on every control, so that the re-theme does not regress accessibility — with one exception, the chat composer, which shows focus by darkening its border instead of drawing a ring (spec 04).
11. As a user, I want the same look on every page (sign-in, Notebooks, Notebook, Document, search), so that the app feels like one product.
12. As a user on a narrow window, I want the title bar to keep the avatar reachable, so that I can still sign out on a small screen.
13. As a developer, I want all colours, radii and type sizes defined once as design tokens, so that later specs reuse them instead of hard-coding values.

## Implementation Decisions

**Theme tokens.** The global stylesheet keeps `mat.theme(...)` but switches
the palette to an azure/blue one, the typography to a system-font stack led
by Segoe UI, and density to the compact step. Material's system tokens are
then overridden at the root so every component picks them up:

| Token (intent) | Value |
|---|---|
| Primary / accent | `#0F6CBD`, hover `#115EA3`, pressed `#0C3B5E` |
| Accent tint (selected rows, chips) | `#EBF3FC` |
| Page background (the workspace canvas) | `#F5F5F5` |
| Pane / card surface | `#FFFFFF` |
| Subtle surface (user bubble, hover) | `#F0F0F0` / `#EBEBEB` |
| Border | `#E0E0E0`; strong border `#D1D1D1` |
| Text | `#242424`; secondary `#616161`; disabled `#BDBDBD` |
| Error | `#C50F1F` on `#FDE7E9` |
| Success (`ready`) | `#0E700E` on `#E7F5E7` |
| Corner, controls | 4 px |
| Corner, cards / panes / bubbles | 8 px (bubbles 12 px) |
| Elevation | none; 1 px border instead |
| Font | `"Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif` |
| Type scale | title 20/600, section 16/600, body 14/400, caption 12/400 |

The `corner-full` token is reduced to 4 px so Material's filled and outlined
buttons stop rendering as pills. The Google Fonts `<link>` for Material
Icons is replaced by the Fluent icon set (see below), so no webfont request
to Google remains.

**Icons.** Material Icons are replaced by Fluent UI System Icons (MIT),
consumed as inline SVG through Material's icon registry so existing
`mat-icon` usage keeps working. A small, explicit set is registered (add,
search, more-horizontal, delete, arrow-download, open, send, rename,
chevron-down, notebook, document, sparkle, dismiss, checkmark, warning).

> **Superseded by [spec 07](07-closer-copilot-pass.md)** — see its sidebar (the title bar is replaced).

**App shell.** The toolbar becomes a 48 px white bar with a 1 px bottom
border: the brand cluster on the left (mark + name, defined in spec 06 — until that lands, the name as text, 16/600); on the right an avatar button
(28 px circle, accent background, initials derived from the e-mail's local
part). The avatar opens a Material menu showing the full e-mail (disabled
item) and "Sign out". The pages below the bar are given the page background
and a full-height layout (`100vh - 48px`) so later specs can build panes.

**Focus.** A 2 px focus ring in the text colour on every focusable
control, 1 px offset. The one exception is the chat composer box (spec 04):
it draws no ring, and its border darkens from `#D1D1D1` to `#8A8A8A`
while the textarea has focus, so keyboard focus is still visible without
an outline around the box the user is typing in.

**Buttons.** Three variants are used across the app and later specs refer to
them by name: *primary* (filled accent, white text), *secondary* (white,
1 px border), *subtle* (no border, text only, used for inline actions), plus
*icon button* (32 px square, subtle, with a tooltip carrying the accessible
name).

**Status badge.** A shared badge style replaces the uppercase pill:
sentence case, 12 px, 2 px/8 px padding, 4 px corner, neutral grey by
default, success colours for `ready`, error colours for `failed`,
accent tint for the in-progress statuses. The Documents and Document pages
both use it (the two copies of the badge today are unified).

**Snack bar for undo.** "X deleted — Undo" messages move from inline
paragraphs to a Material snack bar with an "Undo" action, 8 s duration,
anchored bottom-centre. The store state behind undo is unchanged; only the
presentation moves.

## Testing Decisions

- Tests assert behaviour, not styles: the avatar menu exposes the e-mail and
  a "Sign out" control; signing out still navigates to the sign-in page;
  undo via the snack bar restores the deleted Notebook/Document.
- Prior art: the app shell spec and the Notebooks page spec (render real
  page + store, stub the API service). The snack bar is reached through its
  accessible "Undo" button, so existing undo tests change only their query.
- No visual-regression tooling is introduced; the theme is verified by
  review against the Copilot screenshots.
- Accessible names of existing controls are preserved ("Log out" becomes
  "Sign out" — the one copy change, updated in the shell spec).

## Out of Scope

- Dark mode (tokens are structured so it can be added later, but no dark
  palette is defined).
- Replacing Angular Material by Fluent UI Web Components.
- Any change to pages' structure (handled by specs 02–05).
- Localisation of UI copy.

## Further Notes

- Why Material is re-themed rather than replaced by Fluent UI Web
  Components is ADR-0008.
- The tokens, type roles and the four button variants as implemented, with
  their CSS names, are documented in `docs/frontend-theme.md`.

- The serif-font symptom in the screenshots comes from the theme's
  typography pointing at Roboto with no loaded webfont and no fallback in
  the generated tokens; the system-font stack fixes it on every OS.
- Keep the gradient "Copilot sparkle" to one place (the assistant avatar in
  chat, spec 04) so the UI does not become a rainbow.
