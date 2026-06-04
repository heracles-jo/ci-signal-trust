import { describe, expect, it } from 'vitest';

/**
 * HER-10 CI-signal fixture — INTENTIONALLY ALWAYS-FAILING ("real defect"). Do NOT
 * "fix" this in source: it represents a genuine persistent failure so the FFR
 * baseline's denominator includes a non-flake failure (classifier verdict
 * `real_defect`). That makes FFR strictly < 100% and therefore meaningful.
 * Excluded from the gating `ci` suite; runs only in the `defect-signal` job of the
 * CI Signal Fixture workflow.
 */
describe('ci-signal fixture: real-defect workload', () => {
  it('real_defect: deterministic persistent failure', () => {
    expect('observed').toBe('expected');
  });
});
