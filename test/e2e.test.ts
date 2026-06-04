import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { hmacSha256Hex } from '../src/security.js';

const DATABASE_URL = process.env.DATABASE_URL;
const INGEST_SIGNING_SECRET = 'test-signing-secret';
const READ_API_TOKEN = 'test-read-token';

const config: AppConfig = {
  databaseUrl: DATABASE_URL ?? '',
  ingestSigningSecret: INGEST_SIGNING_SECRET,
  readApiToken: READ_API_TOKEN,
  port: 0,
  ffrWindowDays: 14,
};

let dbHandle: DbHandle;
let app: FastifyInstance;

/** Wait for Postgres to accept connections (docker compose may still be warming up). */
async function waitForDb(handle: DbHandle, attempts = 30): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await handle.db.execute(sql`select 1`);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Postgres not reachable after ${attempts} attempts: ${String(lastErr)}`);
}

function signedRequest(body: unknown): { payload: string; headers: Record<string, string> } {
  const payload = JSON.stringify(body);
  const signature = hmacSha256Hex(INGEST_SIGNING_SECRET, payload);
  return {
    payload,
    headers: {
      'content-type': 'application/json',
      'x-signature-256': `sha256=${signature}`,
    },
  };
}

// Skip only locally when no DB is configured. In CI we never skip: a missing
// DATABASE_URL must fail loudly in beforeAll rather than silently pass green.
const skip = !DATABASE_URL && !process.env.CI;

describe.skipIf(skip)('e2e: webhook -> store -> classify -> FFR + quarantine', () => {
  beforeAll(async () => {
    dbHandle = createDb(config.databaseUrl);
    await waitForDb(dbHandle);
    await migrate(dbHandle.db, { migrationsFolder: './drizzle' });
    // Clean slate.
    await dbHandle.db.execute(
      sql`truncate table quarantine, test_results, ci_runs, commits restart identity cascade`,
    );
    app = buildApp({ config, dbHandle });
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (dbHandle) {
      await dbHandle.pool.end();
    }
  });

  it('(a) accepts a signed flaky scenario with 202', async () => {
    // Same test fails then passes on the SAME sha across two runs -> same-SHA flake.
    const completedAt = new Date().toISOString();
    const run1 = signedRequest({
      provider: 'github',
      externalRunId: 'run-1',
      commitSha: 'sha-flaky',
      status: 'failed',
      attempt: 1,
      startedAt: completedAt,
      completedAt,
      tests: [{ identity: 'suite.flakyTest', outcome: 'failed', durationMs: 120 }],
    });
    const res1 = await app.inject({
      method: 'POST',
      url: '/webhooks/ci',
      headers: run1.headers,
      payload: run1.payload,
    });
    expect(res1.statusCode).toBe(202);
    expect(res1.json()).toMatchObject({ status: 'accepted' });

    const completedAt2 = new Date().toISOString();
    const run2 = signedRequest({
      provider: 'github',
      externalRunId: 'run-2',
      commitSha: 'sha-flaky',
      status: 'passed',
      attempt: 2,
      startedAt: completedAt2,
      completedAt: completedAt2,
      tests: [{ identity: 'suite.flakyTest', outcome: 'passed', durationMs: 95 }],
    });
    const res2 = await app.inject({
      method: 'POST',
      url: '/webhooks/ci',
      headers: run2.headers,
      payload: run2.payload,
    });
    expect(res2.statusCode).toBe(202);

    // Also ingest a genuinely broken test (only failures) to exercise non-flake path.
    const completedAt3 = new Date().toISOString();
    const run3 = signedRequest({
      provider: 'github',
      externalRunId: 'run-3',
      commitSha: 'sha-broken',
      status: 'failed',
      startedAt: completedAt3,
      completedAt: completedAt3,
      tests: [{ identity: 'suite.brokenTest', outcome: 'failed' }],
    });
    const res3 = await app.inject({
      method: 'POST',
      url: '/webhooks/ci',
      headers: run3.headers,
      payload: run3.payload,
    });
    expect(res3.statusCode).toBe(202);
  });

  it('(b) rejects a bad signature with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/ci',
      headers: {
        'content-type': 'application/json',
        'x-signature-256': 'sha256=deadbeef',
      },
      payload: JSON.stringify({
        provider: 'github',
        externalRunId: 'run-x',
        commitSha: 'sha-x',
        status: 'failed',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        tests: [],
      }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('(b2) rejects an invalid payload with 400 (signature valid)', async () => {
    const bad = signedRequest({ provider: 'github' }); // missing required fields
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/ci',
      headers: bad.headers,
      payload: bad.payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it('(c) treats a duplicate provider+externalRunId as 200 duplicate', async () => {
    const completedAt = new Date().toISOString();
    const dup = signedRequest({
      provider: 'github',
      externalRunId: 'run-1', // same as (a)
      commitSha: 'sha-flaky',
      status: 'failed',
      startedAt: completedAt,
      completedAt,
      tests: [{ identity: 'suite.flakyTest', outcome: 'failed' }],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/ci',
      headers: dup.headers,
      payload: dup.payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'duplicate' });

    // The duplicate must NOT have inserted extra test_results: still exactly the
    // 2 flaky observations + 1 broken = 3 total in the DB.
    const countRows = await dbHandle.db.execute<{ count: string }>(
      sql`select count(*)::text as count from test_results`,
    );
    expect(Number(countRows.rows[0]?.count)).toBe(3);
  });

  it('(d) reports the flaky test in quarantine with FFR > 0 via bearer auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reports/ffr?windowDays=14',
      headers: { authorization: `Bearer ${READ_API_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json() as {
      ffr: number;
      totalFailures: number;
      flakyFailures: number;
      reclaimedHoursEstimate: number;
      quarantine: Array<{ testIdentity: string; classification: string }>;
    };
    expect(report.ffr).toBeGreaterThan(0);
    expect(report.totalFailures).toBeGreaterThanOrEqual(2);
    expect(report.flakyFailures).toBeGreaterThanOrEqual(1);
    expect(report.reclaimedHoursEstimate).toBeGreaterThan(0);

    const flaky = report.quarantine.find((q) => q.testIdentity === 'suite.flakyTest');
    expect(flaky).toBeDefined();
    expect(flaky?.classification).toBe('flake');

    // The genuinely broken test must NOT be quarantined.
    const broken = report.quarantine.find((q) => q.testIdentity === 'suite.brokenTest');
    expect(broken).toBeUndefined();
  });

  it('(d2) rejects /reports/ffr without a valid bearer token (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reports/ffr',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('(e) GET /readyz returns 200 when DB is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready' });
  });

  it('GET /healthz returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});
