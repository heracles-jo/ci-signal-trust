/**
 * GitHub Actions pull-ingester.
 *
 * The walking skeleton ingested via a push webhook. Phase 2 needs to PULL our
 * own repo's live CI history from the GitHub REST API and feed it through the
 * same idempotent ingestion path.
 *
 * Granularity: each workflow-run ATTEMPT becomes one observation of a synthetic
 * "test" whose identity is the workflow name. Re-running a failed workflow on
 * the SAME commit therefore yields a passed+failed pair on an identical SHA,
 * which the existing pure classifier already labels a flake. When a run uploads
 * a JUnit report we can later resolve per-test outcomes; until then the whole CI
 * job is the unit, which is enough to compute a real run-level FFR baseline from
 * history that already exists — no waiting required.
 *
 * The mapping is a PURE function (no I/O) so it is exhaustively unit-testable.
 * Network access lives in a thin, injectable shell.
 */

import type { CiWebhookBody } from '../schemas.js';

/** Subset of the GitHub Actions workflow-run object we depend on. */
export type GithubWorkflowRun = {
  id: number;
  name?: string | null;
  head_sha: string;
  /** queued | in_progress | completed */
  status?: string | null;
  /** success | failure | cancelled | skipped | timed_out | ... | null */
  conclusion?: string | null;
  run_attempt?: number | null;
  run_started_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

/**
 * Map a GitHub run conclusion to a clean pass/fail signal, or null when the
 * outcome is not a trustworthy success/failure signal (cancelled, skipped, in
 * progress, etc.) and must be dropped rather than guessed.
 */
export function conclusionToOutcome(
  conclusion: string | null | undefined,
): 'passed' | 'failed' | null {
  switch (conclusion) {
    case 'success':
      return 'passed';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failed';
    default:
      // cancelled, skipped, neutral, action_required, stale, null, in-progress
      return null;
  }
}

/**
 * Map a single workflow-run attempt to an ingestible webhook body, or null when
 * the run carries no trustworthy pass/fail signal (and so must be skipped).
 *
 * `externalRunId` embeds the attempt so re-runs are distinct rows under the
 * (provider, externalRunId) uniqueness constraint, while still sharing a SHA.
 */
export function mapWorkflowRunToBody(run: GithubWorkflowRun): CiWebhookBody | null {
  if (run.status && run.status !== 'completed') {
    return null;
  }
  const outcome = conclusionToOutcome(run.conclusion);
  if (outcome === null) {
    return null;
  }
  const attempt = run.run_attempt && run.run_attempt > 0 ? run.run_attempt : 1;
  const startedAt = run.run_started_at ?? run.created_at ?? run.updated_at;
  const completedAt = run.updated_at ?? startedAt;
  if (!startedAt || !completedAt) {
    return null;
  }
  const workflow = (run.name ?? 'workflow').trim() || 'workflow';

  return {
    provider: 'github',
    externalRunId: `${run.id}#${attempt}`,
    commitSha: run.head_sha,
    status: outcome,
    attempt,
    startedAt,
    completedAt,
    tests: [{ identity: `workflow:${workflow}`, outcome }],
  };
}

/**
 * Pure: map a page (or backfill) of workflow runs to ingestible bodies,
 * dropping runs without a clean signal.
 */
export function mapWorkflowRunsToBodies(runs: GithubWorkflowRun[]): CiWebhookBody[] {
  const bodies: CiWebhookBody[] = [];
  for (const run of runs) {
    const body = mapWorkflowRunToBody(run);
    if (body) {
      bodies.push(body);
    }
  }
  return bodies;
}
