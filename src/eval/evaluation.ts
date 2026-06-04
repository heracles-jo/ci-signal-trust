/**
 * HER-11 classifier evaluation + hard gate. Pure: no I/O, no DB. Exhaustively
 * unit-testable, and cheap enough to run inline before every quarantine recompute.
 *
 * We measure the classifier against the labeled benchmark (src/eval/labeled-set.ts)
 * and enforce the HARD GATE:
 *
 *   "A real failure must NEVER be quarantined as a flake."
 *
 * Operationally that is the PRECISION of the `flake` verdict measured against
 * real-defect labels: of every case the classifier calls `flake`, what fraction
 * are truly flakes (the rest, if any, are real defects we would have wrongly
 * quarantined). The gate passes only when that precision clears an explicit bar.
 */

import { type Classification, classifyTest, type Verdict } from '../classifier.js';
import { type GroundTruthLabel, LABELED_SET, type LabeledCase } from './labeled-set.js';

/**
 * The explicit, stated bar for the flake-verdict precision. We set it to 1.0:
 * ZERO real defects may be classified as flake on the benchmark. This is a hard
 * safety gate, not a tunable quality knob — relaxing it means accepting that
 * some real failures will be silently quarantined, which the product forbids.
 */
export const FLAKE_VERDICT_PRECISION_BAR = 1.0;

export type CaseEvaluation = {
  id: string;
  testIdentity: string;
  groundTruth: GroundTruthLabel;
  predicted: Verdict;
  /** True when the prediction matches the label (indeterminate never matches). */
  correct: boolean;
  /** True for the dangerous error: a real defect predicted as flake. */
  realDefectLeakedAsFlake: boolean;
};

export type ClassMetrics = {
  /** TP / (TP + FP); null when the class was never predicted. */
  precision: number | null;
  /** TP / (TP + FN); null when the class never appears as a label. */
  recall: number | null;
  truePositives: number;
  predictedTotal: number;
  labeledTotal: number;
};

export type EvaluationReport = {
  labeledSetSize: number;
  /** Count of cases whose `source` is 'real-run' (vs canonical). */
  realRunCases: number;
  flake: ClassMetrics;
  realDefect: ClassMetrics;
  /** Cases where truth=real_defect but the verdict was flake — must be empty. */
  realDefectsLeakedAsFlake: CaseEvaluation[];
  perCase: CaseEvaluation[];
};

export type GateResult = {
  bar: number;
  /** Observed precision of the flake verdict against real-defect labels (0..1, or null if no flake predicted). */
  observedFlakePrecision: number | null;
  /** Number of real defects classified as flake. The gate requires this to be 0. */
  realDefectLeakCount: number;
  /** True when quarantine recommendations are allowed to proceed. */
  passed: boolean;
  /** Human-readable one-line explanation. */
  summary: string;
};

function evaluateCase(c: LabeledCase): CaseEvaluation {
  const classification: Classification = classifyTest(c.observations);
  const predicted = classification.verdict;
  const correct = predicted === c.groundTruth;
  const realDefectLeakedAsFlake = c.groundTruth === 'real_defect' && predicted === 'flake';
  return {
    id: c.id,
    testIdentity: c.testIdentity,
    groundTruth: c.groundTruth,
    predicted,
    correct,
    realDefectLeakedAsFlake,
  };
}

function classMetrics(
  cls: GroundTruthLabel,
  perCase: CaseEvaluation[],
  cases: LabeledCase[],
): ClassMetrics {
  const labeledTotal = cases.filter((c) => c.groundTruth === cls).length;
  const predictedTotal = perCase.filter((e) => e.predicted === cls).length;
  const truePositives = perCase.filter((e) => e.predicted === cls && e.groundTruth === cls).length;
  return {
    precision: predictedTotal === 0 ? null : truePositives / predictedTotal,
    recall: labeledTotal === 0 ? null : truePositives / labeledTotal,
    truePositives,
    predictedTotal,
    labeledTotal,
  };
}

/**
 * Evaluate the classifier against a labeled benchmark (defaults to LABELED_SET).
 */
export function evaluateClassifier(cases: LabeledCase[] = LABELED_SET): EvaluationReport {
  const perCase = cases.map(evaluateCase);
  return {
    labeledSetSize: cases.length,
    realRunCases: cases.filter((c) => c.source === 'real-run').length,
    flake: classMetrics('flake', perCase, cases),
    realDefect: classMetrics('real_defect', perCase, cases),
    realDefectsLeakedAsFlake: perCase.filter((e) => e.realDefectLeakedAsFlake),
    perCase,
  };
}

/**
 * Apply the hard gate to an evaluation report. The gate passes iff:
 *   - zero real defects were classified as flake, AND
 *   - the flake-verdict precision is >= the bar (1.0).
 * These are equivalent at bar=1.0; both are checked so the intent survives any
 * future change to the bar.
 */
export function evaluateGate(
  report: EvaluationReport,
  bar: number = FLAKE_VERDICT_PRECISION_BAR,
): GateResult {
  const observedFlakePrecision = report.flake.precision;
  const realDefectLeakCount = report.realDefectsLeakedAsFlake.length;
  const precisionOk = observedFlakePrecision === null || observedFlakePrecision >= bar;
  const passed = realDefectLeakCount === 0 && precisionOk;
  const precisionText =
    observedFlakePrecision === null
      ? 'n/a (no flake verdicts on benchmark)'
      : `${(observedFlakePrecision * 100).toFixed(2)}%`;
  const summary = passed
    ? `PASS: flake-verdict precision ${precisionText} >= bar ${(bar * 100).toFixed(0)}%, ` +
      `0 real defects leaked (labeled set n=${report.labeledSetSize}).`
    : `FAIL: ${realDefectLeakCount} real defect(s) classified as flake; ` +
      `flake-verdict precision ${precisionText} < bar ${(bar * 100).toFixed(0)}% ` +
      `(labeled set n=${report.labeledSetSize}). Quarantine recommendations suppressed.`;
  return { bar, observedFlakePrecision, realDefectLeakCount, passed, summary };
}

/**
 * Convenience: evaluate the built-in benchmark and return the gate result. Called
 * by the quarantine recompute path to decide whether recommendations may proceed.
 */
export function classifierGate(bar: number = FLAKE_VERDICT_PRECISION_BAR): GateResult {
  return evaluateGate(evaluateClassifier(LABELED_SET), bar);
}
