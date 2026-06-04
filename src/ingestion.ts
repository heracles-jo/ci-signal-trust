import type { Database } from './db/client.js';
import { ciRuns, commits, testResults } from './db/schema.js';
import type { PersistableRun } from './providers/model.js';
import type { CiWebhookBody } from './schemas.js';

export type IngestResult =
  | { status: 'accepted'; runId: string }
  | { status: 'duplicate'; runId: string };

/**
 * Persist one normalized run idempotently. The single write path for every
 * provider (push webhook and GitHub pull both funnel through here).
 *
 *  1. Upsert the commit (onConflictDoNothing).
 *  2. Insert the ci_run with onConflictDoNothing on (provider, external_run_id).
 *     - 0 rows returned -> the run already existed -> duplicate; we look up the
 *       existing run id and DO NOT insert observations again.
 *     - Otherwise insert all observations and return 'accepted'.
 *
 * Wrapped in a transaction so a partial run (run row without its test_results)
 * can never be observed. Idempotent: re-running the same run is a no-op, which is
 * exactly what backfill / daily re-pulls require.
 */
export async function persistRun(db: Database, run: PersistableRun): Promise<IngestResult> {
  return db.transaction(async (tx) => {
    await tx.insert(commits).values({ sha: run.commitSha }).onConflictDoNothing();

    const inserted = await tx
      .insert(ciRuns)
      .values({
        provider: run.provider,
        externalRunId: run.externalRunId,
        commitSha: run.commitSha,
        status: run.status,
        attempt: run.attempt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      })
      .onConflictDoNothing({ target: [ciRuns.provider, ciRuns.externalRunId] })
      .returning({ id: ciRuns.id });

    const newRun = inserted[0];
    if (!newRun) {
      const existing = await tx.query.ciRuns.findFirst({
        columns: { id: true },
        where: (r, { and, eq }) =>
          and(eq(r.provider, run.provider), eq(r.externalRunId, run.externalRunId)),
      });
      return { status: 'duplicate', runId: existing?.id ?? '' };
    }

    if (run.observations.length > 0) {
      await tx.insert(testResults).values(
        run.observations.map((o) => ({
          runId: newRun.id,
          testIdentity: o.identity,
          outcome: o.outcome,
          durationMs: o.durationMs,
        })),
      );
    }

    return { status: 'accepted', runId: newRun.id };
  });
}

/** Map a validated push-webhook payload to the normalized model and persist it. */
export async function ingestWebhook(db: Database, body: CiWebhookBody): Promise<IngestResult> {
  return persistRun(db, {
    provider: body.provider,
    externalRunId: body.externalRunId,
    commitSha: body.commitSha,
    status: body.status,
    attempt: body.attempt ?? 1,
    startedAt: new Date(body.startedAt),
    completedAt: new Date(body.completedAt),
    observations: body.tests.map((t) => ({
      identity: t.identity,
      outcome: t.outcome,
      durationMs: t.durationMs ?? null,
    })),
  });
}
