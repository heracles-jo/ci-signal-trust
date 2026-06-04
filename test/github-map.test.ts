import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  conclusionToOutcome,
  externalRunId,
  GITHUB_PROVIDER,
  mapJobsToObservations,
  mapWorkflowRun,
  mapWorkflowRuns,
} from '../src/providers/github/map.js';
import type {
  GithubJob,
  GithubJobsResponse,
  GithubWorkflowRun,
  GithubWorkflowRunsResponse,
} from '../src/providers/github/types.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const realRuns = JSON.parse(fixture('github-workflow-runs.json')) as GithubWorkflowRunsResponse;
const realJobs = JSON.parse(fixture('github-run-jobs.json')) as GithubJobsResponse;

/** Build a completed-success run; override fields per case. */
function run(overrides: Partial<GithubWorkflowRun> = {}): GithubWorkflowRun {
  return {
    id: 100,
    name: 'CI',
    run_attempt: 1,
    head_sha: 'sha-1',
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-06-04T10:00:00Z',
    created_at: '2026-06-04T09:59:00Z',
    updated_at: '2026-06-04T10:05:00Z',
    ...overrides,
  };
}

describe('conclusionToOutcome', () => {
  it('maps success to passed', () => {
    expect(conclusionToOutcome('success')).toBe('passed');
  });

  it.each(['failure', 'timed_out', 'startup_failure'])('maps %s to failed', (c) => {
    expect(conclusionToOutcome(c)).toBe('failed');
  });

  it.each([
    'cancelled',
    'skipped',
    'neutral',
    'action_required',
    'stale',
    null,
    undefined,
    'weird',
  ])('maps %s to null (no signal)', (c) => {
    expect(conclusionToOutcome(c)).toBeNull();
  });
});

describe('externalRunId', () => {
  it('is unique per (run id, attempt)', () => {
    expect(externalRunId(42, 1)).toBe('42/attempt/1');
    expect(externalRunId(42, 2)).toBe('42/attempt/2');
    expect(externalRunId(42, 1)).not.toBe(externalRunId(42, 2));
  });
});

describe('mapWorkflowRun', () => {
  it('maps a completed success run to an ingestable run-level record', () => {
    const res = mapWorkflowRun(run({ id: 7, run_attempt: 1, head_sha: 'abc' }));
    expect(res.kind).toBe('ingest');
    if (res.kind !== 'ingest') return;
    expect(res.run).toMatchObject({
      provider: GITHUB_PROVIDER,
      externalRunId: '7/attempt/1',
      commitSha: 'abc',
      status: 'passed',
      attempt: 1,
      startedAt: '2026-06-04T10:00:00Z',
      completedAt: '2026-06-04T10:05:00Z',
      workflowName: 'CI',
    });
  });

  it('maps a failed run to status=failed', () => {
    const res = mapWorkflowRun(run({ conclusion: 'failure' }));
    expect(res.kind === 'ingest' && res.run.status).toBe('failed');
  });

  it('skips a run that is not completed', () => {
    const res = mapWorkflowRun(run({ status: 'in_progress', conclusion: null }));
    expect(res.kind).toBe('skip');
    if (res.kind !== 'skip') return;
    expect(res.reason).toContain('not completed');
  });

  it('skips a cancelled run (no pass/fail signal) so it never pollutes the baseline', () => {
    const res = mapWorkflowRun(run({ conclusion: 'cancelled' }));
    expect(res.kind).toBe('skip');
    if (res.kind !== 'skip') return;
    expect(res.reason).toContain('no pass/fail signal');
  });

  it('falls back to created_at when run_started_at is missing', () => {
    const res = mapWorkflowRun(run({ run_started_at: null }));
    expect(res.kind === 'ingest' && res.run.startedAt).toBe('2026-06-04T09:59:00Z');
  });

  it('defaults attempt to 1 when run_attempt is absent', () => {
    const res = mapWorkflowRun(run({ run_attempt: undefined }));
    expect(res.kind === 'ingest' && res.run.attempt).toBe(1);
  });

  it('preserves distinct attempts of the same run as distinct external ids (flake-detectable)', () => {
    const a1 = mapWorkflowRun(run({ id: 9, run_attempt: 1, conclusion: 'failure', head_sha: 's' }));
    const a2 = mapWorkflowRun(run({ id: 9, run_attempt: 2, conclusion: 'success', head_sha: 's' }));
    expect(a1.kind === 'ingest' && a1.run.externalRunId).toBe('9/attempt/1');
    expect(a2.kind === 'ingest' && a2.run.externalRunId).toBe('9/attempt/2');
    // Same SHA, opposite outcomes across attempts -> a downstream same-SHA flake.
    expect(a1.kind === 'ingest' && a1.run.commitSha).toBe(
      a2.kind === 'ingest' ? a2.run.commitSha : 'mismatch',
    );
  });
});

describe('mapWorkflowRuns (real fixture)', () => {
  it('maps every real workflow run in the fixture to an ingestable record', () => {
    expect(realRuns.workflow_runs.length).toBeGreaterThan(0);
    const { runs, skipped } = mapWorkflowRuns(realRuns.workflow_runs);
    // The fixture's runs are all completed successes.
    expect(runs.length).toBe(realRuns.workflow_runs.length);
    expect(skipped.length).toBe(0);
    for (const r of runs) {
      expect(r.provider).toBe(GITHUB_PROVIDER);
      expect(r.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(['passed', 'failed']).toContain(r.status);
    }
  });

  it('partitions a mixed batch into ingestable and skipped', () => {
    const { runs, skipped } = mapWorkflowRuns([
      run({ id: 1, conclusion: 'success' }),
      run({ id: 2, conclusion: 'cancelled' }),
      run({ id: 3, status: 'in_progress', conclusion: null }),
    ]);
    expect(runs.map((r) => r.externalRunId)).toEqual(['1/attempt/1']);
    expect(skipped.map((s) => s.externalRunId)).toEqual(['2/attempt/1', '3/attempt/1']);
  });
});

describe('mapJobsToObservations', () => {
  function job(overrides: Partial<GithubJob> = {}): GithubJob {
    return {
      id: 1,
      run_id: 100,
      run_attempt: 1,
      name: 'ci',
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-06-04T10:00:00Z',
      completed_at: '2026-06-04T10:01:00Z',
      workflow_name: 'CI',
      ...overrides,
    };
  }

  it('maps a real jobs fixture to a job-granularity observation', () => {
    const obs = mapJobsToObservations(realJobs.jobs);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ identity: 'gha-job:CI/ci', outcome: 'passed' });
    expect(obs[0]?.durationMs).toBeGreaterThan(0);
  });

  it('namespaces identity by workflow and job name', () => {
    const obs = mapJobsToObservations([job({ name: 'lint', workflow_name: 'CI' })]);
    expect(obs[0]?.identity).toBe('gha-job:CI/lint');
  });

  it('maps a failed job to outcome=failed', () => {
    const obs = mapJobsToObservations([job({ conclusion: 'failure' })]);
    expect(obs[0]?.outcome).toBe('failed');
  });

  it('drops jobs with no pass/fail conclusion (cancelled/skipped)', () => {
    const obs = mapJobsToObservations([
      job({ id: 1, conclusion: 'success' }),
      job({ id: 2, conclusion: 'cancelled' }),
      job({ id: 3, conclusion: 'skipped' }),
    ]);
    expect(obs).toHaveLength(1);
  });

  it('uses the workflowName fallback when the job omits one', () => {
    const obs = mapJobsToObservations([job({ workflow_name: null })], { workflowName: 'Fallback' });
    expect(obs[0]?.identity).toBe('gha-job:Fallback/ci');
  });

  it('returns null duration when timestamps are missing or inconsistent', () => {
    expect(mapJobsToObservations([job({ started_at: null })])[0]?.durationMs).toBeNull();
    expect(
      mapJobsToObservations([
        job({ started_at: '2026-06-04T10:05:00Z', completed_at: '2026-06-04T10:00:00Z' }),
      ])[0]?.durationMs,
    ).toBeNull();
  });
});
