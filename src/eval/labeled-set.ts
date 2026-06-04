/**
 * HER-11 labeled benchmark: real failures vs flakes, with provenance per label.
 *
 * Each case is a single test-identity observation history paired with a
 * GROUND-TRUTH label and the provenance that justifies that label. The benchmark
 * is the fixed input to the classifier evaluation (src/eval/evaluation.ts) and to
 * the hard gate that guards the quarantine loop.
 *
 * Label integrity — every case declares its `source`:
 *   - 'real-run'  : derived from a run actually ingested from our CI history;
 *                   `provenance` cites the run id / SHA / PR it came from.
 *   - 'canonical' : a hand-constructed history that encodes a known CI failure
 *                   mode. The label is true BY CONSTRUCTION and `provenance`
 *                   states the mode and the real-world analog it represents.
 *
 * Our own CI history is still young (the only ingested runs at authoring time —
 * GHA runs 26958164555 and 26958383895 on heracles-jo/ci-signal-trust — both
 * PASSED, so they yield no labeled FAILURE cases yet). The benchmark therefore
 * starts as a curated set of canonical cases covering each failure mode the
 * classifier claims to handle, plus the adversarial real-defect patterns the
 * hard gate exists to protect. As backfill (HER-9) surfaces real failures with
 * adjudicated labels, append them here as `source: 'real-run'` cases; the gate
 * and metrics recompute automatically.
 */

import type { TestObservation } from '../classifier.js';

/** Only the two classes the hard gate adjudicates. Indeterminate is a verdict, not a label. */
export type GroundTruthLabel = 'real_defect' | 'flake';

export type LabelSource = 'real-run' | 'canonical';

export type LabeledCase = {
  /** Stable, human-readable case id. */
  id: string;
  testIdentity: string;
  observations: TestObservation[];
  groundTruth: GroundTruthLabel;
  source: LabelSource;
  /** Why this label is correct, and where it came from. Required for every case. */
  provenance: string;
};

function obs(
  sha: string,
  outcome: 'passed' | 'failed',
  completedAt: string,
  attempt = 1,
): TestObservation {
  return { sha, outcome, attempt, completedAt };
}

export const LABELED_SET: LabeledCase[] = [
  // ---- FLAKES -------------------------------------------------------------
  {
    id: 'flk-same-sha-retry',
    testIdentity: 'integration.PaymentGatewaySpec#chargesCard',
    observations: [
      obs('a1f3c9d', 'failed', '2026-05-02T10:00:00Z', 1),
      obs('a1f3c9d', 'passed', '2026-05-02T10:06:00Z', 2),
    ],
    groundTruth: 'flake',
    source: 'canonical',
    provenance:
      'Same-SHA fail-then-pass across retry attempts: identical code cannot deterministically both pass and fail. Mirrors the e2e suite.flakyTest scenario; classic infra/network retry flake.',
  },
  {
    id: 'flk-same-sha-reruns',
    testIdentity: 'integration.SessionSpec#expiresIdleSession',
    observations: [
      obs('b2e4d70', 'failed', '2026-05-03T09:00:00Z', 1),
      obs('b2e4d70', 'passed', '2026-05-03T11:30:00Z', 1),
    ],
    groundTruth: 'flake',
    source: 'canonical',
    provenance:
      'Same SHA, two separate workflow runs, fail then pass with no code change between them — non-deterministic timing flake.',
  },
  {
    id: 'flk-same-sha-with-trailing-passes',
    testIdentity: 'unit.CacheSpec#evictsOnTtl',
    observations: [
      obs('c33aa11', 'failed', '2026-05-04T08:00:00Z', 1),
      obs('c33aa11', 'passed', '2026-05-04T08:05:00Z', 2),
      obs('c33aa11', 'passed', '2026-05-04T12:00:00Z', 1),
    ],
    groundTruth: 'flake',
    source: 'canonical',
    provenance:
      'Same-SHA contradiction (one fail, multiple passes on identical code) — TTL/clock sensitivity flake.',
  },
  {
    id: 'flk-flipflop-pfp',
    testIdentity: 'integration.SearchSpec#ranksResults',
    observations: [
      obs('d001', 'passed', '2026-05-05T08:00:00Z'),
      obs('d002', 'failed', '2026-05-06T08:00:00Z'),
      obs('d003', 'passed', '2026-05-07T08:00:00Z'),
    ],
    groundTruth: 'flake',
    source: 'canonical',
    provenance:
      'pass -> fail -> pass across three distinct SHAs (2 transitions). Outcome oscillates without a sustained regression — genuine cross-commit instability.',
  },
  {
    id: 'flk-flipflop-fpf',
    testIdentity: 'integration.QueueSpec#drainsBacklog',
    observations: [
      obs('e001', 'failed', '2026-05-08T08:00:00Z'),
      obs('e002', 'passed', '2026-05-09T08:00:00Z'),
      obs('e003', 'failed', '2026-05-10T08:00:00Z'),
    ],
    groundTruth: 'flake',
    source: 'canonical',
    provenance:
      'fail -> pass -> fail across three SHAs (2 transitions). Re-failing after a green commit with no shared code cause — order/concurrency flake.',
  },
  {
    id: 'flk-flipflop-long',
    testIdentity: 'integration.NotifierSpec#deliversWebhook',
    observations: [
      obs('f001', 'passed', '2026-05-11T08:00:00Z'),
      obs('f002', 'failed', '2026-05-12T08:00:00Z'),
      obs('f003', 'passed', '2026-05-13T08:00:00Z'),
      obs('f004', 'failed', '2026-05-14T08:00:00Z'),
    ],
    groundTruth: 'flake',
    source: 'canonical',
    provenance:
      'Sustained oscillation P/F/P/F across four SHAs (3 transitions) — high-confidence flip-flop flake.',
  },
  {
    id: 'flk-same-sha-amid-cross',
    testIdentity: 'integration.UploadSpec#resumesPartial',
    observations: [
      obs('g001', 'failed', '2026-05-15T08:00:00Z', 1),
      obs('g001', 'passed', '2026-05-15T08:30:00Z', 2),
      obs('g002', 'failed', '2026-05-16T08:00:00Z', 1),
    ],
    groundTruth: 'flake',
    source: 'canonical',
    provenance:
      'Same-SHA contradiction on g001 (fail+pass) dominates regardless of the later g002 failure — rule-1 flake.',
  },

  // ---- REAL DEFECTS -------------------------------------------------------
  {
    id: 'rd-lone-failure',
    testIdentity: 'unit.InvoiceSpec#roundsTotals',
    observations: [obs('h001', 'failed', '2026-05-17T08:00:00Z')],
    groundTruth: 'real_defect',
    source: 'canonical',
    provenance:
      'A single failing observation, no passing evidence anywhere — a deterministic break until proven otherwise. Must never be quarantined as flake.',
  },
  {
    id: 'rd-persistent-two-sha',
    testIdentity: 'unit.AuthSpec#rejectsExpiredToken',
    observations: [
      obs('i001', 'failed', '2026-05-18T08:00:00Z'),
      obs('i002', 'failed', '2026-05-19T08:00:00Z'),
    ],
    groundTruth: 'real_defect',
    source: 'canonical',
    provenance:
      'Fails on two consecutive SHAs with zero passes — a sustained regression. Security-relevant (token expiry) defect that must not be hidden.',
  },
  {
    id: 'rd-persistent-many-attempts',
    testIdentity: 'integration.MigrationSpec#appliesIdempotently',
    observations: [
      obs('j001', 'failed', '2026-05-20T08:00:00Z', 1),
      obs('j001', 'failed', '2026-05-20T08:10:00Z', 2),
      obs('j002', 'failed', '2026-05-21T08:00:00Z', 1),
      obs('j003', 'failed', '2026-05-22T08:00:00Z', 1),
    ],
    groundTruth: 'real_defect',
    source: 'canonical',
    provenance:
      'Repeatedly retried (same and later SHAs) and never once passed — retries did not rescue it, so it is a real defect, not a flake.',
  },
  {
    id: 'rd-deterministic-retry-allfail',
    testIdentity: 'unit.PricingSpec#appliesDiscountTier',
    observations: [
      obs('k001', 'failed', '2026-05-23T08:00:00Z', 1),
      obs('k001', 'failed', '2026-05-23T08:05:00Z', 2),
    ],
    groundTruth: 'real_defect',
    source: 'canonical',
    provenance:
      'ADVERSARIAL: retried on the SAME SHA but failed both attempts. Superficially "retried like a flake" yet never passed — a same-SHA all-fail is a hard defect. Guards against treating any retry as flaky.',
  },
  {
    id: 'rd-introduced-regression',
    testIdentity: 'integration.CheckoutSpec#appliesTax',
    observations: [
      obs('l000', 'passed', '2026-05-24T08:00:00Z'),
      obs('l001', 'failed', '2026-05-25T08:00:00Z'),
      obs('l002', 'failed', '2026-05-26T08:00:00Z'),
    ],
    groundTruth: 'real_defect',
    source: 'canonical',
    provenance:
      'CRITICAL GATE CASE: green on the parent commit, then a code change broke it and it stays red (pass -> fail -> fail, one monotonic transition). The pre-tightening Rule 2 would call this a cross-SHA "flip-flop" flake and quarantine a real regression. The hard gate exists to forbid exactly this.',
  },
  {
    id: 'rd-introduced-regression-minimal',
    testIdentity: 'integration.CheckoutSpec#appliesShipping',
    observations: [
      obs('m000', 'passed', '2026-05-27T08:00:00Z'),
      obs('m001', 'failed', '2026-05-28T08:00:00Z'),
    ],
    groundTruth: 'real_defect',
    source: 'canonical',
    provenance:
      'CRITICAL GATE CASE: passed on the parent SHA, fails on the child SHA (single pass->fail transition) — a freshly introduced regression. Must never be quarantined as flake on the strength of one transition.',
  },
];
