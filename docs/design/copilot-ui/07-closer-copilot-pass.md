# 07 — Closer Copilot pass: sidebar, Notebook landing, flat panes

Jira: NBK-77.

## Problem Statement

After specs 01–06 the app speaks Fluent 2, but it still does not *look* like
Microsoft Copilot Notebooks at a glance. It has a top title bar where Copilot
has a full-height left sidebar; it shows Notebooks as a grid of cards where
Copilot shows a list of rows; it puts three bordered cards on a grey canvas
where Copilot has flat white panes split by thin lines; its question box is a
squared box where Copilot's is a rounded pill; and an empty Chat Thread shows
a mascot, a heading and three suggested questions that the user does not want.
Someone who knows Copilot Notebooks still does not recognise the app.

The change is cosmetic. Every feature keeps working as it does today, with two
deliberate, small exceptions listed under Solution.

## Solution

Rework the frame and the two main pages to match Copilot's layout, while
keeping the Fluent re-theme of Angular Material (ADR-0008), the project's
vocabulary (`GLOSSARY.md`), the Copycat brand, and every API call as they are:

- **A left sidebar replaces the top title bar** on every signed-in page: the
  Copycat brand, a "Notebooks" item, a "Search" item while inside a Notebook,
  the open Notebook's Chat Threads, and the user's avatar with the Sign out
  menu at the bottom. It collapses to an icon rail.
- **The Notebooks home becomes a list of rows** under a large "Notebooks" title.
- **The Notebook page becomes two flat panes**: the middle pane (the Notebook
  landing, or the open Chat Thread) and the Documents pane on the right. The
  Chat Threads list moves from its own card into the sidebar.
- **The Notebook landing** — the big Notebook title with the composer under
  it — is what the middle pane shows when no Chat Thread is open. Asking a
  question there starts a new Chat Thread.
- **The composer becomes a Copilot-style pill** with a round send button.
- **Surfaces become flat white**, separated by 1 px lines, with larger type
  on the home page, the landing and answers.

Two behaviour changes, accepted as exceptions to "cosmetic only":

1. The empty-Thread placeholder goes, including its three clickable
   suggested questions (clicking one used to ask it).
2. The composer on the Notebook landing is live: sending from it creates a
   Chat Thread titled "New Chat Thread" and asks the question in it. Today the
   composer is disabled until a Thread is open. This reuses the path the
   suggested questions use today, so no new client logic is invented.

What does **not** change: entering a Notebook still opens its most recently
created Chat Thread (NBK-43). The landing therefore shows for a Notebook with
no Chat Threads, and after the user goes back from an open Thread.

## User Stories

### Sidebar

1. As a signed-in user, I want a full-height sidebar on the left instead of a title bar across the top, so that the app reads like Copilot Notebooks.
2. As a user, I want the Copycat mark and name at the top of the sidebar, linking to the Notebooks home, so that the brand and the way home are where Copilot puts them.
3. As a user, I want a "Notebooks" item in the sidebar, so that I can return to the Notebooks list from any page in one click.
4. As a user, I want the "Notebooks" item marked as current while I am on the Notebooks home, so that I know where I am.
5. As a user inside a Notebook, I want a "Search" item in the sidebar that opens the search for that Notebook, so that search is where Copilot puts it.
6. As a user on the Notebooks home, I want no "Search" item, so that I am never offered a search with no Notebook to search in.
7. As a user inside a Notebook, I want that Notebook's Chat Threads listed in the sidebar under a "Chat Threads" header, so that I can switch Threads in one click without leaving the page.
8. As a user, I want each Chat Thread row in the sidebar to keep showing its title, who started it and when, so that shared Threads stay attributed.
9. As a user, I want the open Chat Thread's row marked as current in the sidebar, so that I can see which one I am reading.
10. As a user, I want a "New Chat Thread" control next to the "Chat Threads" header, so that starting a Thread works as it does today.
11. As a user, I want "No Chat Threads yet." in the sidebar when the Notebook has none, so that the empty list is explained.
12. _(Superseded by spec 08 for the Document page, which lists Chat Threads too.)_ As a user on the Notebooks home, the Document page or the Search page, I want the sidebar to show the Chat Threads only while I am on the Notebook page itself, so that the sidebar is not cluttered with a list I cannot use from there.
13. As a user, I want my avatar and e-mail at the bottom of the sidebar, opening a menu with "Sign out", so that signing out stays one click away.
14. As a user, I want to collapse the sidebar to a narrow icon rail and expand it again, so that the content gets the width when I need it.
15. As a user with a collapsed sidebar, I want the rail to keep the brand mark, Notebooks, Search (inside a Notebook) and my avatar as icon buttons with tooltips, so that the main destinations stay reachable.
16. As a user with a collapsed sidebar, I accept that the Chat Thread rows are hidden until I expand it, so that the rail stays narrow.
17. As a user on a window narrower than 900 px, I want the sidebar to start collapsed, so that the page keeps usable width. _(Amended by NBK-114: only until I have collapsed or expanded it myself; my choice wins.)_
18. _(Superseded by NBK-114: the sidebar keeps the state its toggle last set, across pages and reloads.)_ As a user, I accept that the sidebar's collapsed state is not remembered across reloads, the same as the Documents pane's hidden state.
19. As a keyboard and screen-reader user, I want the sidebar to be a labelled navigation landmark, and the collapse toggle to say what it does, so that I can find and operate it.
20. As a user on the sign-in or register page, I want no sidebar, since I am not signed in yet.

### Notebooks home

21. As a user, I want a large "Notebooks" page title, so that the page matches Copilot's home.
22. As a user, I want my Notebooks as full-width rows with dividers, each showing a folder icon, the title and "Created <date>", so that the list is scannable like Copilot's.
23. As a user, I want to open a Notebook by clicking anywhere on its row, so that the target is generous.
24. As a user, I want each row's "⋯" menu (rename, delete) to show on hover and on keyboard focus, so that the list is calm but the actions are still there.
25. As a user, I want renaming a Notebook from its row and deleting it with Undo to keep working as they do today.
26. As a user, I want the "Create Notebook" button at the top right as a secondary button with a "+", so that it looks like Copilot's "New notebook" while keeping the app's wording.
27. As a user, I want the home's empty, loading and error states to keep working as they do today, restyled to the new look.

### Notebook page — frame

28. As a user, I want the Notebook page to be two panes — the middle pane and the Documents pane — on a flat white surface split by a thin line, so that it looks like Copilot.
29. As a user, I want the Notebook page's old header row (back arrow, "Notebooks ›", title, Search, Add Documents) gone, with each of its controls moved somewhere listed in these stories, so that there is no second bar under the sidebar.
30. As a user, I want the browser tab to keep showing the Notebook title, so that several open Notebooks are distinguishable.

### Notebook landing

31. As a user in a Notebook with no Chat Threads, I want the middle pane to show the Notebook landing: a folder icon and the Notebook title in large type, with the composer under it, so that I can start asking straight away.
32. As a user on the landing, I want to rename the Notebook by clicking its big title, so that renaming works as it does today with the header gone.
33. As a user on the landing, I want to type a question and send it, which starts a new Chat Thread and asks it, so that I do not have to create a Thread first.
34. As a user who just asked from the landing, I want the new Thread to open with my question and the answer arriving, and to appear in the sidebar, so that what happened is obvious.
35. As a user, I want sending from the landing to be disabled while a Thread is being created or a question is being sent, so that I cannot start two Threads by double-clicking.
36. As a user, I want the landing to show nothing else (no mascot, no suggested questions, no Thread list), so that it is as clean as Copilot's.

### Open Chat Thread

37. As a user with a Chat Thread open, I want a back arrow at the top left of the middle pane that returns to the Notebook landing, so that I can start a fresh question the Copilot way.
38. As a user going back to the landing, I want no Thread marked as current in the sidebar, and the Thread itself kept intact, so that going back only closes it.
39. As a user, I want the open Thread's title next to the back arrow, renameable by clicking as today, with "Started by" still shown, so that nothing about Thread titles is lost.
40. As a user, I want my questions in a grey bubble on the right and answers as plain text on white, about 16 px with generous line spacing, so that answers read like Copilot's.
41. As a user, I want messages centred in a column at most about 760 px wide, so that long answers are comfortable to read on a wide screen.
42. As a user, I want Citation chips, Citation groups, Markdown rendering, the "Sending…" state and the answering state to keep working as they do today, restyled only.
43. As a user with an open Thread that has no messages yet, I want an empty message area above the composer, with no placeholder, so that the crossed-out placeholder is gone everywhere.
44. As a user, I want a small grey "AI-generated content may be incorrect" line under the composer in an open Thread, as Copilot has.

### Composer

45. As a user, I want the composer to be a rounded pill with the placeholder "Ask a question about this Notebook…" and a round blue send button with an up arrow, so that it looks like Copilot's.
46. As a user, I want no "+" and no microphone in the composer, so that it does not offer features the app does not have.
47. As a user, I want the composer at the bottom of an open Thread and under the title on the landing, so that it sits where Copilot puts it.
48. As a user, I want the composer's error row, Enter-to-send, growing textarea and answering spinner to keep working as they do today.
49. As a user, I want the old "Open or start a Chat Thread to ask" hint gone, since the landing composer can now always ask.

### Documents pane

50. As a user, I want the Documents pane flat (no card border), separated from the middle pane by a thin line, so that it matches Copilot's Content pane.
51. As a user, I want a full-width secondary "Add Documents" button at the top of the Documents pane, so that adding Documents is where Copilot puts "Add references".
52. As a user with no Documents, I want the empty state to keep the mascot and its text, using the top "Add Documents" button instead of a second one inside it.
53. As a user, I want the pane's header (title, count, hide control), the filter, the rows, the Abstract popover, status badges, "⋯" menus, the upload batch panel, the conflict question and Undo to keep working as they do today, restyled only.
54. As a user who hid the Documents pane, I want a "Show Documents" icon button at the top right of the middle pane, with the count in its tooltip, so that I can bring the pane back.
55. As a user dragging files over the page, I want the Documents pane to light up as the drop target, and to come back if I had hidden it, as today.

### Other pages and cross-cutting

56. _(Superseded by spec 08 for the Document page.)_ As a user on the Document page or the Search page, I want the sidebar and the flat look, with their own layout and back links unchanged.
57. As a user, I want every visible word to keep using the project's vocabulary — Notebook, Document, Chat Thread, Citation — rather than Copilot's "references", "sources" or "chats".
58. As a keyboard user, I want visible focus on every new control (sidebar items, collapse toggle, back arrow, Show Documents), so that the new look does not regress accessibility.

## Implementation Decisions

**No backend or API change.** Every change is confined to the Angular app.
No endpoint, field or event is added; the generated API client is not
regenerated. In particular there is no cross-Notebook Chat Thread list, which
is why the sidebar shows only the open Notebook's Chat Threads.

**Vocabulary.** Copy keeps the glossary's terms and their `_Avoid_` lists
(checked by `pnpm run check`): "Documents" / "Add Documents" (not Content,
references, sources), "Chat Threads" (not Chats, chat history), "Citations".
"Create Notebook" keeps its wording. No glossary change.

**Theme tokens (amends spec 01).** The grey workspace canvas and bordered pane
cards give way to flat white panes separated by 1 px border-colour lines. The
sidebar sits on a light grey surface (a token, reusing the subtle surface).
The type scale gains two roles used only by the home page title and the
Notebook landing title (about 40 px / 600) and the home's row titles (about
20 px / 400); answers and questions move to a 16 px reading role with a
generous line height. The Documents pane keeps the dense 14 px body.
Component styles keep using theme tokens only (the `check` gate enforces it).

**App shell → sidebar.** The shell renders, for a signed-in user, a two-column
frame: the sidebar and the routed page. No sidebar is rendered without a
session (sign-in, register). The sidebar is one new shell component with:

- a header row: the Copycat mark and name linking home (announced once, as
  today), and the collapse toggle (an icon button whose accessible name says
  "Collapse sidebar" / "Expand sidebar", with `aria-expanded`);
- navigation: "Notebooks" (current on the home) and, only when the current
  route is inside a Notebook, "Search" linking to that Notebook's search
  route. The accessible name "Search this Notebook" is kept;
- the Chat Threads section, only on the Notebook page route (not on the
  Document or Search routes): the existing Chat Threads navigator component,
  moved here unchanged in behaviour — its header, "New Chat Thread" control,
  rows with author and date, current-row marking and empty text. It is still
  labelled "Chat Threads" as a navigation landmark;
- a footer: the avatar plus e-mail, opening the existing account menu (e-mail,
  "Sign out"). The account control's accessible name is kept.

The sidebar learns the current Notebook from the router (the Notebook id route
parameter). The chat store is app-wide, so the navigator reads the same
Chat Threads state the Notebook page loads. Loading stays the Notebook page's
job; the sidebar only renders it.

**Collapse.** Expanded about 280 px, collapsed about 56 px (icon rail: brand
mark, Notebooks, Search when applicable, avatar; each an icon button with a
tooltip carrying its accessible name). The Chat Threads section is not
rendered while collapsed. Since NBK-114 only the toggle changes the state,
and the browser remembers it (`localStorage`) across pages and reloads.
With nothing remembered yet, below a 900 px viewport the sidebar starts
collapsed.

**Notebooks home (amends spec 05).** Large "Notebooks" title, "Create
Notebook" at the top right as a secondary button with the add icon, then a
list of full-width rows separated by dividers. Each row: a folder icon (a new
Fluent icon registered with the others), the title, and a secondary line
"Created <date>". The whole row opens the Notebook; the "⋯" menu (existing
rename and delete with Undo) is revealed on hover and on focus-within. The row
is a list item holding a link plus the menu button, so the menu is not nested
inside the link. "Suggested notebooks", "Jump back in", "Just you" and "last
opened" are not built: there is no data behind them.

**Notebook page frame (amends spec 02).** The page header row is removed. The
page becomes two columns, middle pane and Documents pane, filling the height
next to the sidebar, split by a 1 px line, with no outer padding or card
borders. Each pane scrolls independently, as today. The Documents pane keeps
its hide/show slide. Below 900 px, the Documents pane stacks under the middle
pane as today's strip does. The page title service keeps setting the browser
tab title.

Where the old header's controls go:

- Back to Notebooks / breadcrumb → the sidebar's "Notebooks" item.
- Notebook title and rename → the Notebook landing's big title (the existing
  editable-title control, at a new large size).
- Search → the sidebar's "Search" item.
- Add Documents (and the hidden multi-select file input named "Upload
  Documents") → the top of the Documents pane.
- "Show Documents" → an icon button at the top right of the middle pane,
  rendered only while the pane is hidden; tooltip "Show Documents (n)",
  accessible name "Show Documents".

**Middle pane: landing or Thread.** The Thread view gets two states:

- *No active Chat Thread* → the Notebook landing: folder icon + editable
  Notebook title (large), then the composer.
- *An active Chat Thread* → a top bar with a back arrow (accessible name "Back
  to Notebook", tooltip the same) and the Thread's editable title with
  "Started by", then the message list, then the composer pinned at the bottom
  with the "AI-generated content may be incorrect" caption under it.

The back arrow calls a new chat store action that closes the open Thread
(clears the active Thread and its messages, cancels nothing on the server). A
streaming answer for that Thread keeps being recorded server-side; the client
simply stops showing it, which is what switching Threads already does.

**Default Thread unchanged.** Loading a Notebook's Chat Threads still opens
the most recently created one when none is active (NBK-43). Closing a Thread
with the back arrow does not reload the Threads, so the landing stays. The
landing is therefore reached for a Notebook with no Chat Threads, or by going
back.

**Asking from the landing.** The composer is no longer closed when there is
no active Thread. Sending with no active Thread creates a Chat Thread titled
"New Chat Thread" and then asks the question in it — the exact sequence the
suggested questions run today, moved from the empty state to the composer.
Sending is disabled while a Thread is being created or a question is being
sent. The "Open or start a Chat Thread to ask" hint is removed.

**Placeholder removed.** The empty-Thread placeholder component (mascot,
"Ask anything about the Documents in this Notebook", three suggested
questions) is deleted, with its starter-question code path, wherever it is
rendered. An open Thread with no messages shows an empty message area.

**Composer.** A pill: large radius (the `--app-corner-pill` token, 28 px —
a fixed radius rather than a full one, so a multi-line draft stays a rounded
box instead of becoming a stadium), about 56 px tall when one
line, white with the strong border, focus shown by darkening the border (as
spec 01 already allows for the composer). The textarea keeps its accessible
name "Ask a question" and placeholder. The send button is round, filled with
the accent colour, with an up-arrow icon (a new Fluent icon) and keeps the
accessible name "Send". No attach and no microphone controls. The answering
progress bar, spinner and error row keep their behaviour. The keyboard /
answering hint stays, on the right of the caption row under the box, beside
the AI caveat (which shows only in an open Thread). The pill is the one
place the app uses a pill radius; spec 01's "no pills" rule otherwise stands.

On the landing while a question asked in a Thread is still being answered
(the user went back mid-answer), the box stays closed, as above, but shows
no answering progress or spinner — there is no answer on screen — and its
hint reads "You can ask again once the current answer is in".

**Messages.** Questions: subtle-surface bubble, right-aligned. Answers: plain
prose on white, no bubble, 16 px reading role. The message column is centred
with a maximum width of about 760 px. The asker and assistant avatars, author
labels, Citation chips and groups, Markdown rendering, pending and streaming
states keep their structure.

**Documents pane (amends spec 03).** No border or corner; separated from the
middle pane by the 1 px line. Top: a full-width secondary "Add Documents"
button (add icon) opening the existing picker, disabled while a batch runs.
Then the existing header row (title, count, hide control), the filter, and the
body. The empty state keeps its mascot and text but loses its own button,
since "Add Documents" sits directly above it. Rows get a little more vertical
padding; everything else is unchanged.

**Document and Search pages.** They render inside the new frame (sidebar on
the left) and pick up the flat surfaces and tokens. Their own layout, headers
and back links are unchanged.

## Testing Decisions

- **Seam: unchanged.** Each page's test renders the real page with its real
  stores, stubs the API services at their boundary and drives the UI through
  accessible names, roles and `data-testid`. No new seam, no visual-regression
  tooling; the look is checked against the Copilot screenshots in review.
- **App shell test** (prior art: the existing shell tests for the brand link,
  avatar menu and sign-out) covers the sidebar: the brand links home and is
  announced once; "Notebooks" is present and current on the home; "Search
  this Notebook" is present only inside a Notebook and links to its search
  route; the Chat Threads navigation appears on the Notebook page route only;
  the account menu at the bottom shows the e-mail and signs out; the collapse
  toggle hides the labels and the Chat Threads list and flips `aria-expanded`;
  no sidebar without a session.
- **Notebooks page test** (prior art: its existing create/rename/delete/undo
  tests) changes only its queries from cards to rows; it adds that a row opens
  its Notebook and shows "Created <date>".
- **Notebook page tests** cover: the landing (big title, rename through it)
  when the Notebook has no Chat Threads; "Add Documents" and the "Upload
  Documents" input in the Documents pane; "Show Documents" appearing in the
  middle pane only while the pane is hidden and restoring it; drag-to-restore
  unchanged. Tests that reached the old header controls change only their
  queries.
- **Chat panel tests** (they render the navigator and the Thread view
  together, which still works with the navigator in the sidebar) cover:
  sending from the landing creates one Chat Thread titled "New Chat Thread"
  and asks the question in it; send is disabled while creating; the back
  arrow returns to the landing and clears the current mark; the default
  Thread (NBK-43) still opens on load; the suggested questions are gone; the
  composer has no "+" or microphone and keeps "Ask a question" / "Send". The
  starter-prompt tests are rewritten as landing-composer tests, since the
  behaviour they asserted moves there.
- Good tests here assert behaviour visible to a user (controls, names, what
  opens, what is created), never classes, sizes or colours.

## Out of Scope

- Any backend, API, OpenAPI or generated-client change.
- A cross-Notebook "Chats" list, a global Search, "Library", "Pinned",
  "Suggested notebooks", "Jump back in", sharing indicators, "Infographic",
  "New Page", OneNote links.
- Attaching files from the composer ("+") and voice input.
- Changing the default-Thread rule (NBK-43): entering a Notebook still opens
  its newest Chat Thread.
- Persisting the sidebar's collapsed state.
- Redesigning the Document page or the Search page beyond what the frame and
  tokens give them (a more editorial Document page is a possible follow-up).
- Dark mode, localisation.
- Glossary changes; replacing Angular Material (ADR-0008).

## Further Notes

- Reference screenshots: the five Copilot Notebooks screenshots (home, a
  Notebook landing, an open chat, a page view) shared with this spec, against
  today's app (home grid; Notebook page with the crossed-out placeholder).
- Superseded sections are marked in specs 01 (App shell), 02 (Page structure,
  Header, Add Documents, Chat Threads navigator), 04 (Composer, Empty state),
  05 (Home layout, Card) and point here.
- ADR-0008 still holds: the look is a re-theme of Angular Material. No new ADR:
  nothing here is hard to reverse.
- Suggested slicing for `/to-tickets`: (1) tokens and sidebar shell, moving the
  navigator; (2) Notebooks home rows; (3) Notebook page frame, landing, back
  arrow and asking from the landing, placeholder removal; (4) composer and
  message styling; (5) Documents pane. (2)–(5) depend on (1); (4) on (3).
