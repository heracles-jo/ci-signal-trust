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
    // Human/board disposition (HER-12). Populated only when a sign-off is
    // recorded; NULL while a row is merely `recommended` by the classifier.
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: text('confirmed_by'),
    actionedAt: timestamp('actioned_at', { withTimezone: true }),
    actionedBy: text('actioned_by'),
  },
  (t) => [
    check(
      'quarantine_status_chk',
      // recommended -> confirmed -> actioned is the sign-off path; rejected is a
      // declined recommendation; cleared is a withdrawn/superseded recommendation.
      sql`${t.status} in ('recommended','confirmed','actioned','rejected','cleared')`,
    ),
  ],
);

/**
 * Append-only audit trail for every quarantine state transition (HER-12). Each
 * row records who moved a test from one status to another and why. Nothing in
 * the codebase updates or deletes these rows — the trail is the durable evidence
 * that no test was ever actioned (mutated) without an explicit recorded sign-off.
 */
export const quarantineAudit = pgTable(
  'quarantine_audit',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    testIdentity: text('test_identity').notNull(),
    /** NULL when the row is first created (no prior status). */
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    /** 'system' for classifier-driven transitions, 'human'/'board' for sign-offs. */
    actorType: text('actor_type').notNull(),
    /** Identity of the actor: a username, board id, or the literal 'classifier'. */
    actor: text('actor').notNull(),
    note: text('note').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('quarantine_audit_actor_type_chk', sql`${t.actorType} in ('system','human','board')`),
    index('quarantine_audit_test_identity_idx').on(t.testIdentity),
    index('quarantine_audit_created_at_idx').on(t.createdAt),
  ],
);

export type CiRun = typeof ciRuns.$inferSelect;
export type TestResult = typeof testResults.$inferSelect;
export type QuarantineRow = typeof quarantine.$inferSelect;
export type QuarantineAuditRow = typeof quarantineAudit.$inferSelect;
