import { configure } from '@testing-library/angular';

// Set up once for every spec file (angular.json, test `setupFiles`).

// `findBy*` and `waitFor` give up after 1 s by default. A loaded machine —
// the full suite's parallel workers, or a Docling conversion in the
// background (docs/environment-gotchas.md) — made a deletion test miss that
// second now and then, while it passed on its own. A wait only takes as
// long as the thing it waits for, so a longer limit slows nothing that
// passes; it only lets a slow machine finish.
// Through Testing Library for Angular, which applies its `dom` settings to
// the DOM library it renders with.
configure({ dom: { asyncUtilTimeout: 3_000 } });
