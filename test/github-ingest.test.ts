import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../src/db/client.js';
import type { GithubActionsApi } from '../src/providers/github/client.js';
import { pullIngest } from '../src/providers/github/ingest.js';
import type {
  GithubArtifact,
  GithubJob,
  GithubWorkflowRun,
} from '../src/providers/github/types.js';
import { computeFfr } from '../src/reporting.js';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL && !process.env.CI;

/**
 * In-memory fake of the read-only GitHub Actions client. Returns canned payloads
 * so the ingester is exercised against the real DB with zero network — the
 * fixture half of the HER-8 acceptance (the live half runs manually via gh).
 */
class FakeGithubApi implements GithubActionsApi {
  constructor(
    private readonly data: {
      runs: GithubWorkflowRun[];
      attempts?: Record<string, GithubWorkflowRun>; // key: `${runId}:${attempt}`
      jobs?: Record<number, GithubJob[]>; // key: runId (same jobs for all attempts)
      jobsByAttempt?: Record<string, GithubJob[]>; // key: `${runId}:${attempt}`
      artifacts?: Record<number, GithubArtifact[]>; // key: runId
      zips?: Record<number, Uint8Array>; // key: artifactId
    },
  ) {}

  async listWorkflowRuns(): Promise<GithubWorkflowRun[]> {
    return this.data.runs;
  }
  async getRunAttempt(runId: number, attempt: number): Promise<GithubWorkflowRun> {
    const r = this.data.attempts?.[`${runId}:${attempt}`];
    if (!r) throw new Error(`no attempt ${runId}:${attempt}`);
    return r;
  }
  async listJobsForAttempt(runId: number, attempt: number): Promise<GithubJob[]> {
    return this.data.jobsByAttempt?.[`${runId}:${attempt}`] ?? this.data.jobs?.[runId] ?? [];
  }
  async listArtifacts(runId: number): Promise<GithubArtifact[]> {
    return this.data.artifacts?.[runId] ?? [];
  }
  async downloadArtifactZip(artifactId: number): Promise<Uint8Array> {
    const z = this.data.zips?.[artifactId];
    if (!z) throw new Error(`no zip ${artifactId}`);
    return z;
  }
}

function run(o: Partial<GithubWorkflowRun> & { id: number }): GithubWorkflowRun {
  return {
    name: 'CI',
    run_attempt: 1,
    head_sha: 'sha',
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-06-04T10:00:00Z',
    created_at: '2026-06-04T09:59:00Z',
    updated_at: '2026-06-04T10:05:00Z',
    ...o,
  };
}

function job(o: Partial<GithubJob> & { id: number; run_id: number }): GithubJob {
  return {
    run_attempt: 1,
    name: 'ci',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-06-04T10:00:00Z',
    completed_at: '2026-06-04T10:01:00Z',
    workflow_name: 'CI',
    ...o,
  };
}

let dbHandle: DbHandle;

async function counts(): Promise<{ commits: number; runs: number; results: number }> {
  const c = await dbHandle.db.execute<{ n: string }>(sql`select count(*)::text n from commits`);
  const r = await dbHandle.db.execute<{ n: string }>(sql`select count(*)::text n from ci_runs`);
  const t = await dbHandle.db.execute<{ n: string }>(
    sql`select count(*)::text n from test_results`,
  );
  return {
    commits: Number(c.rows[0]?.n),
    runs: Number(r.rows[0]?.n),
    results: Number(t.rows[0]?.n),
  };
}

describe.skipIf(skip)('github pull ingester (real Postgres, fake GitHub client)', () => {
  beforeAll(async () => {
    dbHandle = createDb(DATABASE_URL ?? '');
    await migrate(dbHandle.db, { migrationsFolder: './drizzle' });
  });

  afterAll(async () => {
    if (dbHandle) await dbHandle.pool.end();
  });

  beforeEach(async () => {
    await dbHandle.db.execute(
      sql`truncate table quarantine, test_results, ci_runs, commits restart identity cascade`,
    );
  });

  it('populates commits/ci_runs/test_results from job-granularity payloads (no JUnit)', async () => {
    const api = new FakeGithubApi({
      runs: [run({ id: 1, head_sha: 'aaa', conclusion: 'success' })],
      jobs: { 1: [job({ id: 11, run_id: 1, name: 'ci', conclusion: 'success' })] },
    });
    const summary = await pullIngest(dbHandle.db, api);
    expect(summary.ingested).toBe(1);
    expect(summary.jobAttempts).toBe(1);
    expect(summary.junitAttempts).toBe(0);
    const c = await counts();
    expect(c).toMatchObject({ commits: 1, runs: 1, results: 1 });
  });

  it('prefers JUnit per-test observations when an artifact is present', async () => {
    const xml =
      '<testsuites><testsuite><testcase classname="suite" name="a"/><testcase classname="suite" name="b"><failure/></testcase></testsuite></testsuites>';
    const api = new FakeGithubApi({
      runs: [run({ id: 2, head_sha: 'bbb' })],
      jobs: { 2: [job({ id: 21, run_id: 2 })] },
      artifacts: { 2: [{ id: 99, name: 'junit-report' }] },
      zips: { 99: zipSync({ 'junit.xml': new TextEncoder().encode(xml) }) },
    });
    const summary = await pullIngest(dbHandle.db, api);
    expect(summary.junitAttempts).toBe(1);
    expect(summary.jobAttempts).toBe(0);
    // Two per-test rows from JUnit, NOT one job-granularity row.
    const c = await counts();
    expect(c.results).toBe(2);
    const ids = await dbHandle.db.execute<{ id: string }>(
      sql`select test_identity id from test_results order by test_identity`,
    );
    expect(ids.rows.map((x) => x.id)).toEqual(['suite a', 'suite b']);
  });

  it('captures re-run attempts as distinct runs and detects a same-SHA flake (run-level)', async () => {
    // Run 3, SHA "ccc": attempt 1 failed, attempt 2 (latest) passed. No JUnit, no
    // jobs -> falls back to run-level observations on the same SHA -> flake.
    const api = new FakeGithubApi({
      runs: [run({ id: 3, head_sha: 'ccc', run_attempt: 2, conclusion: 'success' })],
      attempts: {
        '3:1': run({
          id: 3,
          head_sha: 'ccc',
          run_attempt: 1,
          conclusion: 'failure',
          updated_at: '2026-06-04T10:02:00Z',
        }),
      },
    });
    const summary = await pullIngest(dbHandle.db, api);
    expect(summary.attemptsConsidered).toBe(2);
    expect(summary.ingested).toBe(2);
    expect(summary.runAttempts).toBe(2);
    const c = await counts();
    expect(c.runs).toBe(2); // two attempts -> two ci_runs, same commit
    expect(c.commits).toBe(1);

    // The workflow failed-then-passed on identical SHA across attempts -> flake.
    const report = await computeFfr(dbHandle.db, 3650);
    const flake = report.quarantine.find((q) => q.testIdentity === 'gha-run:CI');
    expect(flake).toBeDefined();
    expect(flake?.classification).toBe('flake');
  });

  it('detects a same-SHA flake at job granularity across attempts', async () => {
    // Same SHA, attempt-1 job failed, attempt-2 job passed -> job-level flake.
    const api = new FakeGithubApi({
      runs: [run({ id: 7, head_sha: 'eee', run_attempt: 2, conclusion: 'success' })],
      attempts: {
        '7:1': run({ id: 7, head_sha: 'eee', run_attempt: 1, conclusion: 'failure' }),
      },
      jobsByAttempt: {
        '7:1': [job({ id: 71, run_id: 7, run_attempt: 1, name: 'ci', conclusion: 'failure' })],
        '7:2': [job({ id: 72, run_id: 7, run_attempt: 2, name: 'ci', conclusion: 'success' })],
      },
    });
    const summary = await pullIngest(dbHandle.db, api);
    expect(summary.jobAttempts).toBe(2);
    const report = await computeFfr(dbHandle.db, 3650);
    const flake = report.quarantine.find((q) => q.testIdentity === 'gha-job:CI/ci');
    expect(flake?.classification).toBe('flake');
  });

  it('skips non-terminal and cancelled runs without writing rows', async () => {
    const api = new FakeGithubApi({
      runs: [
        run({ id: 4, conclusion: 'cancelled' }),
        run({ id: 5, status: 'in_progress', conclusion: null }),
      ],
    });
    const summary = await pullIngest(dbHandle.db, api);
    expect(summary.skipped).toBe(2);
    expect(summary.ingested).toBe(0);
    expect(await counts()).toMatchObject({ runs: 0, results: 0 });
  });

  it('is idempotent: re-pulling the same data inserts nothing new', async () => {
    const api = new FakeGithubApi({
      runs: [run({ id: 6, head_sha: 'ddd' })],
      jobs: { 6: [job({ id: 61, run_id: 6 })] },
    });
    const first = await pullIngest(dbHandle.db, api);
    expect(first.ingested).toBe(1);
    const before = await counts();

    const second = await pullIngest(dbHandle.db, api);
    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(await counts()).toEqual(before); // no duplicate rows
  });
});
