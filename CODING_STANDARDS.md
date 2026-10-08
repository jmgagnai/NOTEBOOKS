# Coding standards

Read during review, not implementation. Everything mechanical — formatting,
types, migration numbering, the OpenAPI contract against the glossary — is
enforced by `pnpm run check`, the pre-commit hook and CI, and is not repeated
here. What follows are the judgement calls no check can make; a reviewer
applies every one of them to the diff.

## Vocabulary in user-facing text

`GLOSSARY.md` is enforced by `pnpm run check` on the OpenAPI contract and on
UI copy (template text and labels). Error messages, log lines, test names and
comments are held to the same glossary by review: a Document, a Document
Version, a Notebook, a Chat Thread, a Citation — and none of the words under
each term's `_Avoid_`. "File" is the raw upload and nothing else.

## Constants mirrored across the two apps

There is no shared package between `apps/backend` and `apps/frontend`. When
the frontend needs a backend fact (an accepted-extension list, a size limit,
the text of a refusal), it carries its own copy as a plain constant next to a
comment naming the backend file that is the source of truth, and the copy
has no logic of its own. A mirrored value that drifts is a review finding; a
third copy anywhere is one too.

## Test helpers in a seam-3 spec

A page's spec (`*.spec.ts` rendering the real page and store) keeps one set
of helpers at module scope, beside its existing stubs. A `describe` block
adds a helper only when no other block could use it. Tickets built in
parallel may each copy helpers to keep their merges clean; the merge that
brings them together hoists the copies before the branch is reviewed.

A page whose spec has grown past one area splits by area into sibling files
(`notebook-detail-page.upload.spec.ts`, `chat-panel.composer.spec.ts`), and
its shared helpers move to one `<page>.spec-helpers.ts` beside them. A new
ticket's tests go in the area file they belong to, so parallel tickets stop
appending to the same file. Setup that runs per test is exported as a
function each area file calls from its own `beforeEach`, never registered by
importing the helpers.

## Comments carry the why

A comment explains why the code is the way it is — the trade-off, the ticket
(`NBK-n`) that asked for it, the failure it prevents — and leaves what the
code does to the code. A comment that restates the next line is removed;
rationale that lives only in a commit message is moved into one.
