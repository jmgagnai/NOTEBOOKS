---
name: implement-spec
description: "Implement the result of /to-spec and /to-tickets in code."
disable-model-invocation: true
---

You have been provided a spec. This spec should have tickets associated with it, describing how to implement the spec.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

The goal is the entire spec implemented on a single **integration branch**, with every ticket resolved the way the issue tracker closes work.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec, tickets, research notes, and previous commits. Don't duplicate information already available via pointers.

**Implementer subagents** should be run in the background where possible for maximum concurrency.

## Steps

1. Read the spec and tickets to understand the task graph.

2. (optional) Use an **exploration subagent** to conduct any exploration required by the tickets - relevant codebase files or external documentation. Ensure the exploration subagent can save files - it should save its markdown notes in the **notes directory** (see Reference), accessible by all future subagents. This lets **implementer subagents** focus on implementation rather than exploration.

3. Create the integration branch. If the issue tracker closes work through PRs, or the user asks for one, open a draft PR after the first merge in step 5 (a branch with no commits ahead of main can't open one), marked as closing the spec and tickets.

4. Use **implementer subagents** to implement each ticket, each in its own worktree on its own branch, provisioned as in Reference. Each implementer subagent:
   - confirms its worktree is based on the integration branch before starting, and resets onto it if not;
   - calls the Skill tool with `tdd` to build the ticket, running the test files it touches while it works and the full suite once at the end (parallel full suites overload the machine — see `docs/environment-gotchas.md`);
   - merges the integration branch tip into its own branch before reporting done

5. Once an **implementer subagent** completes, merge its work to the integration branch with a **merger subagent**. Push the integration branch only after a green run of the suites the merge touched; a red run on a busy machine is re-run alone first.

6. If this changes the **frontier** of available tickets, kick off more **implementer subagents** to work on the new tickets. This allows for maximum concurrency.

7. Once all tickets are complete, call the Skill tool with `code-review` on the integration branch. Fix all issues raised by the code review in a single **implementer subagent**.

8. If a draft PR exists, mark it ready for review. Otherwise, resolve each ticket the way the issue tracker closes work, and report the integration branch.

9. Clean up all **implementer subagent** worktrees.

## Reference

### Worktrees

Provision each ticket's worktree by hand: the Agent tool's `isolation: "worktree"` branches from the default branch, never from the integration branch.

```bash
git worktree add .claude/worktrees/<ticket> -b ticket/<ticket-slug> <integration-branch>
(cd .claude/worktrees/<ticket> && pnpm install --offline --frozen-lockfile)
```

A fresh worktree has no `node_modules`, and its tests fail until the install runs (about 10 s from the pnpm store). Provision the next wave while the current one runs, then `git -C <worktree> reset --hard <integration-branch>` just before launching its implementer, so it starts from the latest tip. Removing a worktree with `node_modules` takes minutes: run cleanup in the background, removing only worktrees whose branch is merged and whose status is clean.

### Notes directory

Keep shared notes in `$CLAUDE_JOB_DIR/tmp/notes` (outside the repo, readable by every subagent), and point every subagent prompt at it rather than restating its content:

- **`IMPLEMENTER-BRIEF.md`**: the integration branch, how to confirm and reset the worktree, which commands test what, the commit trailer, and the hand-off (merge the integration tip, comment the ticket, report names later tickets need).
- **`STATE.md`**: the map of the code the spec touches, written once from exploration.
- **`LANDED.md`**: one section appended per merged ticket, with the components, class names, helpers and decisions later tickets build on.

Use a `general-purpose` subagent for exploration: the `Explore` type has no write access, so its notes arrive only as a report the orchestrator then has to save.

### Parallel tickets

Tell each implementer which files the tickets running beside it own, and to keep its edits in shared files (a page template, a spec file) to its own block. Most merge conflicts come from parallel tickets appending a `describe` block to the end of the same spec file: resolve them by keeping both blocks. Merge a ticket inline when it merges cleanly, and keep the **merger subagent** for real conflicts.

