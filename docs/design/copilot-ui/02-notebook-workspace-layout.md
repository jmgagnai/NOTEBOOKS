# 02 — Notebook workspace layout

## Problem Statement

A Notebook today is one 640 px card the user scrolls through: title, back
link, Documents heading, search link, upload control, undo line, Document
cards with full Abstracts, then — far below — "Chat", the Chat Thread list,
the rename form and the messages. Chat, which is the point of the product,
is off-screen on arrival, and the composer sits wherever the last message
ends. Copilot Notebooks shows the sources and the chat side by side, full
height, with the question box pinned at the bottom.

## Solution

Turn the Notebook page into a full-height workspace: a slim page header,
then three cards on a grey canvas — a **Chat Threads navigator** on the
left, the **open Chat Thread** in the middle, and a **Documents panel** on
the right that can slide away. Each card scrolls independently; the chat
composer is pinned to the bottom of the middle card. The drag-and-drop
upload target becomes the Documents panel. This spec delivers the frame
and moves the existing content into it unchanged; specs 03 and 04 then
redesign the content of the panels.

This is the layout a UI prototype settled: three variants were built on the
real page and the three-column "Threads navigator" won (branch
`prototype/notebook-workspace`, which also holds the rejected variants and
screenshots). The look and the measurements below come from it.

## User Stories

1. As a user opening a Notebook, I want to see its Chat Threads, the open Thread and its Documents at the same time, so that I can ask a question while looking at what it will be grounded in.
2. As a user, I want the page to use the full height of the window with no outer card, so that long Document lists and long Chat Threads get the room they need.
3. As a user, I want the three cards to scroll independently, so that reading a long answer does not scroll my Documents or my Threads out of view.
4. As a user, I want the question box pinned at the bottom of the Thread card, so that I always know where to type.
5. As a user, I want a slim header showing where I am ("Notebooks › <title>") with a back control to the Notebooks list, so that I know where I am and can leave in one click.
6. As a user, I want to rename the Notebook by clicking its title in the header, so that renaming does not need a separate form.
7. As a user, I want "Add Documents" and "Search" as the two actions in the page header, so that the Notebook-level actions are in one place.
8. As a user, I want to hide the Documents panel so that the Thread takes the width when I am reading answers, and a clearly labelled control to bring it back.
9. As a user dragging files over the page, I want the Documents panel (not the whole page) to light up as the drop target, so that it is obvious where the upload goes — and if I had hidden the panel, I want it to slide back in so I can still drop.
10. As a user on a window narrower than ~900 px, I want the cards to stack (Threads, then the open Thread, then Documents as a strip at the bottom), so that the app still works on a laptop half-screen.
11. As a user, I want the Notebook title in the browser tab, so that several open Notebooks are distinguishable.
12. As a keyboard user, I want each card to be a labelled landmark region, so that I can jump between Threads, chat and Documents.
13. As a user, I want card widths to be stable (no layout jump when content loads), so that the page does not flicker.

## Implementation Decisions

> **Superseded by [spec 07](07-closer-copilot-pass.md)** — see its Notebook page frame (two flat panes, no header row).

**Page structure.** The Notebook page becomes a column: a 48 px header,
then a CSS grid with three columns (`240px 1fr 300px`, 8 px gaps, 8 px
side padding) filling the remaining height, on the page-background canvas
(spec 01's token, `#F5F5F5`). Each column is a white card with spec 01's
8 px corner and 1 px border. The outer Material card and its
header/content wrappers are removed. Under a 900 px breakpoint the grid
becomes one column with three rows: the navigator at its natural height,
the Thread card taking the rest, the Documents card a scrolling strip of
about a third of the height. Tabs remain a later refinement; stacking is
the accepted first behaviour.

> **Superseded by [spec 07](07-closer-copilot-pass.md)** — see its Notebook page frame: where the old header's controls go.

**Header.** Left: a "Back to Notebooks" icon button (arrow-left, tooltip),
the breadcrumb text "Notebooks ›" in secondary colour, then the Notebook
title as an inline-editable control — a button that looks like text;
activating it swaps to a text input prefilled with the title; Enter or
blur commits through the existing Notebooks store rename, Escape cancels.
Right: a labelled secondary "Search" button that still navigates to the
search route (accessible name "Search this Notebook", unchanged), the
primary "Add Documents" button, and — only while the Documents panel is
hidden — a secondary "Documents <count>" button that restores it
(accessible name "Show Documents").

> **Superseded by [spec 07](07-closer-copilot-pass.md)** — see its Documents pane (Add Documents moves to its top).

**Add Documents.** The existing multi-select file input moves from the
Documents section to the header, behind the "Add Documents" button, with
its `accept`, `multiple` and disabled-while-a-batch-runs behaviour and
its accessible name "Upload Documents" unchanged. Spec 03 restyles the
button; this spec only relocates the control.

> **Superseded by [spec 07](07-closer-copilot-pass.md)** — see its sidebar (the navigator moves there).

**Chat Threads navigator.** A card labelled "Chat Threads" with its own
header row (title, and a "New Chat Thread" control — defined in spec 04;
until that lands, the existing title field and "Start Chat Thread" button
move in here) and a scrolling body holding the existing Thread list. To
make this possible, the chat panel component is split into two
components with unchanged behaviour: a **Thread navigator** (the list,
and starting a Thread) and a **Thread view** (the open Thread's header,
messages, rename and composer), both reading the same chat store. The
split is a prefactor: the chat panel's tests keep passing against the two
components rendered together on the page.

**Thread card.** A region labelled "Chat" hosting the Thread view. Its
internal layout is changed only enough to pin the composer: the view
becomes a column whose message list is the scrolling part and whose
composer is the fixed last row. Its content redesign is spec 04.

**Documents panel.** A region labelled "Documents" with its own header
row (title and the hide control; spec 03 adds the count, the filter and
the rest) and a scrolling body holding the existing Document cards, the
upload batch panel and the conflict question. It is the drop target: the
existing drag-over state and hint move from the page to this card; the
accessible text "Drop files to upload them into this Notebook" stays.

**Hiding the Documents panel.** The hide control (panel-right icon,
accessible name "Hide Documents") slides the card out to the right: its
column shrinks to zero over ~200 ms while the card translates and fades.
The header's "Documents <count>" button restores it. The hidden state is
component state only, not persisted. While hidden, a drag carrying files
anywhere over the page restores the panel at `dragenter`, so the drop
target is never missing.

**Document title.** The route sets the document title to
"<Notebook title> – <product name>" while the page is open (the product
name and the title service are spec 06's).

**Removed from this page.** The "← Back to Notebooks" text link (replaced
by the header control), the "Documents" and "Chat" `h2` headings (replaced
by card headers), the "Search this Notebook" text button in the flow
(replaced by the header button), and the full-page drag outline.

## Testing Decisions

- The Notebook page spec is the seam: real page, real Documents, Notebooks
  and chat stores, stubbed API services and event stream. The chat panel
  spec keeps covering Thread and message behaviour, now against the two
  split components rendered together.
- Tests to add: the three cards are present as labelled regions; the
  header title commits a rename on Enter and discards on Escape; dropping
  files on the Documents panel triggers the same upload batch the
  page-level drop did; "Hide Documents" hides the panel body and "Show
  Documents" restores it; a `dragenter` with files while hidden restores
  it; the "Upload Documents" input in the header still starts a batch.
- Tests to update: the drag-over test now targets the Documents panel; any
  test querying the "Back to Notebooks" link by text now queries the
  button by its accessible name (same words); any test reaching the chat
  panel through its old selector reaches the two new components.
- Everything else in the existing spec (upload batch, conflicts, undo,
  cards, status events) must pass unchanged — that is the acceptance
  criterion that this slice is layout-only.

## Out of Scope

- A fourth "Notes / Pages" card (Copilot's saved outputs). Nothing in the
  domain backs it yet.
- Persisting the hidden state across reloads.
- Draggable column resizing.
- Hiding the navigator (only the Documents panel hides).
- Any change to what the navigator, the Thread view and the Documents panel
  show (specs 03, 04).

## Further Notes

- Keep the chat store and its event handling untouched; the component
  split moves templates, not logic, so spec 04 can be built in parallel
  with spec 03 once this lands.
- The prototype's measurements: header 48 px, card header rows 44 px,
  navigator 240 px (200 px under 1100 px), Documents 300 px (260 px under
  1100 px), 8 px gaps.
