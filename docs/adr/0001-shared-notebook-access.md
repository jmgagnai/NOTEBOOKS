# Shared Notebook access despite full attribution

Every authenticated user can view and edit every Notebook, Document, and Chat Thread — there is no ownership or permissions model gating access in V1, and concurrent edits to the same Notebook are not detected or prevented by the system. This is deliberate: V1 targets a small trusted team where shared visibility matters more than isolation, and retrofitting a permissions model later is expensive once data and UI assume unrestricted access. Attribution is still tracked throughout (a Chat Thread records its author, every chat message records who asked it) — only *access* is unrestricted, not *identity*.

## Amendment (2026-10-08): only its author may delete a Chat Thread

The first exception to "no ownership or permissions model gating access".
Deleting a Chat Thread is limited to the user who started it: the server
refuses anyone else with 403, and the UI offers the action to the author
only. Everything else stays open: any user still reads, renames and
continues any Chat Thread, and Notebooks and Documents are still
deletable by anyone.

Why the exception: a Chat Thread is one person's line of questioning,
shared for others to read and build on. Unlike a Document, which the team
uploads for everyone to use, it carries its author's name on every
question. Letting anyone else remove it would let one teammate erase
another's history. Read, rename and continue stay open because they add to
the Thread or tidy it, and lose nothing.

Deletion is soft and the UI offers no undo; an **Administrator** (a user
named in the backend's `ADMIN_EMAILS`, see GLOSSARY.md) can restore any
deleted Chat Thread through the API, with curl. That is the only other
access rule, and it sits outside the UI.

The rule rests on the attribution this ADR already keeps (a Chat Thread
records its author), so it needs no permissions model. It is the case
for one if more such rules arrive.
