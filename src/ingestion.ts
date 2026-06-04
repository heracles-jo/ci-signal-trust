import type { Database } from './db/client.js';
import { ciRuns, commits, testResults } from './db/schema.js';
import type { CiWebhookBody } from './schemas.js';

export type IngestResult =
  | { status: 'accepted'; runId: string }
  | { status: 'duplicate'; runId: string };

/**
 * Persist a validated webhook payload idempotently.
 *
 *  1. Upsert the commit (onConflictDoNothing).
 *  2. Insert the ci_run with onConflictDoNothing on (provider, external_run_id).
 *     - If 0 rows returned, the run already existed -> duplicate; we look up the
 *       existing run id and DO NOT insert test_results again.
 *     - Otherwise insert all test_results and return 'accepted'.
 *
 * Wrapped in a transaction so a partial run (run row without its test_results)
 * can never be observed.
 */
export async function ingestWebhook(db: Database, body: CiWebhookBody): Promise<IngestResult> {
  return db.transaction(async (tx) => {
    await tx.insert(commits).values({ sha: body.commitSha }).onConflictDoNothing();

    const inserted = await tx
      .insert(ciRuns)
      .values({
        provider: body.provider,
        externalRunId: body.externalRunId,
        commitSha: body.commitSha,
        status: body.status,
        attempt: body.attempt ?? 1,
        startedAt: new Date(body.startedAt),
        completedAt: new Date(body.completedAt),
      })
      .onConflictDoNothing({ target: [ciRuns.provider, ciRuns.externalRunId] })
      .returning({ id: ciRuns.id });

    const newRun = inserted[0];
    if (!newRun) {
      // Conflict: the run already exists. Look up its id; idempotent no-op.
      const existing = await tx.query.ciRuns.findFirst({
        columns: { id: true },
        where: (run, { and, eq }) =>
          and(eq(run.provider, body.provider), eq(run.externalRunId, body.externalRunId)),
      });
      return { status: 'duplicate', runId: existing?.id ?? '' };
    }

    if (body.tests.length > 0) {
      await tx.insert(testResults).values(
        body.tests.map((t) => ({
          runId: newRun.id,
          testIdentity: t.identity,
          outcome: t.outcome,
          durationMs: t.durationMs ?? null,
        })),
      );
    }

    return { status: 'accepted', runId: newRun.id };
  });
}
