import { describe, expect, it } from 'vitest';

/**
 * HER-10 CI-signal fixture — INTENTIONALLY FLAKY. Do NOT "fix" or quarantine this
 * in source: its job is to emit a realistic flake population on our own CI so the
 * dogfooded FFR baseline has signal. Excluded from the gating `ci` suite.
 *
 * The stable tests keep the job's pass rate realistic; the one flaky test flips
 * pass/fail run-to-run on the same commit SHA, which the classifier reads as a
 * same-SHA flake (rule 1). Job-level granularity (job name `flaky-signal`) yields
 * the same signal if JUnit per-test ingestion is unavailable.
 */
describe('ci-signal fixture: flaky workload', () => {
  it('stable: arithmetic holds', () => {
    expect(2 + 2).toBe(4);
  });

  it('stable: string concatenation holds', () => {
    expect(`${'a'}${'b'}`).toBe('ab');
  });

  // ~40% failure rate. Over the rolling window this single identity shows both
  // pass and fail on the same SHA -> classified `flake`. A timing/race surrogate:
  // we model the nondeterminism with a uniform draw rather than a real sleep/race
  // so the fixture stays fast and dependency-free.
  it('flaky: intermittent timing/race surrogate', () => {
    const draw = Math.random();
    expect(draw).toBeGreaterThanOrEqual(0.4);
  });
});
