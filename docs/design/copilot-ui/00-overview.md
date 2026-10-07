# Copilot-Notebooks-style UI — design overview

Goal: make the frontend (renamed **Copycat Notebooks**, spec 06) look and behave like Microsoft Copilot
Notebooks (Fluent 2 visual language, three-region notebook workspace,
chat-first interaction) **without touching the backend or the OpenAPI
contract**.

This folder holds one spec per vertical slice, written for the
`/to-spec` → `/to-tickets` → `/implement-spec` workflow. Each spec is
self-contained; the order below is the recommended implementation order
because later specs assume the earlier ones (the theme first, then the
workspace layout, then the panes it holds).

| # | Spec | Depends on |
|---|------|------------|
| 01 | Fluent theme and app shell | — |
| 02 | Notebook workspace layout (two panes) | 01 |
| 03 | Documents pane | 02 |
| 04 | Chat pane | 02 |
| 05 | Notebooks home and sign-in pages | 01 |
| 06 | Copycat brand: name, mascot and favicon (assets in `brand/`) | 01 (shell), 05 (sign-in page) |

## Backend / API impact: none

Every change is confined to the Angular app. Verified against the published
OpenAPI contract (`GET/POST/PATCH/DELETE` on Notebooks, Documents, Document
Versions, Chat Threads, messages, search, events):

- No new endpoint, field, query parameter or event type is needed.
- The generated API client is not regenerated.
- Two ideas from the initial proposal **were dropped** because they would
  have needed contract changes, and are listed as out of scope instead:
  - "N Documents" and "last modified" on Notebook cards — the Notebook list
    only carries `id`, `title`, `createdAt`. Cards show the creation date.
  - LLM-generated prompt suggestions in the empty chat state — the
    suggestions are static client-side strings.
- Auto-titled creation ("Untitled Notebook", "New Chat Thread") is pure
  client behaviour: both create requests already accept any non-empty title.
- Chat answers are already Markdown strings with `[n]` markers; rendering
  them as Markdown is a view concern only.

## Glossary compliance

`GLOSSARY.md` forbids several words Copilot uses. UI copy in every spec uses
the project's terms:

| Copilot Notebooks says | This app says | Why |
|---|---|---|
| Sources, "Add sources" | **Documents**, "Add Documents" | _Avoid_: source, file (except for the raw upload) |
| Chat / conversation / chat history | **Chat Thread** / **Chat Threads** | _Avoid_: conversation, session |
| References | **Citations** | _Avoid_: reference, source |
| Workspace | **Notebook** | _Avoid_: workspace, project |

"Workspace" is used in these documents only as a *layout* name (the
notebook workspace page); it never appears in user-facing copy.

## ADRs touched

- ADR-0007 (reading a Document is its own route) — respected: the Documents
  pane links to the Document page; it does not inline the Executive Summary.
- Search stays its own route (the "search is a place a user can be" note on
  the route) — the pane adds a quick filter, it does not replace the page.

## Testing seam (shared by all specs)

The existing seam: each page's spec renders the real page with its real
store and stubs HTTP at the API-service boundary, driving the UI through
accessible names (`aria-label`, roles) and `data-testid`. All specs keep
that seam and keep the existing accessible names so current specs need
updating only where behaviour intentionally changes (listed per spec).
