# 04 — Chat: navigator and Thread view

## Problem Statement

The chat area is a form-heavy two-column block: a "New Chat Thread title"
field with a "Start Chat Thread" button, a list of Thread cards, then the
open Thread with a "Rename Chat Thread" field and button, grey message
boxes labelled "jmgagnaire@gmail.com" / "Assistant, for
jmgagnaire@gmail.com", answers as raw pre-wrapped Markdown, `[1][10][12]`
markers, a Citation list repeating the same filename four times, and a
"Ask a question" textarea with a text "Send" button. Copilot Notebooks is a
chat surface: a pinned composer, light user bubbles on the right, plain
assistant answers on the left with rendered formatting, numbered citation
chips, the chat history as a navigator beside it, and a welcoming empty
state.

## Solution

Rebuild the chat's presentation around the conversation, across the two
components spec 02 split it into: the **Chat Threads navigator** card
(every Thread, the open one clearly marked, one "New Chat Thread" control)
and the **Thread view** card (the open Thread's editable title; a
scrolling message list with right-aligned user bubbles and left-aligned
assistant answers rendered as Markdown with Citation chips; Citations
grouped by Document under each answer; a pinned composer with an icon send
button and Enter to send; and an empty state with starter prompts). The
chat store, streaming logic and Citation resolution are unchanged. The
look and the interaction rules below were settled on the prototype branch
`prototype/notebook-workspace`.

## User Stories

1. As a user, I want the question box pinned at the bottom of the Thread card with placeholder "Ask a question about this Notebook…", so that I always know where to type.
2. As a user, I want to press Enter to send and Shift+Enter for a new line, so that asking is fast.
3. As a user, I want a send icon button inside the composer that is disabled while the draft is empty, so that I cannot send nothing.
4. As a user, I want the composer to grow with my text up to ~6 lines, so that multi-line questions stay readable.
5. As a user, I want my questions shown as light bubbles aligned to the right, so that I can skim who said what.
6. As a user, I want assistant answers shown on the left without a bubble, preceded by a small sparkle avatar, so that answers read like a page, not a chat log.
7. As a user, I want each message to show who asked it as a small avatar with initials plus a short name, so that attribution stays visible in a shared Chat Thread without the full e-mail on every line.
8. As a user, I want the full e-mail on hover of the avatar, so that attribution is still exact.
9. As a user, I want answers rendered as Markdown (headings, lists, emphasis, code), so that structured answers are readable.
10. As a user, I want the Citation markers in an answer shown as small numbered chips, so that they are visible but do not break the sentence.
11. As a user, I want clicking a chip to open the cited Document Version at the cited Chunk, so that following a Citation is unchanged.
12. As a user, I want the Citations under an answer grouped by Document ("leblanc_the_bridge…pdf v1 · 1, 8, 10, 12"), so that four Citations into one Document are one line.
13. As a user, I want the Version shown on each Citation group, so that I can see when an answer cites a superseded Version.
14. As a user, I want the answer being written to appear block by block in place, so that streaming is visible without flicker (existing rule).
15. As a user, while the backend is answering, I want the question box disabled with a visible loader in it (a thin progress bar along its top edge and a spinner where the send button was), so that I know an answer is coming and cannot send a second question meanwhile — and I want the box to take focus back when the answer lands.
15b. As a user switching to a Chat Thread, I want to land at the bottom of its messages, so that I see the latest exchange first.
15c. As a user sending a question, I want it scrolled into view at the bottom, so that I see what I asked while the answer is prepared.
15d. As a user, when an answer starts arriving, I want its first line scrolled to the top of the list and the view to stay there while the rest streams in, so that I read a long answer from its start rather than chasing its end.
15e. As a user, I want the question box to show focus without an outline around it (its border darkens instead), so that typing does not put a ring around the whole box.
16. As a user, I want the open Chat Thread's title in the Thread card's header, editable by clicking it, so that renaming needs no form.
17. As a user, I want the Chat Threads navigator to list every Thread with its author and start date and to mark the open one unmistakably (tinted fill, brand outline, bold title), so that I always know which Thread I am in.
18. As a user, I want a "New Chat Thread" control in the navigator's header that creates a Thread titled "New Chat Thread" and opens it immediately, so that starting a Thread is one click.
19. As a user, I want a Thread's title to be editable right after creation, so that "New Chat Thread" is a placeholder, not a commitment.
20. As a user opening a Notebook with no Chat Thread, I want the Thread card to show an empty state with a sparkle, the sentence "Ask anything about the Documents in this Notebook" and three starter prompts, so that the first question is one click.
21. As a user, I want clicking a starter prompt to create a Chat Thread (if none is open) and send that prompt, so that the empty state is actionable.
22. As a user opening a Notebook that has Chat Threads, I want the most recently started one opened by default, so that I land in context.
23. As a user, I want errors (503 when the LLM is unavailable, etc.) shown as an inline error row above the composer with a Dismiss control, so that they are visible and dismissible.
24. As a keyboard user, I want the navigator, chips and composer fully operable, so that nothing depends on hover.

## Implementation Decisions

**Navigator.** The Chat Threads card from spec 02. Header: title "Chat
Threads" with a history icon, and a "New Chat Thread" icon button (add
icon, tooltip). Body: one row per Thread — title (14 px), then author
e-mail and short start date (12 px, secondary) — regular weight. The open
Thread's row: tinted fill (`#D6E8F9`), a 3 px brand bar on its left, a
solid 2 px brand outline drawn inside the row, title in bold and the dark
brand colour. Rows keep the accessible name "Open <title>". Below 900 px
the navigator keeps its list layout at natural height (spec 02).

**Thread view header.** The open Thread's title as an inline-editable
control (same pattern as the Notebook title in spec 02; Enter commits via
the existing rename, Escape cancels; accessible name "Rename Chat
Thread"), with "Started by <e-mail>" under it in secondary text. No
switcher menu: the navigator is the switcher. The two forms (new thread,
rename) are removed.

**Default Thread.** When Threads load and none is active, the most recently
created is opened. Creating a Thread posts the fixed title "New Chat Thread"
(the create request requires a non-empty title; nothing else changes) and
makes it active.

**Message rendering.** User messages: a bubble (subtle surface, 12 px
corners, max-width ~75 %, right-aligned) with the author's initials avatar
on its right. Assistant messages: full-width, left, a 24 px gradient
sparkle avatar, the label "Assistant". The author e-mail moves to the
avatar's tooltip; the visible short name is the e-mail's local part.

**Markdown with Citations.** Answers are rendered through the existing
Markdown view component (GitHub-flavoured, tables included). Before
parsing, every source marker that has a Citation is replaced in the source
text by a link to that Citation's route (Document, pinned Version, Chunk
and character range as query parameters, the same link the Citation list
uses); markers with no Citation stay plain text. The links therefore
survive inside headings, list items and table cells — the prototype
showed answers whose markers sit in table cells, which the earlier plan
(markers rendered outside the renderer, between prose segments) would have
split apart. Angular's sanitizer keeps `href`, `class` and `title` but
drops ARIA attributes, so the accessible name "Source <n>" is applied to
the rendered links after render, and clicks on in-app links inside the
rendered HTML are routed through the router rather than reloading the
page. Streaming blocks use the same rendering per block.

**Loading the renderer.** The Markdown library is deliberately kept out of
the initial bundle (the Document route lazy-loads it, and the initial
bundle already exceeds its warning budget). The Thread view wraps the
Markdown rendering in a deferred block that loads on idle; until it
loads, an answer shows as plain wrapped text with its markers as links.
The chunk is shared with the Document route.

**Citation chips.** 18 px rounded chips, accent tint background, accent
text, the marker number; `title` keeps "<filename> (v<n>)".

**Citation groups.** Under an answer, one row per distinct Document Version
cited: a document icon, filename, "v<n>", then the marker numbers as chips
in ascending order, each still a link to its own Chunk. `data-testid`
"chat-citation" moves to the per-marker chip so counts in existing tests
stay meaningful.

**Composer.** A bordered box (strong border, 8 px corners, white) holding
an auto-growing textarea (accessible name "Ask a question", unchanged), a
one-line hint ("Enter to send · Shift+Enter for a new line") and an icon
send button (accessible name "Send"). Enter sends; Shift+Enter inserts a
newline. The box draws no focus ring (spec 01's one exception); while the
textarea has focus the border darkens from `#D1D1D1` to `#8A8A8A`.

**Answering state.** From the send until the answer's recorded message
arrives (or the ask fails): the textarea is disabled, a 2 px indeterminate
progress bar runs along the box's top edge, a spinner replaces the send
button (`role="status"`, accessible name "Answering"), and the hint reads
"Answering… the box reopens when the answer is in". When the state ends,
the textarea is re-enabled and takes focus. A failed ask keeps the draft
(existing rule) so re-sending is the retry.

**Scrolling.** The message list is the Thread card's scrolling region.
Three rules: opening or switching to a Thread scrolls to the bottom once
its messages are loaded; sending a question scrolls that question into
view at the bottom; when the first streamed block of an answer arrives,
the answer's first line is scrolled to the top of the list and later
blocks do not move the view, nor does the recorded message replacing the
preview. There is no "follow the bottom while streaming" behaviour.

**Empty state.** Shown when there is no active Thread or the active Thread
has no messages and nothing is streaming: sparkle, sentence, and three
static starter prompts — "Summarize the Documents in this Notebook",
"What are the key points across these Documents?", "What questions do
these Documents answer?". Static strings, no API call. Activating one
sends it (creating a Thread first if needed).


## Testing Decisions

- Seam: the chat panel spec (the navigator and the Thread view rendered
  together with the real chat store, stubbed API service and event stream)
  — it already covers Threads, messages, streaming blocks and Citation
  links; those tests are kept.
- Tests to update: starting a Thread goes through the "New Chat Thread"
  button (no title field); renaming goes through the editable title; the
  Citation count per message is still four `chat-citation` elements for the
  example answer, now inside one group row.
- New tests: the most recent Thread opens by default; Enter sends and
  Shift+Enter does not; the send button is disabled on an empty draft;
  while an ask is in flight the textarea is disabled, the "Answering"
  status is present and the draft survives a failure; after the answer
  lands the textarea is enabled and focused; Markdown in an answer renders
  (e.g. a heading element and a table appear) while a marker inside a
  table cell still renders as a link with "Source n"; the open Thread's
  navigator row carries the selected state; switching Thread scrolls the
  list to its end and the first streamed block scrolls the answer to the
  top (assert via the scroll calls on the list element);
  Citations into one Document are grouped on one row with the Version;
  the empty state's starter prompt creates a Thread and sends the prompt;
  the error row is dismissible.
- The author attribution test (`chat-message-author`) now asserts the
  short name and the tooltip carrying the full e-mail.

## Out of Scope

- Saving an answer as a note / "Pages" (no backing in the domain).
- Editing or deleting messages, deleting Chat Threads (no endpoints).
- LLM-generated starter prompts.
- Markdown in *user* messages (shown as plain text, as today).
- Typing indicators beyond the existing block-by-block stream.
- Following the bottom of a streaming answer (the view stays at its start).

## Further Notes

- The Markdown view component already exists for Document content and
  supports a highlight range; the chat reuse must not depend on that range.
- Markdown in answers was verified on the prototype branch against real
  answers (a chronological table with markers in its cells); its
  `proto-message-list` is the reference for the pre-parse marker swap and
  the router click handling.
- The gradient sparkle is the one place the Copilot gradient appears
  (spec 01).
