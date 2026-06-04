/**
 * GitHub Actions pull-ingester (orchestration). Wires the read-only client to the
 * pure mappers and the shared idempotent persistRun:
 *
 *   list runs -> for each run, each attempt -> map (pure) ->
 *     observations: JUnit per-test (if artifact present) ELSE job-granularity ->
 *     persistRun (idempotent on provider+externalRunId)
 *
 * Re-run attempts are captured as distinct ci_runs sharing a head SHA, so a
 * same-SHA fail-then-pass across attempts is detectable as a flake without JUnit.
 * Per run-attempt we record exactly ONE granularity of observation (JUnit XOR
 * jobs) so FFR failure counts stay coherent. Idempotent: re-pulling is a no-op,
 * which is what daily backfill (HER-9) requires.
 */

import type { Database } from '../../db/client.js';
import { persistRun } from '../../ingestion.js';
import { isJUnitArtifactName, observationsFromArtifactZip } from '../junit/artifact.js';
import type { ObservationInput } from '../model.js';
import type { GithubActionsApi } from './client.js';
import { mapJobsToObservations, mapWorkflowRun } from './map.js';
import type { GithubWorkflowRun } from './types.js';

export type PullIngestOptions = {
  /** Cap how many workflow runs to scan (newest first). Default: all available. */
  maxRuns?: number;
  /** Fetch every attempt 1..run_attempt, not just the latest. Default: true. */
  includeAllAttempts?: boolean;
  /** Try JUnit artifacts for per-test resolution. Default: true. */
  useArtifacts?: boolean;
  /** Optional structured logger (pino-compatible). */
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  };
};

export type PullIngestSummary = {
  runsScanned: number;
  attemptsConsidered: number;
  ingested: number;
  duplicates: number;
  skipped: number;
  observationsWritten: number;
  junitAttempts: number;
  jobAttempts: number;
  runAttempts: number;
};

/** Fetch + decode JUnit observations for a run, or [] if none/unreadable. */
async function fetchJUnitObservations(
  api: GithubActionsApi,
  runId: number,
): Promise<ObservationInput[]> {
  const artifacts = await api.listArtifacts(runId);
  const junit = artifacts.filter((a) => !a.expired && isJUnitArtifactName(a.name));
  const out: ObservationInput[] = [];
  for (const artifact of junit) {
    const zip = await api.downloadArtifactZip(artifact.id);
    out.push(...observationsFromArtifactZip(zip));
  }
  return out;
}

/**
 * Resolve the full list of attempt objects for a run. The list endpoint already
 * gives us the latest attempt; earlier attempts are fetched individually.
 */
async function resolveAttempts(
  api: GithubActionsApi,
  latest: GithubWorkflowRun,
  includeAll: boolean,
): Promise<GithubWorkflowRun[]> {
  const latestAttempt = latest.run_attempt ?? 1;
  if (!includeAll || latestAttempt <= 1) {
    return [latest];
  }
  const attempts: GithubWorkflowRun[] = [];
  for (let n = 1; n < latestAttempt; n++) {
    attempts.push(await api.getRunAttempt(latest.id, n));
  }
  attempts.push(latest);
  return attempts;
}

export async function pullIngest(
  db: Database,
  api: GithubActionsApi,
  options: PullIngestOptions = {},
): Promise<PullIngestSummary> {
  const includeAllAttempts = options.includeAllAttempts ?? true;
  const useArtifacts = options.useArtifacts ?? true;
  const log = options.logger;

  const summary: PullIngestSummary = {
    runsScanned: 0,
    attemptsConsidered: 0,
    ingested: 0,
    duplicates: 0,
    skipped: 0,
    observationsWritten: 0,
    junitAttempts: 0,
    jobAttempts: 0,
    runAttempts: 0,
  };

  const runs = await api.listWorkflowRuns({ maxRuns: options.maxRuns });
  summary.runsScanned = runs.length;

  for (const latest of runs) {
    const latestAttempt = latest.run_attempt ?? 1;
    const attempts = await resolveAttempts(api, latest, includeAllAttempts);

    // JUnit artifacts are run-scoped, so we only apply them to the latest attempt.
    let junitForLatest: ObservationInput[] = [];
    if (useArtifacts) {
      try {
        junitForLatest = await fetchJUnitObservations(api, latest.id);
      } catch (err) {
        log?.warn(
          { runId: latest.id, err: String(err) },
          'junit artifact fetch failed; using jobs',
        );
      }
    }

    for (const attempt of attempts) {
      summary.attemptsConsidered++;
      const mapped = mapWorkflowRun(attempt);
      if (mapped.kind === 'skip') {
        summary.skipped++;
        log?.info({ externalRunId: mapped.externalRunId, reason: mapped.reason }, 'skip run');
        continue;
      }

      const isLatest = (attempt.run_attempt ?? 1) === latestAttempt;
      let observations: ObservationInput[] = [];
      let granularity: 'junit' | 'job' | 'run' = 'run';
      if (isLatest && junitForLatest.length > 0) {
        observations = junitForLatest;
        granularity = 'junit';
      } else {
        const jobs = await api.listJobsForAttempt(latest.id, attempt.run_attempt ?? 1);
        observations = mapJobsToObservations(jobs, { workflowName: mapped.run.workflowName });
        if (observations.length > 0) {
          granularity = 'job';
        }
      }

      // Fallback: a run with no JUnit and no pass/fail jobs still contributes its
      // run-level pass/fail, so same-SHA fail-then-pass is detectable at workflow
      // granularity and the baseline is never silently empty.
      if (observations.length === 0) {
        observations = [
          {
            identity: `gha-run:${mapped.run.workflowName ?? 'workflow'}`,
            outcome: mapped.run.status,
            durationMs:
              Math.max(0, Date.parse(mapped.run.completedAt) - Date.parse(mapped.run.startedAt)) ||
              null,
          },
        ];
        granularity = 'run';
      }

      const result = await persistRun(db, {
        provider: mapped.run.provider,
        externalRunId: mapped.run.externalRunId,
        commitSha: mapped.run.commitSha,
        status: mapped.run.status,
        attempt: mapped.run.attempt,
        startedAt: new Date(mapped.run.startedAt),
        completedAt: new Date(mapped.run.completedAt),
        observations,
      });

      if (result.status === 'accepted') {
        summary.ingested++;
        summary.observationsWritten += observations.length;
        if (granularity === 'junit') {
          summary.junitAttempts++;
        } else if (granularity === 'job') {
          summary.jobAttempts++;
        } else {
          summary.runAttempts++;
        }
      } else {
        summary.duplicates++;
      }
    }
  }

  log?.info(summary, 'pull ingest complete');
  return summary;
}
