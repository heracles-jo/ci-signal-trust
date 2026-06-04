import { describe, expect, it } from 'vitest';
import {
  conclusionToOutcome,
  type GithubWorkflowRun,
  mapWorkflowRunsToBodies,
  mapWorkflowRunToBody,
} from '../../src/providers/github.js';

const run = (overrides: Partial<GithubWorkflowRun> = {}): GithubWorkflowRun => ({
  id: 100,
  name: 'ci',
  head_sha: 'abc123',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  run_started_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:03:00Z',
  ...overrides,
});

describe('conclusionToOutcome', () => {
  it('maps success to passed', () => {
    expect(conclusionToOutcome('success')).toBe('passed');
  });

  it('maps hard failures to failed', () => {
    expect(conclusionToOutcome('failure')).toBe('failed');
    expect(conclusionToOutcome('timed_out')).toBe('failed');
    expect(conclusionToOutcome('startup_failure')).toBe('failed');
  });

  it('drops untrustworthy signals as null', () => {
    for (const c of [
      'cancelled',
      'skipped',
      'neutral',
      'action_required',
      'stale',
      null,
      undefined,
    ]) {
      expect(conclusionToOutcome(c)).toBeNull();
    }
  });
});

describe('mapWorkflowRunToBody', () => {
  it('maps a completed successful run', () => {
    const body = mapWorkflowRunToBody(run());
    expect(body).toEqual({
      provider: 'github',
      externalRunId: '100#1',
      commitSha: 'abc123',
      status: 'passed',
      attempt: 1,
      startedAt: '2026-06-01T00:00:00Z',
      completedAt: '2026-06-01T00:03:00Z',
      tests: [{ identity: 'workflow:ci', outcome: 'passed' }],
    });
  });

  it('embeds the attempt in externalRunId so re-runs are distinct rows on the same SHA', () => {
    const first = mapWorkflowRunToBody(run({ conclusion: 'failure', run_attempt: 1 }));
    const retry = mapWorkflowRunToBody(run({ conclusion: 'success', run_attempt: 2 }));
    expect(first?.externalRunId).toBe('100#1');
    expect(retry?.externalRunId).toBe('100#2');
    expect(first?.commitSha).toBe(retry?.commitSha);
    expect(first?.status).toBe('failed');
    expect(retry?.status).toBe('passed');
  });

  it('skips runs that are not completed', () => {
    expect(mapWorkflowRunToBody(run({ status: 'in_progress', conclusion: null }))).toBeNull();
  });

  it('skips runs with an untrustworthy conclusion', () => {
    expect(mapWorkflowRunToBody(run({ conclusion: 'cancelled' }))).toBeNull();
  });

  it('falls back through started/created/updated timestamps', () => {
    const body = mapWorkflowRunToBody(
      run({ run_started_at: null, created_at: '2026-06-01T00:00:30Z' }),
    );
    expect(body?.startedAt).toBe('2026-06-01T00:00:30Z');
  });

  it('defaults a missing/zero attempt to 1', () => {
    expect(mapWorkflowRunToBody(run({ run_attempt: null }))?.attempt).toBe(1);
    expect(mapWorkflowRunToBody(run({ run_attempt: 0 }))?.attempt).toBe(1);
  });

  it('defaults a blank workflow name', () => {
    expect(mapWorkflowRunToBody(run({ name: '   ' }))?.tests[0]?.identity).toBe(
      'workflow:workflow',
    );
  });
});

describe('mapWorkflowRunsToBodies', () => {
  it('maps the good runs and drops the rest', () => {
    const bodies = mapWorkflowRunsToBodies([
      run({ id: 1, conclusion: 'success' }),
      run({ id: 2, conclusion: 'cancelled' }),
      run({ id: 3, conclusion: 'failure' }),
      run({ id: 4, status: 'queued', conclusion: null }),
    ]);
    expect(bodies.map((b) => b.externalRunId)).toEqual(['1#1', '3#1']);
  });
});
