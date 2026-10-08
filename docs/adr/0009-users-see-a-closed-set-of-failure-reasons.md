# Users see a closed set of failure reasons, never the raw error

When a Document Version fails Ingestion, the user is shown one failure reason
from a closed set (`no-text-layer`, `unreadable`, `timed-out`,
`service-unavailable`, `unexpected`), each rendered as one fixed sentence by
the frontend; the full error stays in the backend's logs and database. The
obvious alternative was to show the caught error's message, which is what the
row already stored. We rejected it for three reasons: a raw error leaks
internals (stack frames, container names, provider responses) to every user of
a shared Notebook; its wording changes whenever a dependency does, so nothing
can be built or tested on it; and it rarely tells the user what to do, whereas
each reason's sentence names the cause and the next step.

## Consequences

- A cause the backend has not classified surfaces as `unexpected`, so
  recognising a new cause means adding a reason to the contract, not just
  throwing a better message.
- The sentences live in one frontend module (`documents/failure-reason.ts`),
  keyed on the generated contract's union, so a reason added to the backend
  fails the frontend typecheck until it has wording.
