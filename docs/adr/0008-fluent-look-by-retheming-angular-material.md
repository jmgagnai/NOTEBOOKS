# The Fluent 2 look comes from re-theming Angular Material, not from Fluent UI's components

The frontend is being restyled to look like Microsoft Copilot Notebooks,
whose visual language is Fluent 2 (see `docs/design/copilot-ui/`). The
obvious way to get a Fluent UI is Fluent's own component library (Fluent UI
Web Components). We decided against it: Angular Material stays, and the
Fluent look is produced by re-theming it — system font stack, Fluent blue
palette, 4 px / 8 px corners, borders instead of elevation, compact density,
Fluent icons registered through Material's icon registry — plus a small set
of global overrides.

Why: every page is already built on Material components, and so are their
tests (the pages are driven through accessible names and roles) and the
accessibility work behind them (focus management, menus, snack bars,
tooltips). Swapping libraries would be a rewrite of every page for a look
that re-theming reaches well enough, and it would put a second component
system next to Angular's own. The trade is fidelity for continuity: a few
Fluent details (control heights, menu motion, the exact focus ring) will
differ from Copilot, and that is accepted.

A prototype on the branch `prototype/notebook-workspace` is the evidence
that the re-theme reads as Fluent in practice; it is where to look before
proposing the library swap again.
