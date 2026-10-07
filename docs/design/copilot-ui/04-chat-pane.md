# 04 — Chat pane

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
chips, a thread switcher in the header, and a welcoming empty state.

## Solution

Rebuild the chat panel's presentation around the conversation: a pane
header with the open Chat Thread's editable title and a Chat Threads
switcher; a scrolling message list with right-aligned user bubbles and
left-aligned assistant answers rendered as Markdown with Citation chips;
Citations grouped by Document under each answer; a pinned composer with an
icon send button, Enter to send; and an empty state with starter prompts.
The chat store, streaming logic and Citation resolution are unchanged.

## User Stories

1. As a user, I want the question box pinned at the bottom of the Chat pane with placeholder "Ask a question about this Notebook…", so that I always know where to type.
2. As a user, I want to press Enter to send and Shift+Enter for a new line, so that asking is fast.
3. As a user, I want a send icon button inside the composer that is disabled while a question is in flight or the draft is empty, so that I cannot double-send.
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
14. As a user, I want the answer being written to appear block by block in place, with a subtle "Answering…" indicator, so that streaming is visible without flicker (existing rule).
15. As a user, I want the message list to auto-scroll to the newest message when I am at the bottom, and not to yank me if I scrolled up, so that reading older messages is not interrupted.
16. As a user, I want the open Chat Thread's title in the pane header, editable by clicking it, so that renaming needs no form.
17. As a user, I want a Chat Threads switcher in the header (a menu listing every Thread with its author and start date, the open one checked), so that the list does not occupy the pane.
18. As a user, I want a "New Chat Thread" button that creates a Thread titled "New Chat Thread" and opens it immediately, so that starting a Thread is one click.
19. As a user, I want a Thread's title to be editable right after creation, so that "New Chat Thread" is a placeholder, not a commitment.
20. As a user opening a Notebook with no Chat Thread, I want the chat pane to show an empty state with a sparkle, the sentence "Ask anything about the Documents in this Notebook" and three starter prompts, so that the first question is one click.
21. As a user, I want clicking a starter prompt to create a Chat Thread (if none is open) and send that prompt, so that the empty state is actionable.
22. As a user opening a Notebook that has Chat Threads, I want the most recently started one opened by default, so that I land in context.
23. As a user, I want errors (503 when the LLM is unavailable, etc.) shown as an inline error row above the composer with a Dismiss control, so that they are visible and dismissible.
24. As a keyboard user, I want the Thread switcher, chips and composer fully operable, so that nothing depends on hover.

## Implementation Decisions

**Pane header.** Left: the open Thread's title as an inline-editable
control (same pattern as the Notebook title in spec 02; Enter commits via
the existing rename, Escape cancels; accessible name "Rename Chat Thread").
Right: "Chat Threads" menu button (chevron) listing Threads — title, author
e-mail, start date — with the active one marked; and a "New Chat Thread"
icon button. The two forms (new thread, rename) are removed.

**Default Thread.** When Threads load and none is active, the most recently
created is opened. Creating a Thread posts the fixed title "New Chat Thread"
(the create request requires a non-empty title; nothing else changes) and
makes it active.

**Message rendering.** User messages: a bubble (subtle surface, 12 px
corners, max-width ~75 %, right-aligned) with the author's initials avatar
on its right. Assistant messages: full-width, left, a 24 px gradient
sparkle avatar, the label "Assistant". The author e-mail moves to the
avatar's tooltip; the visible short name is the e-mail's local part.

**Markdown with Citations.** The answer's content is first split into
segments by the existing marker segmentation (which knows which markers
have a Citation), then each prose segment is rendered through the existing
Markdown view component, and markers are rendered as chips between
segments. Decision: markers are rendered *outside* the Markdown renderer so
the chip remains a router link with the existing `aria-label`
"Source <n>" — a marker never passes through the Markdown parser, which
also rules out `[n]` being read as a reference link. Streaming blocks use
the same rendering per block.

**Citation chips.** 18 px rounded chips, accent tint background, accent
text, the marker number; `title` keeps "<filename> (v<n>)".

**Citation groups.** Under an answer, one row per distinct Document Version
cited: a document icon, filename, "v<n>", then the marker numbers as chips
in ascending order, each still a link to its own Chunk. `data-testid`
"chat-citation" moves to the per-marker chip so counts in existing tests
stay meaningful.

**Composer.** A bordered box (strong border, 8 px corners, white) holding
an auto-growing textarea (accessible name "Ask a question", unchanged) and
an icon send button (accessible name "Send"). Enter sends; Shift+Enter
inserts a newline. The spinner shown before the first streamed chunk
becomes a small "Answering…" row above the composer.

**Empty state.** Shown when there is no active Thread or the active Thread
has no messages and nothing is streaming: sparkle, sentence, and three
static starter prompts — "Summarize the Documents in this Notebook",
"What are the key points across these Documents?", "What questions do
these Documents answer?". Static strings, no API call. Activating one
sends it (creating a Thread first if needed).

**Scrolling.** The message list is the pane's scrolling region. On new
message or streamed block it scrolls to the bottom only if the user was
within 48 px of the bottom.

## Testing Decisions

- Seam: the chat panel spec (real panel + chat store, stubbed API service
  and event stream) — it already covers Threads, messages, streaming blocks
  and Citation links; those tests are kept.
- Tests to update: starting a Thread goes through the "New Chat Thread"
  button (no title field); renaming goes through the editable title; the
  Citation count per message is still four `chat-citation` elements for the
  example answer, now inside one group row.
- New tests: the most recent Thread opens by default; Enter sends and
  Shift+Enter does not; the send button is disabled on an empty draft and
  while sending; Markdown in an answer renders (e.g. a heading element
  appears) while a marker still renders as a link with "Source n";
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

## Further Notes

- The Markdown view component already exists for Document content and
  supports a highlight range; the chat reuse must not depend on that range.
- The gradient sparkle is the one place the Copilot gradient appears
  (spec 01).
