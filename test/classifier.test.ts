import { describe, expect, it } from 'vitest';
import { classifyTest, type TestObservation } from '../src/classifier.js';

const obs = (
  sha: string,
  outcome: 'passed' | 'failed',
  completedAt: string,
  attempt = 1,
): TestObservation => ({ sha, outcome, attempt, completedAt });

describe('classifyTest', () => {
  it('returns indeterminate for empty input', () => {
    const result = classifyTest([]);
    expect(result.verdict).toBe('indeterminate');
    expect(result.reason).toBe('no observations provided');
  });

  describe('rule 1: same-SHA flake', () => {
    it('flags pass+fail on the same SHA across separate runs', () => {
      const result = classifyTest([
        obs('abc', 'failed', '2026-01-01T00:00:00Z'),
        obs('abc', 'passed', '2026-01-01T01:00:00Z'),
      ]);
      expect(result.verdict).toBe('flake');
      expect(result.reason).toBe('passed and failed on identical SHA abc');
    });

    it('flags retry-pass-after-fail on the same SHA (same run, higher attempt)', () => {
      const result = classifyTest([
        obs('def', 'failed', '2026-01-01T00:00:00Z', 1),
        obs('def', 'passed', '2026-01-01T00:05:00Z', 2),
      ]);
      expect(result.verdict).toBe('flake');
      expect(result.reason).toContain('def');
    });

    it('takes precedence over cross-SHA signals (rule 1 before rule 2)', () => {
      const result = classifyTest([
        obs('s1', 'failed', '2026-01-01T00:00:00Z'),
        obs('s1', 'passed', '2026-01-01T01:00:00Z'),
        obs('s2', 'failed', '2026-01-02T00:00:00Z'),
      ]);
      expect(result.verdict).toBe('flake');
      expect(result.reason).toContain('identical SHA');
    });
  });

  describe('rule 2: cross-SHA flip-flop', () => {
    it('flags alternating pass/fail across distinct SHAs', () => {
      const result = classifyTest([
        obs('s1', 'passed', '2026-01-01T00:00:00Z'),
        obs('s2', 'failed', '2026-01-02T00:00:00Z'),
        obs('s3', 'passed', '2026-01-03T00:00:00Z'),
      ]);
      expect(result.verdict).toBe('flake');
      expect(result.reason).toBe('cross-SHA flip-flop');
    });

    it('flags alternating fail/pass/fail across three SHAs (2 transitions)', () => {
      const result = classifyTest([
        obs('s1', 'failed', '2026-01-01T00:00:00Z'),
        obs('s2', 'passed', '2026-01-02T00:00:00Z'),
        obs('s3', 'failed', '2026-01-03T00:00:00Z'),
      ]);
      expect(result.verdict).toBe('flake');
      expect(result.reason).toBe('cross-SHA flip-flop');
    });

    it('orders by completedAt regardless of input order before deciding alternation', () => {
      // Provided out of chronological order; time-sorted it is pass -> fail -> pass
      // (2 transitions) -> a genuine flip-flop.
      const result = classifyTest([
        obs('s2', 'failed', '2026-01-02T00:00:00Z'),
        obs('s3', 'passed', '2026-01-03T00:00:00Z'),
        obs('s1', 'passed', '2026-01-01T00:00:00Z'),
      ]);
      expect(result.verdict).toBe('flake');
      expect(result.reason).toBe('cross-SHA flip-flop');
    });

    it('does NOT flag a single monotonic transition (HER-11 hard gate)', () => {
      // fail -> pass across two SHAs is one transition: indistinguishable from a
      // real defect being fixed. Conservatively NOT a flake.
      const fixed = classifyTest([
        obs('s1', 'failed', '2026-01-01T00:00:00Z'),
        obs('s2', 'passed', '2026-01-02T00:00:00Z'),
      ]);
      expect(fixed.verdict).toBe('indeterminate');

      // pass -> fail across two SHAs is a freshly introduced regression: a real
      // failure that must NEVER be quarantined as flake.
      const regressed = classifyTest([
        obs('s1', 'passed', '2026-01-01T00:00:00Z'),
        obs('s2', 'failed', '2026-01-02T00:00:00Z'),
      ]);
      expect(regressed.verdict).toBe('indeterminate');
    });
  });

  describe('rule 3: real defect', () => {
    it('flags only-failures across multiple distinct SHAs as real_defect', () => {
      const result = classifyTest([
        obs('s1', 'failed', '2026-01-01T00:00:00Z'),
        obs('s2', 'failed', '2026-01-02T00:00:00Z'),
      ]);
      expect(result.verdict).toBe('real_defect');
      expect(result.reason).toBe('only failures observed');
    });

    it('flags a single lone failure as real_defect', () => {
      const result = classifyTest([obs('s1', 'failed', '2026-01-01T00:00:00Z')]);
      expect(result.verdict).toBe('real_defect');
      expect(result.reason).toBe('only failures observed');
    });
  });

  describe('rule 4: indeterminate', () => {
    it('returns indeterminate when there are no failures at all (all passes)', () => {
      const result = classifyTest([
        obs('s1', 'passed', '2026-01-01T00:00:00Z'),
        obs('s2', 'passed', '2026-01-02T00:00:00Z'),
      ]);
      expect(result.verdict).toBe('indeterminate');
      expect(result.reason).toBe('no failures observed');
    });

    it('treats duplicate identical failures on one SHA as real_defect (no pass present)', () => {
      const result = classifyTest([
        obs('s1', 'failed', '2026-01-01T00:00:00Z', 1),
        obs('s1', 'failed', '2026-01-01T00:00:00Z', 1),
      ]);
      expect(result.verdict).toBe('real_defect');
    });

    it('returns indeterminate for a single passing observation', () => {
      const result = classifyTest([obs('s1', 'passed', '2026-01-01T00:00:00Z')]);
      expect(result.verdict).toBe('indeterminate');
      expect(result.reason).toBe('no failures observed');
    });

    // The `indeterminate` "mixed outcomes" branch is reached by a single
    // monotonic transition across SHAs (pass+fail present, no same-SHA flake, and
    // <2 time-ordered transitions) — i.e. an introduced regression or a fix. Per
    // the HER-11 hard gate these are deliberately NOT flakes.
    it('returns indeterminate for a single monotonic transition across SHAs', () => {
      const result = classifyTest([
        obs('s1', 'passed', '2026-01-01T00:00:00Z'),
        obs('s2', 'failed', '2026-01-02T00:00:00Z'),
      ]);
      expect(result.verdict).toBe('indeterminate');
      expect(result.reason).toBe('mixed outcomes without same-SHA flake or cross-SHA alternation');
    });
  });

  it('produces an exhaustive discriminated union verdict', () => {
    const verdicts = new Set(
      [
        classifyTest([]),
        classifyTest([obs('a', 'failed', '2026-01-01T00:00:00Z')]),
        classifyTest([
          obs('a', 'failed', '2026-01-01T00:00:00Z'),
          obs('a', 'passed', '2026-01-01T01:00:00Z'),
        ]),
        classifyTest([
          obs('a', 'passed', '2026-01-01T00:00:00Z'),
          obs('b', 'failed', '2026-01-02T00:00:00Z'),
        ]),
      ].map((c) => c.verdict),
    );
    expect(verdicts.has('flake')).toBe(true);
    expect(verdicts.has('real_defect')).toBe(true);
    expect(verdicts.has('indeterminate')).toBe(true);
  });
});
