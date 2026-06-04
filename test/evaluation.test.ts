import { describe, expect, it } from 'vitest';
import type { TestObservation } from '../src/classifier.js';
import {
  classifierGate,
  evaluateClassifier,
  evaluateGate,
  FLAKE_VERDICT_PRECISION_BAR,
} from '../src/eval/evaluation.js';
import { LABELED_SET, type LabeledCase } from '../src/eval/labeled-set.js';

const obs = (
  sha: string,
  outcome: 'passed' | 'failed',
  completedAt: string,
  attempt = 1,
): TestObservation => ({ sha, outcome, attempt, completedAt });

describe('labeled set integrity', () => {
  it('is non-empty and every case has provenance, a known source, and a label', () => {
    expect(LABELED_SET.length).toBeGreaterThan(0);
    for (const c of LABELED_SET) {
      expect(c.provenance.trim().length).toBeGreaterThan(0);
      expect(['real-run', 'canonical']).toContain(c.source);
      expect(['flake', 'real_defect']).toContain(c.groundTruth);
      expect(c.observations.length).toBeGreaterThan(0);
    }
  });

  it('has unique case ids', () => {
    const ids = LABELED_SET.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers both classes including the introduced-regression gate cases', () => {
    expect(LABELED_SET.some((c) => c.groundTruth === 'flake')).toBe(true);
    expect(LABELED_SET.some((c) => c.groundTruth === 'real_defect')).toBe(true);
    expect(LABELED_SET.some((c) => c.id.includes('introduced-regression'))).toBe(true);
  });
});

describe('evaluateClassifier on the built-in benchmark', () => {
  const report = evaluateClassifier();

  it('reports the labeled-set size', () => {
    expect(report.labeledSetSize).toBe(LABELED_SET.length);
  });

  it('leaks ZERO real defects as flake (the hard-gate-critical invariant)', () => {
    expect(report.realDefectsLeakedAsFlake).toHaveLength(0);
  });

  it('achieves perfect flake-verdict precision', () => {
    expect(report.flake.precision).toBe(1);
  });

  it('classifies the introduced-regression cases as NOT flake', () => {
    for (const e of report.perCase) {
      if (e.id.includes('introduced-regression')) {
        expect(e.predicted).not.toBe('flake');
      }
    }
  });
});

describe('hard gate', () => {
  it('passes on the current classifier + benchmark', () => {
    const gate = classifierGate();
    expect(gate.passed).toBe(true);
    expect(gate.realDefectLeakCount).toBe(0);
    expect(gate.bar).toBe(FLAKE_VERDICT_PRECISION_BAR);
  });

  it('FAILS when a real defect is mislabeled such that the classifier leaks it', () => {
    // Inject a benchmark case whose ground truth is real_defect but whose history
    // is an unambiguous same-SHA flake — the classifier will (correctly) call it
    // flake, which against this (wrong) label is a leak the gate must catch.
    const leaky: LabeledCase = {
      id: 'synthetic-leak',
      testIdentity: 'synthetic.leak',
      observations: [
        obs('z1', 'failed', '2026-01-01T00:00:00Z', 1),
        obs('z1', 'passed', '2026-01-01T00:05:00Z', 2),
      ],
      groundTruth: 'real_defect',
      source: 'canonical',
      provenance: 'test-only: forces a flake/real_defect disagreement to prove the gate trips',
    };
    const report = evaluateClassifier([...LABELED_SET, leaky]);
    const gate = evaluateGate(report);
    expect(gate.realDefectLeakCount).toBe(1);
    expect(gate.passed).toBe(false);
    expect(gate.observedFlakePrecision).toBeLessThan(1);
  });

  it('respects an explicit bar argument', () => {
    const report = evaluateClassifier();
    // Even an impossible bar above 1 must fail when precision is exactly 1.
    const gate = evaluateGate(report, 1.01);
    expect(gate.passed).toBe(false);
  });
});
