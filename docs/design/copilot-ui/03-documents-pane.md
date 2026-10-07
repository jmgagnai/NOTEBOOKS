# 03 — Documents pane

## Problem Statement

Each Document is a tall card: filename, an uppercase status pill, a version
tag, the full Abstract, and three text buttons (Open, Download, Delete).
Four Documents already fill a screen. Uploading goes through a raw
`<input type="file">` ("Sélect. fichiers / Aucun fichier choisi") under a
"Upload Documents" label, and the search entry point is a text button in
the flow. Copilot Notebooks lists sources as one compact row each, with a
single "+ Add" button, a hover "…" menu, and progress shown inline.

## Solution

Redesign the Documents pane body as a compact list: one 40 px row per
Document with a type icon, the filename, a subtle status indicator and an
overflow menu. A single "Add Documents" button in the pane header replaces
the native file input; a quick filter box narrows the list by filename.
The Abstract moves to a tooltip-like popover on hover/focus so it is still
one gesture away without consuming the list. The upload batch panel and the
conflict question keep their behaviour but are restyled to fit the pane.

## User Stories

1. As a user, I want each Document to be one compact row, so that a Notebook with forty Documents is scannable without scrolling for minutes.
2. As a user, I want a type icon (PDF, Word, text, other) at the start of each row, so that I can tell Documents apart at a glance.
3. As a user, I want long filenames truncated with an ellipsis and the full name on hover, so that rows never wrap.
4. As a user, I want a Document still being ingested to show a thin progress indicator and its stage name (queued, converting, summarizing, indexing…) under the filename, so that I know it is not ready yet without a loud badge.
5. As a user, I want a `ready` Document to show no badge at all, so that the normal state is quiet.
6. As a user, I want a `failed` Document to show a red warning icon with the reason on hover, so that failures stand out.
7. As a user, I want the version number shown as small secondary text ("v2") only when a Document has more than one Version, so that the common case is uncluttered.
8. As a user, I want to hover or focus a row and read its Abstract in a popover, so that I can judge a Document without opening it.
9. As a user, I want a "…" menu on each row with Open, Download and Delete, so that actions do not clutter every row.
10. As a user, I want clicking the row itself (or pressing Enter on it) to open the Document, so that the most common action is the easiest.
11. As a user, I want one "Add Documents" button in the pane header that opens the system file picker (multi-select, accepted types only), so that uploading is one obvious control.
12. As a user, I want the "Add Documents" button disabled while a batch is running, so that I cannot start a second batch mid-way (existing rule).
13. As a user, I want a filter box in the pane header that narrows the list by filename as I type, so that I can find a Document among many without leaving the Notebook.
14. As a user, I want the filter to be clearly different from "Search this Notebook" (semantic search, its own page), so that I know which one finds Documents by meaning.
15. As a user, I want the upload batch progress shown as a compact panel at the top of the list, with one line per file, so that I can follow a batch of many files.
16. As a user, I want the conflict question ("Document already exists") to appear in the same compact style with "Skip" and "New Version" buttons, so that batches keep the existing behaviour.
17. As a user, I want "Retry failed", "Cancel" and "Dismiss" to remain available on the batch panel, so that steering a batch is unchanged.
18. As a user, I want the "X deleted — Undo" message as a snack bar, so that it does not push the list down.
19. As a user, I want an empty Notebook to show a friendly empty state ("No Documents yet. Add Documents to start asking questions.") with the Add button, so that the first step is obvious.
20. As a user, I want the row count ("12 Documents") in the pane header, so that I know the Notebook's size.
21. As a keyboard user, I want rows to be focusable with arrow-key navigation and the overflow menu reachable by keyboard, so that the pane is fully operable without a mouse.

## Implementation Decisions

**Row anatomy.** A list where each item is: 20 px type icon (derived from
the latest Version's MIME type, mirrored from the backend's accepted-types
list already copied into the upload rules), filename (14 px, one line,
ellipsis), optional secondary line (12 px: stage name while ingesting, or
"v2" when version > 1), trailing slot (warning icon when `failed`; "…" menu
button, visible on hover/focus and always on touch). An in-progress Document
also shows a 2 px indeterminate progress bar across the bottom of the row.

**Status mapping.** The eight statuses collapse into three visual states:
*in progress* (`queued`, `converting`, `converted`, `summarizing`,
`summarized`, `indexing`) → secondary line with the stage name + progress
bar; *ready* → nothing; *failed* → warning icon + tooltip. The stage name is
the status string in sentence case; no new copy.

**Abstract popover.** Hovering or focusing the filename opens a popover
(Material tooltip with a custom, multi-line template or a CDK overlay)
showing the Abstract, or "Abstract not generated yet." in italics. It is
not shown on touch devices; the Document page remains the full read.

**Overflow menu.** Material menu with Open (navigates to the Document
route, keeping ADR-0007), Download (existing download action), Delete.
Accessible names stay "Open <filename>", "Download <filename>",
"Delete <filename>".

**Add Documents.** A primary button with the add icon. It triggers a
visually hidden file input carrying the same `accept`, `multiple` and
disabled-while-batch behaviour; the input keeps the accessible name
"Upload Documents" so existing upload tests keep working. Drag-and-drop
is unchanged (spec 02 moved the target to the pane).

**Filter.** A search-styled input in the pane header, accessible name
"Filter Documents", filtering the store's list client-side by
case-insensitive substring of the filename. It does not call the search
endpoint. The header also keeps the semantic "Search this Notebook" icon
button defined in spec 02 (the search page is unchanged).

**Batch panel.** Same state machine and same copy; presentation becomes a
bordered panel at the top of the list body with 12 px rows, the shared
badge style for per-file statuses, and the conflict question as a
highlighted block inside it. The "Apply to all remaining conflicts"
checkbox stays.

**Empty state.** Centered illustration-free block: a Documents icon, the
sentence above, and the Add Documents button.

## Testing Decisions

- Seam: the Notebook page spec (real page + Documents store, stubbed API and
  event stream). It already covers upload batches, conflicts, undo, status
  events and card actions; those tests are kept and re-pointed at the new
  controls where the control changed (menu instead of inline buttons).
- New tests: rows show the stage name while ingesting and nothing when
  `ready`; `failed` shows the warning with the accessible reason; filter
  narrows the list and clears; the Abstract popover opens on focus with the
  Abstract text; row activation navigates to the Document route; the empty
  state shows when the store has no Documents.
- Keep existing `data-testid`/`aria-label` values for upload, batch items,
  conflict dialog and undo; the delete-undo test moves from inline text to
  the snack bar action.

## Out of Scope

- Checkboxes to select which Documents ground the chat (Copilot's
  per-source toggles) — retrieval has no per-Document scope in the API.
- Document counts or last-modified dates coming from the server.
- Sorting controls (list order stays the store's order).
- Folders / grouping.

## Further Notes

- The Abstract is still "used in document cards" per the glossary; the
  popover is that card, folded. If the popover proves awkward, the fallback
  is a two-line clamped Abstract under the filename — still one row per
  Document, just taller.
