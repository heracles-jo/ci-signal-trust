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

    it('flags a single transition fail->pass across two SHAs', () => {
      const result = classifyTest([
        obs('s1', 'failed', '2026-01-01T00:00:00Z'),
        obs('s2', 'passed', '2026-01-02T00:00:00Z'),
      ]);
      expect(result.verdict).toBe('flake');
      expect(result.reason).toBe('cross-SHA flip-flop');
    });

    it('orders by completedAt regardless of input order before deciding alternation', () => {
      // Provided out of chronological order; time-sorted it is pass -> fail (a flip).
      const result = classifyTest([
        obs('s2', 'failed', '2026-01-02T00:00:00Z'),
        obs('s1', 'passed', '2026-01-01T00:00:00Z'),
      ]);
      expect(result.verdict).toBe('flake');
      expect(result.reason).toBe('cross-SHA flip-flop');
    });

    it('uses attempt as a tie-break when completedAt is identical', () => {
      const result = classifyTest([
        obs('s1', 'passed', '2026-01-01T00:00:00Z', 2),
        obs('s2', 'failed', '2026-01-01T00:00:00Z', 1),
      ]);
      // s2(fail, attempt1) then s1(pass, attempt2) -> one flip -> flake.
      expect(result.verdict).toBe('flake');
      expect(result.reason).toBe('cross-SHA flip-flop');
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

    // NOTE on the residual `indeterminate` "mixed outcomes" branch in the
    // classifier: it is intentionally defensive. To reach it we would need both a
    // pass and a fail present, no same-SHA flake (rule 1), and no time-ordered
    // alternation across >=2 SHAs (rule 2). With pass+fail and no same-SHA flake,
    // the observations span >=2 distinct SHAs, and any time-ordering of a mixed
    // pass/fail set has at least one transition -> rule 2 always fires first.
    // The branch therefore guards against future rule changes; it is not
    // reachable with the current rule set.
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
