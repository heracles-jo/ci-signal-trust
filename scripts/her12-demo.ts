/**
 * HER-12 end-to-end proof harness: seed two flaky tests through the real
 * ingestion path, then let the CLI drive the confirmation loop. Not shipped as a
 * product surface — it exists only to ingest demo data the CLI then operates on.
 *
 * Usage: tsx scripts/her12-demo.ts seed   (truncate + ingest two same-SHA flakes)
 */
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { ingestWebhook } from '../src/ingestion.js';
import type { CiWebhookBody } from '../src/schemas.js';

const FLAKE_A = 'integration.PaymentGatewaySpec#chargesCard';
const FLAKE_B = 'integration.SessionSpec#expiresIdleSession';

function run(
  externalRunId: string,
  commitSha: string,
  status: 'passed' | 'failed',
  completedAt: string,
  tests: { identity: string; outcome: 'passed' | 'failed' }[],
): CiWebhookBody {
  return {
    provider: 'github',
    externalRunId,
    commitSha,
    status,
    attempt: 1,
    startedAt: completedAt,
    completedAt,
    tests,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, pool } = createDb(config.databaseUrl);
  try {
    await db.execute(
      sql`truncate table quarantine_audit, quarantine, test_results, ci_runs, commits restart identity cascade`,
    );
    // Same SHA, fail then pass on identical code => same-SHA flake (both A and B).
    const today = new Date();
    const t = (h: number) => new Date(today.getTime() - h * 3600_000).toISOString();
    await ingestWebhook(
      db,
      run('demo-run-1', 'deadbeef', 'failed', t(5), [
        { identity: FLAKE_A, outcome: 'failed' },
        { identity: FLAKE_B, outcome: 'failed' },
      ]),
    );
    await ingestWebhook(
      db,
      run('demo-run-2', 'deadbeef', 'passed', t(4), [
        { identity: FLAKE_A, outcome: 'passed' },
        { identity: FLAKE_B, outcome: 'passed' },
      ]),
    );
    console.log(`Seeded same-SHA flakes: ${FLAKE_A} and ${FLAKE_B}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('demo seed failed:', err);
  process.exit(1);
});
