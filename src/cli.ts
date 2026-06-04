import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { computeFfr, type FfrReport } from './reporting.js';

/**
 * CLI for operators. Currently one subcommand:
 *   report [--window-days N] [--json]
 * Reuses src/reporting.ts so the CLI and HTTP report stay identical.
 */

function parseArgs(argv: string[]): {
  command: string | undefined;
  windowDays: number | undefined;
  json: boolean;
} {
  const command = argv[0];
  let windowDays: number | undefined;
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--window-days') {
      const next = argv[++i];
      const parsed = next ? Number.parseInt(next, 10) : Number.NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--window-days requires a positive integer');
      }
      windowDays = parsed;
    }
  }
  return { command, windowDays, json };
}

function renderHuman(report: FfrReport): string {
  const lines: string[] = [];
  lines.push('CI Signal Trust — Flaky-Failure Report');
  lines.push('======================================');
  lines.push(`Window:            last ${report.windowDays} day(s)`);
  lines.push(`Total failures:    ${report.totalFailures}`);
  lines.push(`Flaky failures:    ${report.flakyFailures}`);
  lines.push(`FFR:               ${(report.ffr * 100).toFixed(2)}%`);
  lines.push(`Reclaimed (est.):  ${report.reclaimedHoursEstimate.toFixed(2)} h`);
  lines.push('');
  lines.push(`Quarantine candidates (${report.quarantine.length}):`);
  if (report.quarantine.length === 0) {
    lines.push('  (none)');
  } else {
    for (const q of report.quarantine) {
      lines.push(`  - ${q.testIdentity}`);
      lines.push(`      classification: ${q.classification} | flaky failures: ${q.flakyCount}`);
      lines.push(`      reason: ${q.reason}`);
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { command, windowDays, json } = parseArgs(process.argv.slice(2));
  if (command !== 'report') {
    console.error('Usage: cli report [--window-days N] [--json]');
    process.exit(2);
  }

  const config = loadConfig();
  const dbHandle = createDb(config.databaseUrl);
  try {
    const report = await computeFfr(dbHandle.db, windowDays ?? config.ffrWindowDays);
    console.log(json ? JSON.stringify(report, null, 2) : renderHuman(report));
  } finally {
    await dbHandle.pool.end();
  }
}

main().catch((err) => {
  console.error('CLI error:', err);
  process.exit(1);
});
