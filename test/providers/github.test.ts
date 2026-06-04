import { describe, expect, it, vi } from 'vitest';
import {
  conclusionToOutcome,
  fetchWorkflowRuns,
  type GithubIngestOptions,
  type GithubWorkflowRun,
  mapWorkflowRunsToBodies,
  mapWorkflowRunToBody,
} from '../../src/providers/github.js';

// ---------------------------------------------------------------------------
// Helpers for network-shell tests
// ---------------------------------------------------------------------------

const OPTS: GithubIngestOptions = { owner: 'heracles-jo', repo: 'ci-signal-trust', token: 'tok' };

function mockFetch(
  pages: GithubWorkflowRun[][],
  headers: Record<string, string>[] = [],
): typeof fetch {
  let call = 0;
  return vi.fn(async (_url, _init) => {
    const idx = call++;
    const runs = pages[idx] ?? [];
    const hdrs = headers[idx] ?? {};
    return new Response(JSON.stringify({ workflow_runs: runs }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...hdrs },
    });
  }) as unknown as typeof fetch;
}

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

describe('fetchWorkflowRuns', () => {
  const withinWindow = (daysAgo = 1): string =>
    new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

  const outsideWindow = (): string => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  it('returns runs from a single page', async () => {
    const r = run({ id: 42, created_at: withinWindow() });
    const runs = await fetchWorkflowRuns(OPTS, withinWindow(14), mockFetch([[r]]));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(42);
  });

  it('follows Link header pagination to a second page', async () => {
    const r1 = run({ id: 1, created_at: withinWindow(1) });
    const r2 = run({ id: 2, created_at: withinWindow(2) });
    const link = `<https://api.github.com/repos/x/y/actions/runs?page=2>; rel="next"`;
    const fetchFn = mockFetch([[r1], [r2]], [{ Link: link }]);
    const runs = await fetchWorkflowRuns(OPTS, withinWindow(14), fetchFn);
    expect(runs.map((r) => r.id)).toEqual([1, 2]);
  });

  it('stops early when a run predates the window', async () => {
    const r1 = run({ id: 1, created_at: withinWindow(1) });
    const r2 = run({ id: 2, created_at: outsideWindow() });
    const link = `<https://api.github.com/repos/x/y/actions/runs?page=2>; rel="next"`;
    const fetchFn = mockFetch([[r1, r2]], [{ Link: link }]);
    const runs = await fetchWorkflowRuns(OPTS, withinWindow(14), fetchFn);
    // r2 is outside window → only r1 collected; no second page fetched
    expect(runs.map((r) => r.id)).toEqual([1]);
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('throws on non-200 GitHub response', async () => {
    const fetchFn = vi.fn(async () => new Response('Bad credentials', { status: 401 }));
    await expect(
      fetchWorkflowRuns(OPTS, withinWindow(14), fetchFn as unknown as typeof fetch),
    ).rejects.toThrow('GitHub API 401');
  });

  it('returns empty array when first page is empty', async () => {
    const runs = await fetchWorkflowRuns(OPTS, withinWindow(14), mockFetch([[]]));
    expect(runs).toHaveLength(0);
  });
});
