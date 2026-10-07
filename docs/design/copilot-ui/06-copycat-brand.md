# 06 — Copycat brand: name, mascot and favicon

## Problem Statement

The app is called "RAG Notebook" and its browser icon is the stock Angular
"A" that `ng new` generates. Neither says what the product is: "RAG" is
engineering jargon, and nothing tells a visitor that this is a deliberate
clone of Microsoft Copilot Notebooks. The result is a UI that is neither
informative nor engaging.

## Solution

Rename the product **Copycat Notebooks** — "copycat" says "clone" in one
word and starts with *Co-* like the product it copies — and give it a
mascot: an orange cat with big round glasses, copying into a notebook with
a pencil. The mascot appears in full on the sign-in and register pages, as
a head-only mark in the title bar, and as a head-on-blue favicon. The
sign-in page carries the descriptive line "A Microsoft Copilot Notebooks
clone" as plain text, so the relationship is stated without putting the
Microsoft brand in the name, the logo or the favicon.

The brand assets are **already produced and checked in** under the design
folder's `brand/` subfolder (see Further Notes). Implementation copies
them into the frontend's static assets and wires them; nothing has to be
drawn.

## User Stories

1. As a visitor, I want the browser tab to show a recognisable cat icon and the title "Copycat Notebooks", so that I can find the tab among others.
2. As a visitor on the sign-in page, I want to see the full mascot, the name and the line "A Microsoft Copilot Notebooks clone", so that I immediately understand what this app is.
3. As a user, I want the title bar to show the cat mark next to "Copycat Notebooks", so that the brand is present on every page without taking room.
4. As a user, I want the browser tab title to be "<Notebook title> – Copycat Notebooks" inside a Notebook and "Copycat Notebooks" elsewhere, so that several tabs are distinguishable.
5. As a user adding the app to a phone home screen or installing it, I want a proper 180 px / 192 px / 512 px icon, so that it does not show a generic letter.
6. As a user, I want the mascot's empty states (no Notebooks, no Documents, empty chat) to reuse the mark, so that the character shows up where the app is otherwise empty.
7. As a screen-reader user, I want the logo image to have the accessible name "Copycat Notebooks" and the decorative uses to be hidden, so that the mascot does not add noise.
8. As a developer, I want the name defined once as a constant and the assets referenced from one place, so that a future rename is a one-line change.
9. As a developer, I want the repository's own README and the frontend's HTML title to use the new name, so that the codebase and the product agree.

## Implementation Decisions

**Name.** The product name is "Copycat Notebooks". A single frontend
constant holds it and every user-facing occurrence (title bar, HTML
`<title>`, sign-in and register pages, document titles) reads it. The
repository name and package names are not changed.

**Descriptive line.** The sign-in and register pages show, under the name,
the line "A Microsoft Copilot Notebooks clone" in secondary text. It is
plain text only: it never appears in the logo, the favicon or the HTML
title, and no Microsoft or Copilot logo or icon is used anywhere.

**Assets.** Four masters are provided, all original artwork:

| Asset | Use | Notes |
|---|---|---|
| `copycat-logo.svg` (+ 512 / 192 PNG, 180 PNG apple-touch) | Sign-in and register pages (96 px), PWA / home-screen icons | Full scene: cat, notebook, pencil on the blue→violet gradient tile |
| `copycat-mark.svg` (+ 240 px PNG) | Title bar (24 px high), empty states (64 px) | Head only, transparent background |
| `copycat-favicon.svg` + `favicon.ico` (16/32/48) + 16 / 32 PNG | Browser tab | Head on a flat `#0F6CBD` rounded square — the full scene is unreadable at 16 px |

They are copied as-is into the frontend's public assets, replacing the
Angular `favicon.ico`. The SVG mark is inlined (or loaded as an `img`) in
the title bar; no icon-font or icon-registry entry is needed for it.

**HTML head.** The index page declares: `<title>Copycat Notebooks</title>`,
the `.ico` favicon plus the SVG favicon as an alternate, the 180 px
apple-touch icon, a `theme-color` of `#0F6CBD`, and a minimal web manifest
(name, short name "Copycat", the 192 / 512 icons, background `#FAFAFA`,
theme `#0F6CBD`, display `standalone`). The leftover Google Fonts
`preconnect` / Material Icons links are removed if spec 01 has not already
done so.

**Title bar.** Left cluster: the mark (24 px high, `alt` "Copycat
Notebooks") followed by the name in 16/600. The cluster is a link to the
Notebooks home. This supersedes the plain text span in spec 01; the rest
of spec 01's shell (avatar menu, 48 px bar) is unchanged.

**Document titles.** A small title service sets `document.title`:
"Copycat Notebooks" by default, "<Notebook title> – Copycat Notebooks" on
the Notebook and search pages, "<filename> – Copycat Notebooks" on the
Document page. Spec 02 referred to "RAG Notebook" for this; this spec is
the source of truth for the suffix.

**Empty states.** The empty-state blocks defined in specs 03, 04 and 05
use the mark at 64 px, `aria-hidden`, above their sentence. Where those
specs said "a Documents icon" or "a sparkle", the mark is used instead;
the gradient sparkle stays for the assistant avatar in chat only.

**Colours.** The mascot's palette is fixed and not themed: fur `#FFB84D`,
line `#242424`, nose `#E86D5A`, pencil `#F5C542`, tile gradient
`#0F6CBD → #5B5FC7`. On the flat favicon the tile is `#0F6CBD`.

**README.** The repository README's first heading and description name
"Copycat Notebooks" and state it is a Microsoft Copilot Notebooks clone;
the rest of the README is untouched.

## Testing Decisions

- Seam: the app shell spec and the sign-in / register page specs (real
  component + store, stubbed API service).
- Tests to add: the shell renders an image with accessible name "Copycat
  Notebooks" linking to the home route; the sign-in page shows the name and
  the descriptive line; the document title is "Copycat Notebooks" on the
  home page and "<title> – Copycat Notebooks" after opening a Notebook (the
  Notebook page spec already renders a titled Notebook, so the assertion
  slots in there).
- Tests to update: any test matching the text "RAG Notebook" (shell spec)
  switches to the constant.
- Asset presence (favicon, manifest) is verified by the build output
  listing, not by unit tests.

## Out of Scope

- Animated mascot or alternative poses.
- A dark-mode variant of the tile (the mark on transparent already works on
  dark surfaces).
- Renaming the repository, packages, Docker services or the Jira project.
- Social-preview / Open Graph images.

## Further Notes

- Asset location: the masters and the exported PNG/ICO files are committed
  in the `brand/` subfolder next to these specs. This is the one place the
  specs name a path, because the files are inputs to the work rather than
  code the work produces. The ticket that wires them copies, it does not
  redraw; if an export is missing, re-export from the SVG master at the
  sizes in the table above.
- Trademark hygiene: "Microsoft" and "Copilot" appear only in the
  descriptive sentence and in documentation. Never in the product name, the
  logo, the favicon, the manifest's names, or the HTML title.
