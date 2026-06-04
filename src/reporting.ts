import { and, eq, gte, sql } from 'drizzle-orm';
import { type Classification, classifyTest, type TestObservation } from './classifier.js';
import type { Database } from './db/client.js';
import { ciRuns, quarantine, testResults } from './db/schema.js';
import { classifierGate, type GateResult } from './eval/evaluation.js';
import { applyRecommendation, clearRecommendation } from './quarantine.js';

/**
 * Hours saved per avoided red-build investigation. A transparent, documented
 * heuristic: when a failure is a known flake, an engineer would otherwise spend
 * ~15 minutes triaging a red build before realizing it was noise. We credit that
 * reclaimed time per flaky failure. Tune as real data accrues.
 */
export const HOURS_RECLAIMED_PER_FLAKY_FAILURE = 0.25;

export type QuarantineEntry = {
  testIdentity: string;
  status: 'recommended' | 'cleared';
  classification: string;
  reason: string;
  flakyCount: number;
};

export type FfrReport = {
  windowDays: number;
  totalFailures: number;
  flakyFailures: number;
  ffr: number;
  reclaimedHoursEstimate: number;
  /** Hard-gate result for the classifier. When not passed, recommendations are suppressed. */
  gate: GateResult;
  /** True when the gate suppressed quarantine recommendations this run. */
  quarantineSuppressed: boolean;
  quarantine: QuarantineEntry[];
};

function windowStart(windowDays: number): Date {
  return new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
}

/**
 * Build per-test observation histories from joined test_results + ci_runs within
 * the window. Only tests that have at least one failure in-window are candidates.
 * Returns a map of test_identity -> observations (the classifier input).
 */
async function loadObservations(
  db: Database,
  windowDays: number,
): Promise<Map<string, TestObservation[]>> {
  const start = windowStart(windowDays);

  // SQL-transparent Drizzle join: one row per test_result, carrying the run's
  // commit SHA and completion time. We order in JS inside the classifier, but
  // ask SQL for a stable order to keep results deterministic.
  const rows = await db
    .select({
      testIdentity: testResults.testIdentity,
      outcome: testResults.outcome,
      sha: ciRuns.commitSha,
      attempt: ciRuns.attempt,
      completedAt: ciRuns.completedAt,
    })
    .from(testResults)
    .innerJoin(ciRuns, eq(testResults.runId, ciRuns.id))
    .where(gte(ciRuns.completedAt, start))
    .orderBy(testResults.testIdentity, ciRuns.completedAt);

  // Identify which tests have at least one in-window failure.
  const failingTests = new Set<string>();
  for (const r of rows) {
    if (r.outcome === 'failed') {
      failingTests.add(r.testIdentity);
    }
  }

  const byTest = new Map<string, TestObservation[]>();
  for (const r of rows) {
    if (!failingTests.has(r.testIdentity)) {
      continue;
    }
    const list = byTest.get(r.testIdentity) ?? [];
    list.push({
      sha: r.sha,
      outcome: r.outcome === 'failed' ? 'failed' : 'passed',
      attempt: r.attempt,
      completedAt: (r.completedAt ?? new Date(0)).toISOString(),
    });
    byTest.set(r.testIdentity, list);
  }
  return byTest;
}

export type RecomputeResult = {
  classifications: Map<string, Classification>;
  gate: GateResult;
  suppressed: boolean;
};

/**
 * Recompute the quarantine table from observations in the rolling window.
 *
 * HARD GATE (HER-11): before any recommendation is written, the classifier is
 * evaluated against the labeled benchmark. If the flake-verdict precision does
 * not clear the bar (i.e. the classifier would leak a real defect into
 * quarantine on the benchmark), ALL flake -> quarantine recommendations are
 * SUPPRESSED for this run — nothing is recommended and any existing
 * recommendation is cleared. This structurally enforces "a real failure must
 * never be quarantined as a flake": if the classifier cannot prove its safety
 * on the benchmark, it recommends nothing.
 *
 * For each candidate test the pure classifier decides a verdict:
 *   - flake AND gate passed -> UPSERT a 'recommended' quarantine row
 *   - anything else          -> clear an existing recommendation (status='cleared')
 * Idempotent: running twice with the same data yields the same rows.
 *
 * Confirmation loop (HER-12): the classifier only ever owns the
 * `recommended`/`cleared` states. Once a human has disposed of a recommendation
 * (`confirmed`/`actioned`/`rejected`), recompute leaves that row untouched — a
 * recommendation is never silently revoked or re-issued over a human decision,
 * and an `actioned` quarantine is never un-applied by a background recompute.
 *
 * `gateOverride` is for tests; production passes nothing and the live gate runs.
 */
export async function recomputeQuarantine(
  db: Database,
  windowDays: number,
  gateOverride?: GateResult,
): Promise<RecomputeResult> {
  const gate = gateOverride ?? classifierGate();
  const observations = await loadObservations(db, windowDays);
  const classifications = new Map<string, Classification>();

  for (const [testIdentity, obs] of observations) {
    const classification = classifyTest(obs);
    classifications.set(testIdentity, classification);

    const recommend = classification.verdict === 'flake' && gate.passed;

    if (recommend) {
      const flakyCount = obs.filter((o) => o.outcome === 'failed').length;
      await applyRecommendation(db, {
        testIdentity,
        classification: classification.verdict,
        reason: classification.reason,
        flakyCount,
      });
    } else {
      // Not a flake (or recommendation suppressed by the gate): clear any
      // existing classifier recommendation so nothing stays recommended unsafely.
      const reason =
        classification.verdict === 'flake' && !gate.passed
          ? `recommendation suppressed by classifier gate: ${gate.summary}`
          : classification.reason;
      await clearRecommendation(db, testIdentity, reason);
    }
  }

  return { classifications, gate, suppressed: !gate.passed };
}

/**
 * Compute the Flaky-Failure Rate over the rolling window.
 *
 *   FFR = (# failed test_results classified flake) / (# failed test_results total)
 *
 * A failed test_result counts as "flaky" when its test_identity's classifier
 * verdict (over the same window) is 'flake'. recomputeQuarantine must run first
 * so the verdicts and quarantine table are fresh.
 */
export async function computeFfr(db: Database, windowDays: number): Promise<FfrReport> {
  const { classifications, gate, suppressed } = await recomputeQuarantine(db, windowDays);
  const start = windowStart(windowDays);

  // Total failed test_results in window (SQL-transparent count).
  const totalRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(testResults)
    .innerJoin(ciRuns, eq(testResults.runId, ciRuns.id))
    .where(and(eq(testResults.outcome, 'failed'), gte(ciRuns.completedAt, start)));
  const totalFailures = totalRow[0]?.count ?? 0;

  // Per-identity failed counts in window, so we can sum failures for flake tests.
  const perIdentity = await db
    .select({
      testIdentity: testResults.testIdentity,
      failures: sql<number>`count(*)::int`,
    })
    .from(testResults)
    .innerJoin(ciRuns, eq(testResults.runId, ciRuns.id))
    .where(and(eq(testResults.outcome, 'failed'), gte(ciRuns.completedAt, start)))
    .groupBy(testResults.testIdentity);

  let flakyFailures = 0;
  for (const row of perIdentity) {
    if (classifications.get(row.testIdentity)?.verdict === 'flake') {
      flakyFailures += row.failures;
    }
  }

  const ffr = totalFailures === 0 ? 0 : flakyFailures / totalFailures;
  const reclaimedHoursEstimate = flakyFailures * HOURS_RECLAIMED_PER_FLAKY_FAILURE;

  // Current recommended quarantine list.
  const quarantineRows = await db
    .select({
      testIdentity: quarantine.testIdentity,
      status: quarantine.status,
      classification: quarantine.classification,
      reason: quarantine.reason,
      flakyCount: quarantine.flakyCount,
    })
    .from(quarantine)
    .where(eq(quarantine.status, 'recommended'))
    .orderBy(quarantine.testIdentity);

  return {
    windowDays,
    totalFailures,
    flakyFailures,
    ffr,
    reclaimedHoursEstimate,
    gate,
    quarantineSuppressed: suppressed,
    quarantine: quarantineRows.map((r) => ({
      testIdentity: r.testIdentity,
      status: r.status === 'cleared' ? 'cleared' : 'recommended',
      classification: r.classification,
      reason: r.reason,
      flakyCount: r.flakyCount,
    })),
  };
}
