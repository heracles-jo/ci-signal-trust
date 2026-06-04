/**
 * Quarantine confirmation loop (HER-12): recommend -> sign-off -> action.
 *
 * SAFETY CONTRACT (non-negotiable for v1):
 *   A quarantine is only ever *applied* (the test removed from CI enforcement)
 *   when it has been explicitly signed off by a human/board. The single mutation
 *   surface is the quarantine MANIFEST (`buildQuarantineManifest`), and a test
 *   can enter the manifest ONLY when its status is `actioned`. `actioned` is
 *   reachable ONLY from `confirmed`, and `confirmed` is reachable ONLY from a
 *   classifier `recommended` row via a recorded sign-off. Every transition is
 *   written to the append-only `quarantine_audit` trail.
 *
 * Ownership split:
 *   - classifier-owned states: `recommended`, `cleared` (and absent). The
 *     recompute path (src/reporting.ts) manages these via applyRecommendation /
 *     clearRecommendation.
 *   - human-owned states: `confirmed`, `actioned`, `rejected`. Once a human has
 *     disposed of a recommendation, the classifier never overwrites that
 *     decision; only the confirmation loop here moves it further.
 *
 * Every function in this module is DB-backed but otherwise pure of process
 * state, so it is exercised directly by integration tests.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { Database } from './db/client.js';
import {
  type QuarantineAuditRow,
  type QuarantineRow,
  quarantine,
  quarantineAudit,
} from './db/schema.js';

export type QuarantineStatus = 'recommended' | 'confirmed' | 'actioned' | 'rejected' | 'cleared';
export type ActorType = 'system' | 'human' | 'board';

/** States a human has disposed of; the classifier must never overwrite these. */
const HUMAN_OWNED: ReadonlySet<QuarantineStatus> = new Set(['confirmed', 'actioned', 'rejected']);

/**
 * Thrown when a requested transition is not legal from the current state. The
 * message names the test, the current status, and the attempted action so the
 * audit story is self-explanatory.
 */
export class QuarantineTransitionError extends Error {
  constructor(
    readonly testIdentity: string,
    readonly currentStatus: QuarantineStatus | 'absent',
    readonly attempted: string,
  ) {
    super(
      `Cannot ${attempted} "${testIdentity}": current status is "${currentStatus}". ` +
        `${attempted} is not a legal transition from "${currentStatus}".`,
    );
    this.name = 'QuarantineTransitionError';
  }
}

export type SignOff = {
  /** Who signed off: a username, a board id, etc. Required for the audit trail. */
  actor: string;
  /** Whether the sign-off came from an individual operator or the board. */
  actorType?: Extract<ActorType, 'human' | 'board'>;
  /** Free-text justification, recorded verbatim in the audit trail. */
  note?: string;
};

async function getRow(db: Database, testIdentity: string): Promise<QuarantineRow | undefined> {
  const rows = await db.select().from(quarantine).where(eq(quarantine.testIdentity, testIdentity));
  return rows[0];
}

async function recordAudit(
  db: Database,
  entry: {
    testIdentity: string;
    fromStatus: QuarantineStatus | null;
    toStatus: QuarantineStatus;
    actorType: ActorType;
    actor: string;
    note: string;
  },
): Promise<void> {
  // Append-only: we INSERT and never UPDATE/DELETE audit rows anywhere.
  await db.insert(quarantineAudit).values({
    testIdentity: entry.testIdentity,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    actorType: entry.actorType,
    actor: entry.actor,
    note: entry.note,
  });
}

/**
 * Upsert a classifier recommendation. Only touches classifier-owned rows
 * (absent/recommended/cleared); a human-owned row is left untouched so a human
 * decision is never overwritten by a recompute. Audits the cleared->recommended
 * or fresh-recommendation transition; refreshing an existing recommendation's
 * reason/count is not a state change and is not re-audited.
 */
export async function applyRecommendation(
  db: Database,
  input: { testIdentity: string; classification: string; reason: string; flakyCount: number },
): Promise<void> {
  const existing = await getRow(db, input.testIdentity);
  if (existing && HUMAN_OWNED.has(existing.status as QuarantineStatus)) {
    return;
  }
  const now = new Date();
  await db
    .insert(quarantine)
    .values({
      testIdentity: input.testIdentity,
      status: 'recommended',
      classification: input.classification,
      reason: input.reason,
      flakyCount: input.flakyCount,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: quarantine.testIdentity,
      set: {
        status: 'recommended',
        classification: input.classification,
        reason: input.reason,
        flakyCount: input.flakyCount,
        updatedAt: now,
      },
    });
  if (!existing || existing.status === 'cleared') {
    await recordAudit(db, {
      testIdentity: input.testIdentity,
      fromStatus: (existing?.status as QuarantineStatus) ?? null,
      toStatus: 'recommended',
      actorType: 'system',
      actor: 'classifier',
      note: input.reason,
    });
  }
}

/**
 * Withdraw a recommendation (e.g. the test is no longer flake, or the gate
 * suppressed it). Only clears a currently `recommended` row; human-owned rows
 * are never auto-cleared. Audits the recommended->cleared transition.
 */
export async function clearRecommendation(
  db: Database,
  testIdentity: string,
  reason: string,
): Promise<void> {
  const existing = await getRow(db, testIdentity);
  if (existing?.status !== 'recommended') {
    return;
  }
  await db
    .update(quarantine)
    .set({ status: 'cleared', reason, updatedAt: new Date() })
    .where(and(eq(quarantine.testIdentity, testIdentity), eq(quarantine.status, 'recommended')));
  await recordAudit(db, {
    testIdentity,
    fromStatus: 'recommended',
    toStatus: 'cleared',
    actorType: 'system',
    actor: 'classifier',
    note: reason,
  });
}

/**
 * Sign off on a recommendation: `recommended` -> `confirmed`. This authorizes a
 * later `action` but performs NO mutation itself. Idempotent: confirming an
 * already-confirmed row is a no-op. Any other source status is illegal.
 */
export async function confirmQuarantine(
  db: Database,
  testIdentity: string,
  signOff: SignOff,
): Promise<QuarantineRow> {
  const existing = await getRow(db, testIdentity);
  if (!existing) {
    throw new QuarantineTransitionError(testIdentity, 'absent', 'confirm');
  }
  if (existing.status === 'confirmed') {
    return existing;
  }
  if (existing.status !== 'recommended') {
    throw new QuarantineTransitionError(
      testIdentity,
      existing.status as QuarantineStatus,
      'confirm',
    );
  }
  const actorType: ActorType = signOff.actorType ?? 'human';
  const now = new Date();
  const updated = await db
    .update(quarantine)
    .set({ status: 'confirmed', confirmedAt: now, confirmedBy: signOff.actor, updatedAt: now })
    .where(and(eq(quarantine.testIdentity, testIdentity), eq(quarantine.status, 'recommended')))
    .returning();
  await recordAudit(db, {
    testIdentity,
    fromStatus: 'recommended',
    toStatus: 'confirmed',
    actorType,
    actor: signOff.actor,
    note: signOff.note ?? 'signed off',
  });
  return updated[0] as QuarantineRow;
}

/**
 * Decline a recommendation: `recommended` -> `rejected`. A rejected row is
 * human-owned and sticky — the classifier will not re-recommend it.
 */
export async function rejectQuarantine(
  db: Database,
  testIdentity: string,
  signOff: SignOff,
): Promise<QuarantineRow> {
  const existing = await getRow(db, testIdentity);
  if (!existing) {
    throw new QuarantineTransitionError(testIdentity, 'absent', 'reject');
  }
  if (existing.status === 'rejected') {
    return existing;
  }
  if (existing.status !== 'recommended') {
    throw new QuarantineTransitionError(
      testIdentity,
      existing.status as QuarantineStatus,
      'reject',
    );
  }
  const actorType: ActorType = signOff.actorType ?? 'human';
  const now = new Date();
  const updated = await db
    .update(quarantine)
    .set({ status: 'rejected', updatedAt: now })
    .where(and(eq(quarantine.testIdentity, testIdentity), eq(quarantine.status, 'recommended')))
    .returning();
  await recordAudit(db, {
    testIdentity,
    fromStatus: 'recommended',
    toStatus: 'rejected',
    actorType,
    actor: signOff.actor,
    note: signOff.note ?? 'rejected',
  });
  return updated[0] as QuarantineRow;
}

/**
 * Apply a confirmed quarantine: `confirmed` -> `actioned`. THIS is the mutation
 * — only after this does the test appear in the manifest CI consumes. It is
 * structurally impossible to action a test that was not first `confirmed`:
 * any non-`confirmed` source status throws. Idempotent for already-`actioned`.
 */
export async function actionQuarantine(
  db: Database,
  testIdentity: string,
  actor: { actor: string; actorType?: ActorType; note?: string },
): Promise<QuarantineRow> {
  const existing = await getRow(db, testIdentity);
  if (!existing) {
    throw new QuarantineTransitionError(testIdentity, 'absent', 'action');
  }
  if (existing.status === 'actioned') {
    return existing;
  }
  if (existing.status !== 'confirmed') {
    throw new QuarantineTransitionError(
      testIdentity,
      existing.status as QuarantineStatus,
      'action',
    );
  }
  const now = new Date();
  const updated = await db
    .update(quarantine)
    .set({ status: 'actioned', actionedAt: now, actionedBy: actor.actor, updatedAt: now })
    .where(and(eq(quarantine.testIdentity, testIdentity), eq(quarantine.status, 'confirmed')))
    .returning();
  await recordAudit(db, {
    testIdentity,
    fromStatus: 'confirmed',
    toStatus: 'actioned',
    actorType: actor.actorType ?? 'human',
    actor: actor.actor,
    note: actor.note ?? 'quarantine applied',
  });
  return updated[0] as QuarantineRow;
}

export type ManifestEntry = {
  testIdentity: string;
  reason: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  actionedBy: string | null;
  actionedAt: string | null;
};

/**
 * The quarantine manifest: the authoritative, machine-readable list of tests CI
 * may skip/allow-fail. By construction it contains ONLY `actioned` rows, so
 * every entry carries a recorded human sign-off in the audit trail. This is the
 * sole mutation surface; nothing that has not been confirmed-then-actioned can
 * appear here.
 */
export async function buildQuarantineManifest(db: Database): Promise<ManifestEntry[]> {
  const rows = await db
    .select()
    .from(quarantine)
    .where(eq(quarantine.status, 'actioned'))
    .orderBy(asc(quarantine.testIdentity));
  return rows.map((r) => ({
    testIdentity: r.testIdentity,
    reason: r.reason,
    confirmedBy: r.confirmedBy,
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    actionedBy: r.actionedBy,
    actionedAt: r.actionedAt?.toISOString() ?? null,
  }));
}

/** Read the append-only audit trail, oldest first; optionally for one test. */
export async function getAuditTrail(
  db: Database,
  testIdentity?: string,
): Promise<QuarantineAuditRow[]> {
  const base = db.select().from(quarantineAudit);
  const rows = testIdentity
    ? await base
        .where(eq(quarantineAudit.testIdentity, testIdentity))
        .orderBy(asc(quarantineAudit.createdAt))
    : await base.orderBy(asc(quarantineAudit.createdAt));
  return rows;
}

/** List quarantine rows, optionally filtered by status, for operator surfaces. */
export async function listQuarantine(
  db: Database,
  status?: QuarantineStatus,
): Promise<QuarantineRow[]> {
  const base = db.select().from(quarantine);
  const rows = status
    ? await base.where(eq(quarantine.status, status)).orderBy(asc(quarantine.testIdentity))
    : await base.orderBy(asc(quarantine.testIdentity));
  return rows;
}
