# 02 — Notebook workspace layout

## Problem Statement

A Notebook today is one 640 px card the user scrolls through: title, back
link, Documents heading, search link, upload control, undo line, Document
cards with full Abstracts, then — far below — "Chat", the Chat Thread list,
the rename form and the messages. Chat, which is the point of the product,
is off-screen on arrival, and the composer sits wherever the last message
ends. Copilot Notebooks shows Documents and chat side by side, full height,
with the question box pinned at the bottom.

## Solution

Turn the Notebook page into a full-height workspace with a slim header and
two resizable-looking panes: a **Documents pane** on the left (fixed width)
and a **Chat pane** filling the rest. Each pane scrolls independently; the
chat composer is pinned to the bottom of its pane. The drag-and-drop upload
target becomes the Documents pane. This spec delivers the frame and moves
the existing content into it unchanged; specs 03 and 04 then redesign the
content of each pane.

## User Stories

1. As a user opening a Notebook, I want to see its Documents and its chat at the same time, so that I can ask a question while looking at what it will be grounded in.
2. As a user, I want the page to use the full height of the window with no outer card, so that long Document lists and long Chat Threads get the room they need.
3. As a user, I want the Documents pane and the Chat pane to scroll independently, so that reading a long answer does not scroll my Documents out of view.
4. As a user, I want the question box pinned at the bottom of the Chat pane, so that I always know where to type.
5. As a user, I want a slim header showing the Notebook title with a back control to the Notebooks list, so that I know where I am and can leave in one click.
6. As a user, I want to rename the Notebook by clicking its title in the header, so that renaming does not need a separate form.
7. As a user, I want the Documents pane to be collapsible to a thin rail, so that chat can take the whole width when I am reading answers.
8. As a user dragging files over the page, I want the Documents pane (not the whole page) to light up as the drop target, so that it is obvious where the upload goes.
9. As a user on a window narrower than ~900 px, I want the panes to stack (Documents above, chat below) or switch via tabs, so that the app still works on a laptop half-screen.
10. As a user, I want the Notebook title in the browser tab, so that several open Notebooks are distinguishable.
11. As a keyboard user, I want each pane to be a labelled landmark region, so that I can jump between Documents and chat.
12. As a user, I want pane widths to be stable (no layout jump when content loads), so that the page does not flicker.

## Implementation Decisions

**Page structure.** The Notebook page becomes a column: a 44 px header, then
a CSS grid with two columns (`320px 1fr`) filling the remaining height. The
outer Material card and its header/content wrappers are removed. The grid
collapses to one column under a 900 px breakpoint, with the Documents pane
first; a later refinement may switch to tabs, but stacking is the accepted
first behaviour.

**Header.** Left: a "Back to Notebooks" icon button (arrow-left, tooltip),
then the Notebook title rendered as an inline-editable control — a button
that looks like text; activating it swaps to a text input prefilled with the
title; Enter or blur commits through the existing Notebooks store rename,
Escape cancels. Right: a "Search this Notebook" icon button that still
navigates to the search route (accessible name unchanged).

**Documents pane.** A region labelled "Documents" with its own header row
(title + actions, defined in spec 03) and a scrolling body. It is the drop
target: the existing drag-over state and hint move from the page to this
pane; the accessible text "Drop files to upload them into this Notebook"
stays. A collapse control in the pane header reduces it to a 48 px rail
showing only an expand button and a Documents icon; the collapsed state is
kept in component state only (not persisted).

**Chat pane.** A region labelled "Chat" that hosts the existing chat panel
component. The chat panel's internal layout is changed only enough to pin
its composer: the panel becomes a column whose message list is the scrolling
part and whose composer is the fixed last row. Its content redesign is
spec 04.

**Document title.** The route sets the document title to
"<Notebook title> – <product name>" while the page is open (the product name and the title service are spec 06's).

**Removed from this page.** The "← Back to Notebooks" text link (replaced by
the header control), the "Documents" and "Chat" `h2` headings (replaced by
pane headers), and the full-page drag outline.

## Testing Decisions

- The Notebook page spec is the seam: real page, real Documents and
  Notebooks stores, stubbed API services and event stream.
- Tests to add: both panes are present as labelled regions; the header
  title commits a rename on Enter and discards on Escape; dropping files on
  the Documents pane triggers the same upload batch the page-level drop
  did; the collapse control hides the pane body and the expand control
  restores it.
- Tests to update: the drag-over test now targets the Documents pane; any
  test querying the "Back to Notebooks" link by text now queries the
  button by its accessible name (same words).
- Everything else in the existing spec (upload batch, conflicts, undo,
  cards, status events) must pass unchanged — that is the acceptance
  criterion that this slice is layout-only.

## Out of Scope

- A third "Notes / Pages" pane (Copilot's saved outputs). Nothing in the
  domain backs it yet; the grid is two columns, not three with a placeholder.
- Persisting the collapsed state across reloads.
- Draggable pane resizing.
- Any change to what the Documents pane and the chat panel show (specs 03, 04).

## Further Notes

- Keep the chat panel's store and event handling untouched; this slice is
  deliberately a container change so spec 04 can be built in parallel with
  spec 03 once this lands.
