import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../src/db/client.js';
import { ciRuns, commits, testResults } from '../src/db/schema.js';
import {
  actionQuarantine,
  applyRecommendation,
  buildQuarantineManifest,
  clearRecommendation,
  confirmQuarantine,
  getAuditTrail,
  listQuarantine,
  QuarantineTransitionError,
  rejectQuarantine,
} from '../src/quarantine.js';
import { recomputeQuarantine } from '../src/reporting.js';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL && !process.env.CI;

/** Seed a classifier recommendation the way the recompute path does. */
async function seedRecommended(handle: DbHandle, testIdentity: string): Promise<void> {
  await applyRecommendation(handle.db, {
    testIdentity,
    classification: 'flake',
    reason: 'same-SHA fail-then-pass',
    flakyCount: 1,
  });
}

describe.skipIf(skip)('quarantine confirmation loop (HER-12)', () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL ?? '');
    await migrate(handle.db, { migrationsFolder: './drizzle' });
  });

  afterAll(async () => {
    if (handle) {
      await handle.pool.end();
    }
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql`truncate table quarantine_audit, quarantine, test_results, ci_runs, commits restart identity cascade`,
    );
  });

  it('recommend -> confirm -> action puts the test in the manifest with a full audit trail', async () => {
    const t = 'integration.PaymentGatewaySpec#chargesCard';
    await seedRecommended(handle, t);

    // Recommended-only: NOT yet in the manifest (no mutation without sign-off).
    expect(await buildQuarantineManifest(handle.db)).toHaveLength(0);

    const confirmed = await confirmQuarantine(handle.db, t, {
      actor: 'cto@heracles',
      actorType: 'human',
      note: 'verified same-SHA flake from run 123',
    });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedBy).toBe('cto@heracles');
    // Confirmed but not actioned: still NOT in the manifest.
    expect(await buildQuarantineManifest(handle.db)).toHaveLength(0);

    const actioned = await actionQuarantine(handle.db, t, { actor: 'cto@heracles' });
    expect(actioned.status).toBe('actioned');
    expect(actioned.actionedBy).toBe('cto@heracles');

    const manifest = await buildQuarantineManifest(handle.db);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]?.testIdentity).toBe(t);
    expect(manifest[0]?.confirmedBy).toBe('cto@heracles');

    const trail = await getAuditTrail(handle.db, t);
    expect(trail.map((a) => `${a.fromStatus ?? '∅'}->${a.toStatus}`)).toEqual([
      '∅->recommended',
      'recommended->confirmed',
      'confirmed->actioned',
    ]);
    expect(trail[1]?.actor).toBe('cto@heracles');
    expect(trail[1]?.actorType).toBe('human');
  });

  it('REFUSES to action a test that was never confirmed (zero unconfirmed mutations)', async () => {
    const t = 'unit.CacheSpec#evictsOnTtl';
    await seedRecommended(handle, t);

    await expect(actionQuarantine(handle.db, t, { actor: 'someone' })).rejects.toBeInstanceOf(
      QuarantineTransitionError,
    );

    // Nothing leaked into the manifest, and no spurious audit row was written.
    expect(await buildQuarantineManifest(handle.db)).toHaveLength(0);
    const trail = await getAuditTrail(handle.db, t);
    expect(trail.map((a) => a.toStatus)).toEqual(['recommended']);
  });

  it('REFUSES to action or confirm a test that does not exist', async () => {
    await expect(actionQuarantine(handle.db, 'ghost', { actor: 'x' })).rejects.toBeInstanceOf(
      QuarantineTransitionError,
    );
    await expect(confirmQuarantine(handle.db, 'ghost', { actor: 'x' })).rejects.toBeInstanceOf(
      QuarantineTransitionError,
    );
  });

  it('a rejected recommendation cannot be confirmed or actioned and never reaches the manifest', async () => {
    const t = 'integration.SearchSpec#ranksResults';
    await seedRecommended(handle, t);

    const rejected = await rejectQuarantine(handle.db, t, { actor: 'reviewer', note: 'real bug' });
    expect(rejected.status).toBe('rejected');

    await expect(confirmQuarantine(handle.db, t, { actor: 'x' })).rejects.toBeInstanceOf(
      QuarantineTransitionError,
    );
    await expect(actionQuarantine(handle.db, t, { actor: 'x' })).rejects.toBeInstanceOf(
      QuarantineTransitionError,
    );
    expect(await buildQuarantineManifest(handle.db)).toHaveLength(0);
  });

  it('confirm and action are idempotent and do not write duplicate audit rows', async () => {
    const t = 'integration.QueueSpec#drainsBacklog';
    await seedRecommended(handle, t);
    await confirmQuarantine(handle.db, t, { actor: 'a' });
    await confirmQuarantine(handle.db, t, { actor: 'a' }); // no-op
    await actionQuarantine(handle.db, t, { actor: 'a' });
    await actionQuarantine(handle.db, t, { actor: 'a' }); // no-op

    const trail = await getAuditTrail(handle.db, t);
    expect(trail.map((a) => a.toStatus)).toEqual(['recommended', 'confirmed', 'actioned']);
  });

  it('a background recompute never overrides a human-owned (actioned) row', async () => {
    const t = 'integration.SessionSpec#expiresIdleSession';
    const sha = 'b2e4d70';
    // Seed a same-SHA flake (fail then pass on identical code) so the classifier
    // would, on its own, recommend it.
    await handle.db.insert(commits).values({ sha });
    const runs = await handle.db
      .insert(ciRuns)
      .values([
        {
          provider: 'github',
          externalRunId: 'r1',
          commitSha: sha,
          status: 'failed',
          attempt: 1,
          completedAt: new Date('2026-05-03T09:00:00Z'),
        },
        {
          provider: 'github',
          externalRunId: 'r2',
          commitSha: sha,
          status: 'passed',
          attempt: 1,
          completedAt: new Date('2026-05-03T11:30:00Z'),
        },
      ])
      .returning();
    const [run1, run2] = runs;
    if (!run1 || !run2) {
      throw new Error('expected two inserted runs');
    }
    await handle.db.insert(testResults).values([
      { runId: run1.id, testIdentity: t, outcome: 'failed' },
      { runId: run2.id, testIdentity: t, outcome: 'passed' },
    ]);

    // Recompute -> recommended, then a human confirms and actions it.
    await recomputeQuarantine(handle.db, 3650);
    await confirmQuarantine(handle.db, t, { actor: 'cto', actorType: 'board' });
    await actionQuarantine(handle.db, t, { actor: 'cto' });
    expect(await buildQuarantineManifest(handle.db)).toHaveLength(1);

    // Now the test stops being flaky (a later passing-only history). A recompute
    // must NOT silently un-action the human-applied quarantine.
    await recomputeQuarantine(handle.db, 3650);
    const rows = await listQuarantine(handle.db, 'actioned');
    expect(rows.map((r) => r.testIdentity)).toContain(t);
    expect(await buildQuarantineManifest(handle.db)).toHaveLength(1);
  });

  it('clearRecommendation withdraws a recommendation but leaves human-owned rows alone', async () => {
    const recommended = 'unit.A#one';
    const actionedTest = 'unit.B#two';
    await seedRecommended(handle, recommended);
    await seedRecommended(handle, actionedTest);
    await confirmQuarantine(handle.db, actionedTest, { actor: 'a' });
    await actionQuarantine(handle.db, actionedTest, { actor: 'a' });

    await clearRecommendation(handle.db, recommended, 'no longer flaky');
    await clearRecommendation(handle.db, actionedTest, 'no longer flaky'); // must be a no-op

    const cleared = await listQuarantine(handle.db, 'cleared');
    expect(cleared.map((r) => r.testIdentity)).toEqual([recommended]);
    const actioned = await listQuarantine(handle.db, 'actioned');
    expect(actioned.map((r) => r.testIdentity)).toEqual([actionedTest]);
  });

  it('manifest contains only actioned rows, never recommended or confirmed', async () => {
    await seedRecommended(handle, 'rec.only');
    await seedRecommended(handle, 'conf.only');
    await confirmQuarantine(handle.db, 'conf.only', { actor: 'a' });
    await seedRecommended(handle, 'act.one');
    await confirmQuarantine(handle.db, 'act.one', { actor: 'a' });
    await actionQuarantine(handle.db, 'act.one', { actor: 'a' });

    const manifest = await buildQuarantineManifest(handle.db);
    expect(manifest.map((m) => m.testIdentity)).toEqual(['act.one']);
  });
});
