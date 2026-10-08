# Reading a Document is its own route, and a Version is addressed by id

Three decisions about shape, all of them places where the implementation
departs from NBK-1's wording on purpose.

## 1. The generated-content panel is a route, not a third panel

NBK-1 describes the frontend as:

> Notebook detail page composed of a sources panel (Document list/cards), a
> chat panel (Chat Thread list + active thread view), and a generated-content
> panel (Executive Summary / full content / summaries view) — mirroring the
> NotebookLM-style reference.

Two of those three are panels on `/notebooks/:notebookId`. The third is a
route of its own, `/notebooks/:notebookId/documents/:documentId`.

**Decision: leave it as a route.** The spec's wording is the thing that is
wrong here, not the code, for four reasons that all come from the same place —
the size of what that panel holds:

- **It holds up to 200+ pages.** The same document is both the content of this
  view and the reason NBK-1 keeps saying "even when that content runs past 200
  pages". A third of a Notebook page is the worst possible viewport for it, and
  "standard Material responsive layout only" (also NBK-1) means that third
  becomes a *stacked block* below two other panels on any narrow screen. A
  full-width route is the readable shape, and readability is the explicit
  acceptance criterion: "rendered with its original structure (headings,
  tables, etc.), so long or complex documents stay readable rather than
  appearing as a wall of text".
- **A Citation has to be a link.** GLOSSARY.md requires that following a
  Citation "opens that exact Version at that location". A Citation carries a
  Document, a Version and a character range, and it is delivered inside a chat
  answer that people copy, bookmark and paste to each other. A URL
  (`?version=&chunk=&from=&to=`) addresses that; a panel's internal state does
  not. Making the third panel the Citation target would mean either
  reinventing addressability inside the Notebook route or giving up the
  shareable link — and NBK-12's whole value is that an old answer stays
  checkable by someone else.
- **Lazy loading is the design, not an optimisation.** The Executive Summary
  comes first and the Converted Markdown is fetched only on an explicit expand
  (GLOSSARY.md: "shown first when a user opens a document, before they choose
  to view the full converted content"). A panel that is always on screen has to
  decide what to show when no Document is selected, and the honest answer is
  "nothing" — which is a third of the page spent on an empty state.
- **The panels' real purpose is already met.** What the three-panel shape buys
  is that sources and chat are visible together, so a user can see what they
  are asking against while they ask. That holds: the sources panel and the
  chat panel share one page. The generated-content view is where a user goes
  to *read*, which is a different activity from asking, and interleaving them
  is not something the spec asks for anywhere in its user stories.

Restructuring to a literal three-panel layout would be a real UI change — new
layout, a selection model, an empty state, a responsive strategy for three
columns, and the loss of the Citation deep link — to satisfy a sentence that
describes a reference product's screenshot rather than a behaviour any
acceptance criterion names. Not worth it.

## 2. A Document Version is addressed by its id, not its ordinal

NBK-1's resource sketch says `documents/{id}/versions/{n}`, which reads as the
ordinal `version_number`. The routes use the Version's UUID:
`/notebooks/{notebookId}/documents/{documentId}/versions/{versionId}` and the
`/content` and `/download` routes under it.

**Decision: keep the id.** The UUID is what a Citation actually pins
(`citations.document_version_id`, migration 0010), and the pin is the point:
"the Version id is read off the link rather than resolved here precisely so a
newer upload cannot move it". Addressing by ordinal would mean every Citation
link resolving `(document, n)` → Version on arrival, which is one more
lookup standing between a stored pin and the row it names — the exact seam
where a version-pinning bug hides. Both identifiers are immutable, so this
buys nothing but a prettier URL, and it would cost a change to three routes,
the generated client, the Citation link builder and their tests.

Nothing is lost for a human reading a URL either: the Version's ordinal is in
every payload that names it (`versionNumber`), and the page shows it.

## 3. There is no list-versions endpoint

There is deliberately no `GET .../documents/{documentId}/versions`.

**Decision: don't add one now.** No user story asks to browse a Document's
history. The two things the stories *do* ask for are covered:

- "see which version of a Document is current" — the Document list and detail
  carry `latestVersion`.
- "older Document versions [remain] accessible, so that I can check what a
  source said at the time an old chat answer cited it" — a Citation is the
  route to an old Version, and the Version-scoped read now returns that
  Version's own artifacts plus `isLatestVersion` / `latestVersionNumber`, so a
  reader lands on v1 knowing it is v1 of 3.

A list endpoint is a new product surface (version history UI, what to show per
entry, whether to offer restore) with no story behind it. Adding it because
the resource tree looks incomplete is how speculative endpoints get built.

## Amendment (2026-10-08): reading and asking now share the Document page

§1 argued that reading is "a different activity from asking" and that
interleaving them was asked for nowhere. The Copilot Notebooks page view —
the reference for the Document page redesign that follows spec 07 — does ask
for it: the Document is read with a Chat Thread beside it.

**Decision: the Document page gains a chat pane, and stays a route.** The
reasons §1 actually rested on are untouched by this: the URL a Citation
links to (`/notebooks/:notebookId/documents/:documentId?version=…`), the width a
200+ page Document needs (it keeps the larger share of the page), and fetching
the Converted Markdown only on request. What changes is the last bullet only —
the page is no longer reading *instead of* asking. Turning the Document into a
panel of the Notebook page (the literal three-panel reading of NBK-1) is still
rejected, for the Citation-link reason above.

## Amendment (2026-10-09): the chat pane is withdrawn

The 2026-10-08 amendment is superseded. Used for real, a Chat Thread beside
the Document read as confusing: two texts competing on one page, one of them
not the Document. **Decision: the Document page is for reading only again.**
§1 holds as first written. A Citation still opens the Document at its Chunk,
and the page's back arrow returns to where the reader came from (the Search
page, or the Notebook page with the same Chat Thread still open), so asking
is one step away rather than on the same page.
