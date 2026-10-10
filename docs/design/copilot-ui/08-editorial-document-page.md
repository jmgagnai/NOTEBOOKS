# 08 — Editorial Document page, with chat beside it

Jira: NBK-84.

## Problem Statement

After spec 07 every signed-in page looks like Microsoft Copilot Notebooks
except one: the Document page. Spec 07 left it out on purpose ("a more
editorial Document page is a possible follow-up"), and it shows. It is still
an 820 px Material card: a "← Back to the Notebook" text link, the filename as
a small heading, a labelled grid of metadata (Title / Authors / Document Type
/ Language / Published On / Subject / Keywords), and a Material text button to
show the full content. Copilot's page view is an editorial reading view
instead — a very large title, a byline, generous body type and line spacing —
and it is read with a Chat Thread open beside it.

That second difference matters beyond looks. Today a user who follows a
Citation lands on the Document page and loses the Chat Thread the Citation
came from: to ask a follow-up about what they just read, they have to leave
the page. Reading and asking are on different pages.

## Solution

Redesign the Document page as an editorial reading view, and put a chat pane
beside it, matching the Copilot page view (`reference/document-page-view.png`):

- **The reading view.** The Document's extracted title in the largest
  headline type, the filename under it; a one-line byline (authors ·
  publication date · document type · Version · status) with the remaining
  metadata behind a collapsed "Details"; larger body type with roomy line
  spacing, held to a readable measure. The Executive Summary still comes
  first and the full Converted Markdown still loads only when asked for.
- **A header row** on the Document pane: a "Hide chat" / "Show chat" toggle,
  the filename, and a close ✕ that returns to the Notebook — replacing the
  text back link.
- **Chat beside the Document.** The page becomes two flat panes: the chat
  pane on the left (about a third) and the Document on the right (about two
  thirds), with the sidebar starting as the icon rail (no longer since NBK-114). The chat pane is the
  same Chat Thread view as the Notebook page: it shows the Chat Thread the
  user came from, asks against the whole Notebook, and a Citation in it to
  the Document being read scrolls the page instead of reloading it.

The page stays its own route, so every Citation link keeps working
(ADR-0007, amended). No backend or API change.

## User Stories

### Reading view

1. As a reader, I want the Document's extracted title as the page's large headline, so that the page opens like an article rather than on a filename.
2. As a reader of a Document whose title was not extracted (none stated, or not summarised yet), I want the filename as the headline instead, so that the page always has a title.
3. As a reader, I want the filename as a small line under the extracted title, so that I can still tell which file I uploaded.
4. As a reader, I want a single byline under the title — authors, publication date, document type, Version number and status — so that the key facts read like an article's byline rather than a form.
5. As a reader, I want byline parts the Document does not state left out rather than shown blank, so that the byline never reads "— · — · v1".
6. As a reader, I want language, subject and keywords behind a collapsed "Details" control, so that they stay available without crowding the top of the page.
7. As a reader of a Document with no language, subject or keywords, I want no "Details" control at all, so that I am not offered an empty section.
8. As a reader of a failed Document, I want the failure sentence (NBK-68) under the byline, as today, so that I learn what went wrong and what to do next.
9. As a reader who followed a Citation to an older Version, I want the notice naming both Version numbers under the byline, as today, so that I know I am reading the cited Version and not the latest.
10. As a reader, I want the Executive Summary first, as the opening section of the article, so that I get the gist before choosing to read further.
11. As a reader of a Document whose Executive Summary is still being generated, I want the existing pending sentence in its place, so that the gap is explained.
12. As a reader, I want a quiet "Read the full Document" control under the Executive Summary in place of the Material text button, so that expanding feels like reading on rather than operating a form.
13. As a reader, I want the full Converted Markdown fetched only when I ask for it, as today, so that a 200-page Document does not load until I want it.
14. As a reader, I want to collapse the full content again, so that I can return to the summary.
15. As a reader who followed a Citation, I want the full content opened automatically and scrolled to the cited passage, highlighted, as today, so that the Citation lands me on what it cites.
16. As a reader, I want body text a step larger than today with generous line spacing, so that long reading is comfortable.
17. As a reader on a wide screen, I want the text held to a readable width centred in the Document pane, so that lines do not run the full width of the screen.
18. As a reader, I want the Executive Summary and the full content set in the same type, so that the page reads as one article.
19. As a reader, I want headings and tables in the Converted Markdown to keep their structure in the new type scale, so that complex Documents stay readable (NBK-1).
20. As a reader opening a Document that does not exist or cannot be loaded, I want the error shown as today, so that I am not left on a blank page.

### Document pane header

21. As a reader, I want a thin header row at the top of the Document pane with the filename, so that I know which Document the pane holds even after scrolling the title away.
22. As a reader, I want a close ✕ in that header that returns me to the Notebook page, so that leaving is one click and matches Copilot.
23. As a reader, I accept that the "← Back to the Notebook" text link is gone, since ✕ does the same job.
24. As a keyboard and screen-reader user, I want ✕ labelled as going back to the Notebook, so that its purpose is announced.

### Chat beside the Document

25. As a reader, I want a chat pane beside the Document, so that I can ask about what I am reading without leaving it.
26. As a reader on a wide window, I want the chat pane on the left at about a third of the width and the Document on the right at about two thirds, split by a thin line on a flat surface, so that the page matches Copilot's page view and the Document keeps the larger share.
27. _(Superseded by NBK-114: no page changes the sidebar; only its toggle does.)_ As a reader, I want the sidebar to start as the icon rail on the Document page, so that both panes get the width; I can expand it as anywhere else.
28. _(Superseded by NBK-114, with spec 07 story 18: the sidebar's state is remembered.)_ As a reader, I accept that the rail state is not remembered across reloads (spec 07 story 18).
29. As a reader who followed a Citation from a Chat Thread, I want that Chat Thread open in the chat pane, so that I can ask a follow-up straight away.
30. As a reader who opened the Document from the Documents pane while a Chat Thread was open, I want that Chat Thread still open in the chat pane, so that the conversation I was in follows me.
31. As a reader who opens a Citation link pasted to me by a colleague, I want the Chat Thread the Citation came from open beside the Document, so that I see the question it answered.
32. As a reader opening the Document page with no Chat Thread to carry over, I want the Notebook's newest Chat Thread open, by the same rule as entering the Notebook (NBK-43).
33. As a reader whose link names a Chat Thread that no longer exists or is not in this Notebook, I want the newest Chat Thread instead, silently, so that a stale link still works; the Document and the cited passage still open.
34. As a reader in a Notebook with no Chat Threads, I want the chat pane to show just the composer at the bottom of an empty pane — no folder icon or Notebook title — so that the pane does not compete with the Document's own title.
35. As a reader, I want sending from that empty chat pane to create a Chat Thread and ask the question in it, exactly as asking from the Notebook landing does (NBK-81).
36. As a reader, I want questions asked in the chat pane to be answered from the whole Notebook, the same as on the Notebook page, so that the pane behaves the same wherever I meet it.
37. As a reader, I accept that the composer carries no chip naming the Document, since a question is not limited to it.
38. As a reader of a Document that is still converting or has failed, I want the chat pane to work all the same, answering from the Notebook's ready Documents.
39. As a reader, I want the ← in the chat pane to close the Chat Thread and leave the empty composer, without leaving the Document page, so that ← and ✕ each do one thing.
40. As a reader, I want a Citation in the chat pane that points at the Version I am reading to open the full content in place, scrolled to the passage and highlighted, without reloading the page, so that checking an answer is instant.
41. As a reader, I want a Citation that points at another Document, or another Version of this one, to change only the Document pane, with the chat pane and its Chat Thread untouched, so that I can follow several Citations from one answer.
42. As a reader following Citations inside the page, I want each one to update the URL, so that the browser's back button and a copied link take me to the Document and passage I was looking at.
43. As a reader, I want a "Hide chat" toggle in the Document pane's header that gives the Document the full width, and "Show chat" to bring the pane back, so that I can read without distraction.
44. As a reader, I accept that whether the chat pane is hidden is not remembered across reloads, the same as the Documents pane.
45. As a keyboard and screen-reader user, I want the toggle to be an icon button whose label and tooltip say "Hide chat" or "Show chat", and the chat pane to be a labelled region, so that I can find and operate both.
46. As a reader on a window narrower than 900 px, I want the Document at full width and the chat pane hidden at first, reachable with "Show chat", so that a narrow screen is used for reading first.
47. As a reader who closes the Document with ✕, I want the Notebook page to open on the same Chat Thread that was in the chat pane, so that the conversation carries both ways.

### Sidebar

48. As a reader on the Document page, I want the open Notebook's Chat Threads listed in the expanded sidebar, as on the Notebook page, so that I can switch the Chat Thread in the chat pane (amends spec 07 story 12).
49. As a reader, I want clicking a Chat Thread in the sidebar on the Document page to open it in the chat pane without leaving the Document, so that switching conversations does not lose my place.
50. As a reader, I want "New Chat Thread" in the sidebar on the Document page to start a Chat Thread in the chat pane, without leaving the Document.
51. As a reader with the rail collapsed, I accept that the Chat Thread rows are hidden until I expand it (spec 07 story 16).

### Cross-cutting

52. As a user, I want every visible word to keep the project's vocabulary — Document, Version, Chat Thread, Citation, Executive Summary — so that the redesign does not bring in Copilot's "references", "sources" or "pages".
53. As a keyboard user, I want visible focus on every new control (✕, the chat toggle, "Details", "Read the full Document"), so that the new look does not regress accessibility.

## Implementation Decisions

**No backend or API change.** Every change is confined to the Angular app.
The extracted title, the metadata, the Executive Summary, the Converted
Markdown, the pinned Version and the Citation's character range are all in
today's payloads; the generated client is not regenerated. The one URL
change — a Citation link carrying the Chat Thread it came from — is a query
parameter on a frontend route, not an API change.

**The route stays.** The page remains
`/notebooks/:notebookId/documents/:documentId`, with the existing
`version`, `chunk`, `from` and `to` query parameters. ADR-0007 was amended
for this spec: reading and asking now share the page, and the reasons the
route rested on — the Citation link, the width a long Document needs,
on-request content — still hold. Opening the Document as a panel of the
Notebook page remains rejected.

**Title and byline.** The headline is `metadata.title` when it is a
non-empty string, otherwise the filename. The filename line under the title
is shown only when the headline is the extracted title (never the filename
twice). The byline joins, in order and skipping anything absent: authors
(comma-joined), the publication date as stated, the document type, "v" plus
the Version number of the Version shown, and the existing status badge.
"Details" is a disclosure listing language, subject and keywords with the
same empty-value filtering the metadata grid applies today; the grid itself
goes.

**Reading flow unchanged.** The Executive Summary section, the
"Show / Hide full content" toggle (relabelled "Read the full Document" /
"Hide the full Document" and restyled as a quiet text control), the lazy
content fetch, and the Citation highlight and scroll all keep their current
behaviour and data flow.

**Type scale through tokens.** The title uses the largest headline token of
the theme (ADR-0008), the body a step above today's body token. Line height
(about 1.75) and measure (about 72 characters) have no Material token;
they are page-level CSS custom properties defined once on the page, with a
comment saying why they are not theme tokens, so the theme-token check still
passes. The Markdown view renders the summary and the full content in that
scale.

_Amended by NBK-85:_ the title takes the app's `page-title` role (40/52, the
largest headline in the app, already used by the other pages' titles) and the
body a new `document` app role (17/30, so a line height of about 1.76),
defined with the other app roles in the theme and documented in
`docs/frontend-theme.md` — one source for the reading type rather than a
page-local copy. Only the measure stays a page-level property. A Markdown
heading never renders below the text around it.

**Two panes.** On wide windows the page is a two-column flat layout — chat
pane, thin divider, Document pane — at roughly one third / two thirds, in the
same flat style as the Notebook page (spec 07). The Document pane scrolls on
its own; the chat pane keeps its own scrolling and its composer pinned at the
bottom, as on the Notebook page. Below 900 px the chat pane starts hidden and
the Document takes the full width; "Show chat" brings the pane back over the
same split.

**The chat pane is the existing Thread view.** The page mounts the same
Chat Thread view component as the Notebook page, bound to the page's
Notebook, and relies on the root-provided Chat store, which already holds
the open Chat Thread across routes. The page loads the Notebook's Chat
Threads (as the Notebook page does) so the sidebar navigator and the default
rule have them. The Thread view gains one input — a compact mode — that the
Document page sets and the Notebook page does not:

- the empty state renders the composer alone, without the Notebook landing's
  folder icon and title (asking from it still creates a Chat Thread through
  the same store method);
- nothing else differs: the ← closes the Thread through the same store
  action as on the Notebook page, which in compact mode leaves the empty
  composer.

_Amended by NBK-86:_ the Chat store did not in fact hold the open Chat
Thread across routes: the Notebook page reset it on the way out, and the
router destroys a page before creating the next. Both pages now hand the
Thread over when the navigation stays inside the Notebook (any route under
`/notebooks/:notebookId`, Search included) and reset it otherwise, so
entering a Notebook from elsewhere still opens its newest Chat Thread
(NBK-43). A visible consequence beyond this page: going from the Notebook
page to Search and back keeps the open Thread too. The Thread view's
"compact" mode names its ← "Close Chat Thread", since there is no landing
to go back to.

**Which Chat Thread opens.** In order: the Chat Thread already open in the
store for this Notebook; else the one named by the `thread` query parameter
if it is in this Notebook's Chat Threads; else the newest (NBK-43); else none
(the empty composer). An unknown `thread` value is ignored silently.

**Citation links carry the Chat Thread.** The shared Citation link builder
adds `thread=<chatThreadId>` to the query parameters, alongside `version`,
`chunk`, `from` and `to`. Citations rendered anywhere (Notebook page, Document
page) carry it.

**Citations followed inside the page.** A Citation link in the chat pane
navigates with the router as today. When the target is this Document and the
Version on screen, the page is reused by the router (same route), so the page
reacts to the new query parameters instead of reloading: it expands the full
content if it is collapsed (fetching it once) and moves the highlight and
scroll to the new range. When the target is another Document or Version, the
page loads that Document or Version into the Document pane while the chat
pane, being bound to the Notebook and the root store, keeps its Chat Thread.
Either way the URL reflects the Citation, so back and copy-link work.

**Header row.** The Document pane's header holds, left to right: the chat
toggle (icon button, "Hide chat" / "Show chat" as label and tooltip, local UI
state, not persisted), the filename (truncated with an ellipsis), and the ✕
icon button linking to the Notebook page, labelled "Back to the Notebook".
The text back link is removed.

**Sidebar.** The sidebar's condition for listing Chat Threads widens from
"on the Notebook page" to "on the Notebook page or the Document page" of the
open Notebook. The navigator already opens a Chat Thread through the store
without navigating, so clicking a row or "New Chat Thread" on the Document
page changes only the chat pane. The sidebar starts collapsed to the rail
when the Document page is entered, and still starts collapsed below 900 px
everywhere (spec 07 story 17). NBK-114 removed the collapse on entering: the
sidebar keeps the state its toggle last set.

**Spec amendments.** Spec 07 story 12 (Chat Threads in the sidebar on the
Notebook page only) and story 56 (the Document page keeps its own layout) are
superseded by this spec; both are marked there with a pointer here.

## Testing Decisions

- **Seam: unchanged.** As in spec 07, each test renders the real page with
  its real root stores, stubs only the generated API services
  (`DocumentsService`, `ChatService`) and the App Events service at their
  boundary, and drives the UI through accessible names, roles and
  `data-testid`. No new seam, no visual-regression tooling.
- **Document page test** (prior art: its existing tests for Executive Summary
  first, lazy content, the cited-Version notice, the failure sentence and the
  Citation highlight) covers:
  - the extracted title as the headline with the filename line under it, and
    the filename as the headline when the title is null;
  - the byline built from the metadata with absent parts skipped; "Details"
    listing language, subject and keywords, and absent when all three are
    empty;
  - ✕ linking to the Notebook, and no text back link;
  - the existing behaviours unchanged under their new labels ("Read the full
    Document" fetches the content once, the summary comes first, the notice
    and failure sentence still show);
  - with `ChatService` provided, the real Thread view in the page: the
    `thread` parameter opens that Chat Thread; without it the newest opens;
    an unknown `thread` falls back to the newest; a Chat Thread already open
    in the store is kept; a Notebook with no Chat Threads shows the composer
    without the landing title, and sending creates one Chat Thread and asks
    in it; ← closes the Chat Thread and the page stays;
  - "Hide chat" removes the chat region and "Show chat" restores it;
  - a Citation in the chat pane to this Document and Version expands the
    content and highlights the cited block with no new Document fetch; a
    Citation to another Document loads it while the same Chat Thread stays
    open.
- **Chat panel tests** (prior art: the Citation link assertions in the
  answer/Citation tests) add `thread` to the expected Citation link
  parameters.
- **App shell / sidebar test** (prior art: spec 07's sidebar tests) covers:
  the Chat Threads navigation present on the Document page route as well as
  the Notebook page route, and absent on the home and Search pages; clicking
  a Chat Thread there opens it without a navigation; the sidebar starts
  collapsed on the Document page.
- **Not under test:** the column proportions, the type scale and the
  narrow-window start state are layout; they are checked against the
  reference screenshot in review, as spec 07's look was.
- **Acceptance screenshots** (`docs/run-for-screenshots.md`): a ready
  Document; one reached through a Citation on a superseded Version (with its
  notice); a window narrower than 900 px — each compared against
  `reference/document-page-view.png`.
- Good tests here assert behaviour visible to a user (controls, names, what
  opens, what is fetched, which Chat Thread is open), never classes, sizes or
  colours.

## Out of Scope

- Any backend, API, OpenAPI or generated-client change.
- Questions limited to the Document being read, and a Document chip in the
  composer.
- Redesigning the Search page (a possible follow-up, like this one was).
- Copilot-only features on its page view: editing the page, sharing,
  "Creations", Infographic, inline Citation links inside the Document text.
- Persisting the chat pane's hidden state or the sidebar's rail state (the
  sidebar's is persisted since NBK-114).
- A Version history or Version picker on the page (ADR-0007 §3).
- Dark mode, localisation.
- Glossary changes; replacing Angular Material (ADR-0008).

## Further Notes

- Reference: `reference/document-page-view.png`, Copilot Notebooks' page view
  (chat left, page right, sidebar as rail). Copilot's page there is a
  generated Creation; ours is an uploaded Document whose Executive Summary is
  the generated part, which is why the analogy holds without new vocabulary.
- ADR-0007 carries an amendment dated 2026-10-08 for this spec. No new ADR.
- Suggested slicing for `/to-tickets`: (1) the editorial reading view — title
  and filename line, byline and "Details", the restyled two-step reading, the
  header with ✕ (no toggle yet), the type scale; (2) chat beside the
  Document — the two panes and rail, the chat toggle and narrow windows, the
  compact Thread view, which Chat Thread opens, `thread` on Citation links,
  in-page Citations, the sidebar's Chat Threads on this page. (2) depends on
  (1).
