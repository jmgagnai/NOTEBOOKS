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

// A test fails when it logs an error. Angular reports what goes wrong while
// rendering — an icon the registry doesn't have, a template error inside an
// effect — through `console.error` and carries on, so the test passes with
// the error printed above it: the Search page's Chat Thread rows shipped
// without their icon while CI printed "Error retrieving icon :chat!" on
// every run. A test that means to provoke an error stubs `console.error`
// itself, and its stub replaces this one.
let errors: unknown[][] = [];
let spy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
  errors = [];
  const original = console.error.bind(console);
  spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
    original(...args);
  });
});
afterEach(() => {
  // By reference: a test that stubbed console.error may have restored it.
  spy?.mockRestore();
  if (errors.length > 0) {
    const first = errors[0].map((part) => (part instanceof Error ? part.message : String(part)));
    throw new Error(
      `The test logged ${errors.length} error(s) with console.error; the first: ${first.join(' ')}`,
    );
  }
});
