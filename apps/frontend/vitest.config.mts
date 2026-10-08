import { defineConfig } from 'vitest/config';

// Read by the Angular unit-test builder through `runnerConfig` (angular.json),
// which still owns the build, the jsdom environment and the TestBed setup.
export default defineConfig({
  test: {
    // NBK-94: each spec file's first test pays a one-off warm-up of 3–4 s
    // (its first render), so it ran at 3.1–4.9 s on a quiet machine — up to
    // 98% of Vitest's 5 s default — and timed out whenever the parallel
    // workers or Docling ingestion loaded the machine. Later tests in the
    // same file take about 1 s. 15 s is three times the worst first test: a
    // real hang still fails, and `findBy*` queries give up after 1 s anyway.
    testTimeout: 15_000,
  },
});
