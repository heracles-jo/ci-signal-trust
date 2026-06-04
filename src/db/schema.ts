import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Postgres schema for CI Signal Trust. Single-tenant v1.
 *
 * Pipeline storage:
 *   commits  <- ci_runs  <- test_results
 *   quarantine is the materialized recommend-only output of the classifier.
 */

export const commits = pgTable('commits', {
  sha: text('sha').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ciRuns = pgTable(
  'ci_runs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    provider: text('provider').notNull(),
    externalRunId: text('external_run_id').notNull(),
    commitSha: text('commit_sha')
      .notNull()
      .references(() => commits.sha),
    status: text('status').notNull(),
    attempt: integer('attempt').notNull().default(1),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency key: a given provider + external run id is ingested once.
    unique('ci_runs_provider_external_run_id_uq').on(t.provider, t.externalRunId),
    check('ci_runs_status_chk', sql`${t.status} in ('passed','failed')`),
    index('ci_runs_commit_sha_idx').on(t.commitSha),
    index('ci_runs_completed_at_idx').on(t.completedAt),
  ],
);

export const testResults = pgTable(
  'test_results',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    runId: uuid('run_id')
      .notNull()
      .references(() => ciRuns.id, { onDelete: 'cascade' }),
    testIdentity: text('test_identity').notNull(),
    outcome: text('outcome').notNull(),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('test_results_outcome_chk', sql`${t.outcome} in ('passed','failed')`),
    index('test_results_test_identity_idx').on(t.testIdentity),
    index('test_results_run_id_idx').on(t.runId),
    // Hot query: per-test observations joined to runs by identity, ordered by time.
    index('test_results_identity_outcome_idx').on(t.testIdentity, t.outcome),
  ],
);

export const quarantine = pgTable(
  'quarantine',
  {
    testIdentity: text('test_identity').primaryKey(),
    status: text('status').notNull().default('recommended'),
    classification: text('classification').notNull(),
    reason: text('reason').notNull(),
    flakyCount: integer('flaky_count').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('quarantine_status_chk', sql`${t.status} in ('recommended','cleared')`)],
);

export type CiRun = typeof ciRuns.$inferSelect;
export type TestResult = typeof testResults.$inferSelect;
export type QuarantineRow = typeof quarantine.$inferSelect;
