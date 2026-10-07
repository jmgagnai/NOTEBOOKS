# 05 — Notebooks home and sign-in pages

## Problem Statement

The Notebooks page is a 480 px card with a "New Notebook title" field, a
"Create" button and a one-line list ("leblanc Open Rename Delete"). Renaming
swaps the row for a raw input with Save/Cancel. Copilot Notebooks opens on
a page titled "Notebooks" with a "Create notebook" button and a grid of
cards; creating one opens it straight away with an editable title. The
sign-in and register pages are fine structurally but carry the old theme.

## Solution

Make the Notebooks page a full-width home: a page title, a primary
"Create Notebook" button, and a responsive grid of Notebook cards (title,
"Created <date>", "…" menu with Rename and Delete). Creating a Notebook
posts the title "Untitled Notebook" and navigates into it, where the
header title (spec 02) is immediately editable. Inline rename on a card
uses the same editable-title control. Sign-in and register are re-themed
and centred with the app name above the form.

## User Stories

1. As a user, I want the Notebooks page to list Notebooks as cards in a grid, so that it looks like a workspace home rather than a form.
2. As a user, I want one primary "Create Notebook" button at the top, so that creating is obvious and needs no title first.
3. As a user, I want a new Notebook to open immediately with its title editable, so that I name it in context.
4. As a user, I want each card to show the title and the creation date, so that I can tell Notebooks apart.
5. As a user, I want clicking a card to open the Notebook, so that opening is one click.
6. As a user, I want a "…" menu on each card with Rename and Delete, so that the card stays clean.
7. As a user, I want Rename to turn the card title into an input (Enter commits, Escape cancels), so that renaming is quick.
8. As a user, I want "Notebook deleted — Undo" as a snack bar, so that undo is available without a permanent line on the page.
9. As a user with no Notebooks, I want an empty state ("No Notebooks yet") with the Create button, so that the first action is clear.
10. As a user, I want the grid to reflow from four columns on wide screens to one on narrow ones, so that it works on any window.
11. As a keyboard user, I want cards focusable and operable, so that the home is accessible.
12. As a user, I want the sign-in page to show the app name above a centred form with a full-width primary button, so that it matches the rest of the app.
13. As a user, I want "Sign in" / "Create account" wording consistent with the "Sign out" action in the shell, so that the vocabulary is coherent.
14. As a user, I want sign-in errors shown inline under the form in the error colour, so that failures are clear.

## Implementation Decisions

**Home layout.** Page title "Notebooks" (20/600) and the "Create Notebook"
primary button in a header row; below, a CSS grid of cards
(`repeat(auto-fill, minmax(240px, 1fr))`, 16 px gap). The outer Material
card is removed.

**Card.** 8 px corner, 1 px border, white, hover raises the border colour;
content: a notebook icon, the title (14/600, two-line clamp), "Created
<short date>" (12 px secondary), and a "…" icon button (accessible name
"Actions for <title>") opening a menu with "Rename" and "Delete" (menu
items keep the accessible names "Rename <title>" / "Delete <title>"). The
card body is a link to the Notebook route; the menu button stops
propagation.

**Create.** The button calls the existing create with the title
"Untitled Notebook", then navigates to the new Notebook. No title field on
the home page. (The create request requires a non-empty title; nothing in
the contract changes.)

**Rename.** The editable-title control from spec 02 is reused in the card;
commit calls the existing rename, cancel restores.

**Delete / undo.** Existing soft-delete and restore; presentation moves to
the shared snack bar from spec 01.

**Sign-in / register.** Centred 360 px column: app name (20/600) above,
then the form with outlined fields, the primary button full width, the
error paragraph under the fields, and the switch link ("No account? Create
one" / "Already have an account? Sign in"). Copy: "Sign in", "Create
account".

## Testing Decisions

- Seam: the Notebooks page spec and the sign-in/register specs (real page +
  store, stubbed API service).
- Tests to update: creating no longer types a title — it clicks "Create
  Notebook" and asserts the create call carried "Untitled Notebook" and that
  navigation to the new Notebook happened; rename goes through the card
  menu then the editable title; undo goes through the snack bar.
- New tests: the empty state; the card link opens the Notebook; "Log in" →
  "Sign in" copy in the sign-in spec.

## Out of Scope

- Document counts, last-modified dates, owners or thumbnails on cards (the
  list endpoint only returns id, title, createdAt).
- Sorting, filtering or searching Notebooks.
- Deleting a Notebook from inside the Notebook page.

## Further Notes

- Because there is no "get one Notebook" endpoint, the Notebook page still
  resolves its title from the already-loaded list; navigating straight
  after create works because the store adds the created Notebook to that
  list before navigation. The store's create method currently resolves to
  nothing; it needs to return (or expose) the created Notebook's id so the
  page can navigate — a store-level change, not an API one.
