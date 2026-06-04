import { defineConfig } from 'vitest/config';

// Dedicated config for the CI-signal *fixture* workload (HER-10). These tests are
// intentionally flaky / always-failing and exist ONLY to generate a realistic CI
// signal population (flake + real_defect) on our own repo, so the dogfooded FFR
// baseline has a non-empty denominator before the ~2026-06-18 maturity window.
//
// They are NOT part of the gating `ci` suite (which must stay green):
// `vitest.config.ts` includes only `test/**`, never these files, so `pnpm test`
// and the required `ci` check are unaffected.
const inCI = !!process.env.GITHUB_ACTIONS;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['ci-signal-fixtures/**/*.fixture.ts'],
    // Emit JUnit in CI so the daily ingest captures per-test outcomes; locally we
    // keep the default reporter so no stray report file is left behind.
    reporters: inCI ? ['default', 'junit'] : ['default'],
    outputFile: inCI ? { junit: './reports/fixture-junit.xml' } : undefined,
    // No coverage gate: these are signal generators, not product code.
  },
});
