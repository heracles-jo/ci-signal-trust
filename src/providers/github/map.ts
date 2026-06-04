/**
 * PURE GitHub Actions mappers. NO network, NO DB — exhaustively unit-testable.
 *
 * Maps GitHub Actions REST payloads to our normalized ingestion model:
 *   - mapWorkflowRun / mapWorkflowRuns : workflow-run (attempt) -> run-level record
 *   - mapJobsToObservations            : jobs -> job-granularity observations
 *
 * Per-test observations come from JUnit artifacts (src/providers/junit/parse.ts);
 * when no JUnit is present we fall back to these job-granularity observations so a
 * real baseline is computable from run history alone (HER-8 scope).
 */

import type { ObservationInput, Outcome } from '../model.js';
import type { GithubJob, GithubWorkflowRun } from './types.js';

/** Stable provider key stored in ci_runs.provider for GitHub Actions pulls. */
export const GITHUB_PROVIDER = 'github-actions';

/** Run-level metadata mapped from a workflow-run attempt (no observations yet). */
export type MappedRun = {
  provider: string;
  externalRunId: string;
  commitSha: string;
  status: Outcome;
  attempt: number;
  /** ISO-8601 strings; the ingester converts to Date at the persistence boundary. */
  startedAt: string;
  completedAt: string;
  workflowName: string | null;
};

export type MapRunResult =
  | { kind: 'ingest'; run: MappedRun }
  | { kind: 'skip'; externalRunId: string; reason: string };

/**
 * Collapse a GitHub `conclusion` to our binary pass/fail, or null when the run
 * carries no clean signal (cancelled / skipped / still running). A null result
 * means "do not count this run" — critical for baseline correctness: we must not
 * record a cancelled run as a failure.
 */
export function conclusionToOutcome(conclusion: string | null | undefined): Outcome | null {
  switch (conclusion) {
    case 'success':
      return 'passed';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failed';
    default:
      // cancelled, skipped, neutral, action_required, stale, null, unknown.
      return null;
  }
}

/** Build the idempotency key for a run attempt: unique per (run id, attempt). */
export function externalRunId(runId: number, attempt: number): string {
  return `${runId}/attempt/${attempt}`;
}

/**
 * Map one workflow-run attempt to a run-level record, or a skip with a reason.
 * Skips: not yet completed, or a non-pass/fail conclusion.
 */
export function mapWorkflowRun(run: GithubWorkflowRun): MapRunResult {
  const attempt = run.run_attempt ?? 1;
  const extId = externalRunId(run.id, attempt);

  if (run.status !== 'completed') {
    return {
      kind: 'skip',
      externalRunId: extId,
      reason: `status=${run.status ?? 'null'} (not completed)`,
    };
  }

  const outcome = conclusionToOutcome(run.conclusion);
  if (outcome === null) {
    return {
      kind: 'skip',
      externalRunId: extId,
      reason: `conclusion=${run.conclusion ?? 'null'} (no pass/fail signal)`,
    };
  }

  return {
    kind: 'ingest',
    run: {
      provider: GITHUB_PROVIDER,
      externalRunId: extId,
      commitSha: run.head_sha,
      status: outcome,
      attempt,
      startedAt: run.run_started_at ?? run.created_at,
      completedAt: run.updated_at,
      workflowName: run.name ?? null,
    },
  };
}

export type MappedRuns = {
  runs: MappedRun[];
  skipped: { externalRunId: string; reason: string }[];
};

/** Map a batch of workflow-run attempts, partitioning into ingestable vs skipped. */
export function mapWorkflowRuns(runs: GithubWorkflowRun[]): MappedRuns {
  const out: MappedRuns = { runs: [], skipped: [] };
  for (const run of runs) {
    const res = mapWorkflowRun(run);
    if (res.kind === 'ingest') {
      out.runs.push(res.run);
    } else {
      out.skipped.push({ externalRunId: res.externalRunId, reason: res.reason });
    }
  }
  return out;
}

function durationMs(startedAt?: string | null, completedAt?: string | null): number | null {
  if (!startedAt || !completedAt) {
    return null;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return end - start;
}

/**
 * Map a run's jobs to job-granularity observations (the no-JUnit fallback). Jobs
 * without a pass/fail conclusion (cancelled/skipped) are dropped so they don't
 * pollute the baseline. The identity namespaces by workflow + job so the same job
 * across attempts/SHAs is comparable — that's what makes same-SHA fail-then-pass
 * detectable at job granularity.
 */
export function mapJobsToObservations(
  jobs: GithubJob[],
  opts: { workflowName?: string | null } = {},
): ObservationInput[] {
  const out: ObservationInput[] = [];
  for (const job of jobs) {
    const outcome = conclusionToOutcome(job.conclusion);
    if (outcome === null) {
      continue;
    }
    const workflow = job.workflow_name ?? opts.workflowName ?? 'workflow';
    out.push({
      identity: `gha-job:${workflow}/${job.name}`,
      outcome,
      durationMs: durationMs(job.started_at, job.completed_at),
    });
  }
  return out;
}
