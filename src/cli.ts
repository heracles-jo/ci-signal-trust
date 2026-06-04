import { loadConfig } from './config.js';
import type { Database } from './db/client.js';
import { createDb } from './db/client.js';
import { evaluateClassifier, evaluateGate } from './eval/evaluation.js';
import {
  actionQuarantine,
  buildQuarantineManifest,
  confirmQuarantine,
  getAuditTrail,
  listQuarantine,
  type QuarantineStatus,
  QuarantineTransitionError,
  rejectQuarantine,
} from './quarantine.js';
import { computeFfr, type FfrReport } from './reporting.js';

/**
 * CLI for operators. Subcommands:
 *   report   [--window-days N] [--json]   FFR + quarantine over the rolling window (DB)
 *   evaluate [--json]                      classifier precision/recall + hard gate (no DB)
 *   quarantine <sub> ...                   confirmation loop (DB), see runQuarantine
 * Reuses src/reporting.ts and src/eval so the CLI matches the live behavior.
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
  lines.push(`Classifier gate:   ${report.gate.passed ? 'PASS' : 'FAIL'}`);
  if (report.quarantineSuppressed) {
    lines.push(`  ! recommendations SUPPRESSED — ${report.gate.summary}`);
  }
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

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function renderEvaluation(): string {
  const report = evaluateClassifier();
  const gate = evaluateGate(report);
  const lines: string[] = [];
  lines.push('CI Signal Trust — Classifier Evaluation (HER-11)');
  lines.push('================================================');
  lines.push(`Labeled set size:  ${report.labeledSetSize} (real-run: ${report.realRunCases})`);
  lines.push('');
  lines.push('Flake verdict:');
  lines.push(
    `  precision:       ${pct(report.flake.precision)} (TP ${report.flake.truePositives}/${report.flake.predictedTotal} predicted)`,
  );
  lines.push(
    `  recall:          ${pct(report.flake.recall)} (TP ${report.flake.truePositives}/${report.flake.labeledTotal} labeled)`,
  );
  lines.push('Real-defect verdict:');
  lines.push(
    `  precision:       ${pct(report.realDefect.precision)} (TP ${report.realDefect.truePositives}/${report.realDefect.predictedTotal} predicted)`,
  );
  lines.push(
    `  recall:          ${pct(report.realDefect.recall)} (TP ${report.realDefect.truePositives}/${report.realDefect.labeledTotal} labeled)`,
  );
  lines.push('');
  lines.push('HARD GATE — real failure must never be quarantined as flake:');
  lines.push(`  bar (flake precision): ${pct(gate.bar)}`);
  lines.push(`  observed:              ${pct(gate.observedFlakePrecision)}`);
  lines.push(`  real defects leaked:   ${gate.realDefectLeakCount}`);
  lines.push(`  result:                ${gate.passed ? 'PASS' : 'FAIL'}`);
  if (gate.realDefectLeakCount > 0) {
    lines.push('  leaked cases:');
    for (const c of report.realDefectsLeakedAsFlake) {
      lines.push(`    - ${c.id} (${c.testIdentity})`);
    }
  }
  return lines.join('\n');
}

async function runReport(windowDays: number | undefined, json: boolean): Promise<void> {
  const config = loadConfig();
  const dbHandle = createDb(config.databaseUrl);
  try {
    const report = await computeFfr(dbHandle.db, windowDays ?? config.ffrWindowDays);
    console.log(json ? JSON.stringify(report, null, 2) : renderHuman(report));
  } finally {
    await dbHandle.pool.end();
  }
}

function runEvaluate(json: boolean): void {
  if (json) {
    const report = evaluateClassifier();
    console.log(JSON.stringify({ ...report, gate: evaluateGate(report) }, null, 2));
  } else {
    console.log(renderEvaluation());
  }
}

/** Pull a `--flag value` pair out of argv; returns undefined when absent. */
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  return argv[i + 1];
}

/**
 * Quarantine confirmation loop CLI. Subcommands:
 *   list [--status S] [--json]                  show quarantine rows
 *   confirm <test> --by <actor> [--note N] [--board]   sign off: recommended->confirmed
 *   reject  <test> --by <actor> [--note N] [--board]   decline:  recommended->rejected
 *   action  <test> --by <actor> [--note N]             apply:    confirmed->actioned
 *   manifest [--json]                           the actioned-only manifest CI consumes
 *   audit [<test>] [--json]                     append-only audit trail
 */
async function runQuarantine(sub: string | undefined, argv: string[]): Promise<void> {
  const json = argv.includes('--json');
  const config = loadConfig();
  const dbHandle = createDb(config.databaseUrl);
  const { db } = dbHandle;
  try {
    switch (sub) {
      case 'list':
        await quarantineList(db, flagValue(argv, '--status') as QuarantineStatus | undefined, json);
        break;
      case 'confirm':
      case 'reject':
      case 'action':
        await quarantineDecision(db, sub, argv);
        break;
      case 'manifest':
        await quarantineManifest(db, json);
        break;
      case 'audit':
        await quarantineAudit(db, argv, json);
        break;
      default:
        console.error(
          'Usage: cli quarantine <list|confirm|reject|action|manifest|audit> [...] [--json]',
        );
        process.exitCode = 2;
    }
  } finally {
    await dbHandle.pool.end();
  }
}

async function quarantineList(
  db: Database,
  status: QuarantineStatus | undefined,
  json: boolean,
): Promise<void> {
  const rows = await listQuarantine(db, status);
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(`Quarantine rows${status ? ` (status=${status})` : ''}: ${rows.length}`);
  for (const r of rows) {
    console.log(`  - ${r.testIdentity}  [${r.status}]  flaky=${r.flakyCount}`);
    console.log(`      ${r.reason}`);
    if (r.confirmedBy) {
      console.log(`      confirmed by ${r.confirmedBy} at ${r.confirmedAt?.toISOString()}`);
    }
    if (r.actionedBy) {
      console.log(`      actioned by ${r.actionedBy} at ${r.actionedAt?.toISOString()}`);
    }
  }
}

async function quarantineDecision(
  db: Database,
  sub: 'confirm' | 'reject' | 'action',
  argv: string[],
): Promise<void> {
  const test = argv[0];
  const actor = flagValue(argv, '--by');
  const note = flagValue(argv, '--note');
  if (!test || test.startsWith('--') || !actor) {
    console.error(`Usage: cli quarantine ${sub} <test-identity> --by <actor> [--note "..."]`);
    process.exitCode = 2;
    return;
  }
  try {
    if (sub === 'confirm') {
      const actorType = argv.includes('--board') ? ('board' as const) : ('human' as const);
      const row = await confirmQuarantine(db, test, { actor, actorType, note });
      console.log(`CONFIRMED ${row.testIdentity} by ${actor} (sign-off recorded).`);
    } else if (sub === 'reject') {
      const actorType = argv.includes('--board') ? ('board' as const) : ('human' as const);
      const row = await rejectQuarantine(db, test, { actor, actorType, note });
      console.log(`REJECTED ${row.testIdentity} by ${actor} (recorded).`);
    } else {
      const row = await actionQuarantine(db, test, { actor, note });
      console.log(`ACTIONED ${row.testIdentity} by ${actor} — now in the quarantine manifest.`);
    }
  } catch (err) {
    if (err instanceof QuarantineTransitionError) {
      console.error(`Refused: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

async function quarantineManifest(db: Database, json: boolean): Promise<void> {
  const manifest = await buildQuarantineManifest(db);
  if (json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  console.log(`Quarantine manifest (actioned only): ${manifest.length} test(s)`);
  for (const m of manifest) {
    console.log(`  - ${m.testIdentity}`);
    console.log(`      confirmed by ${m.confirmedBy ?? '?'} | actioned by ${m.actionedBy ?? '?'}`);
  }
}

async function quarantineAudit(db: Database, argv: string[], json: boolean): Promise<void> {
  const test = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  const trail = await getAuditTrail(db, test);
  if (json) {
    console.log(JSON.stringify(trail, null, 2));
    return;
  }
  console.log(`Audit trail${test ? ` for ${test}` : ''}: ${trail.length} entr(y/ies)`);
  for (const a of trail) {
    console.log(
      `  ${a.createdAt.toISOString()}  ${a.testIdentity}  ${a.fromStatus ?? '∅'} -> ${a.toStatus}` +
        `  by ${a.actor} (${a.actorType}): ${a.note}`,
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, windowDays, json } = parseArgs(argv);
  if (command === 'report') {
    await runReport(windowDays, json);
  } else if (command === 'evaluate') {
    runEvaluate(json);
  } else if (command === 'quarantine') {
    await runQuarantine(argv[1], argv.slice(2));
  } else {
    console.error(
      'Usage: cli <report [--window-days N] | evaluate | quarantine <sub> ...> [--json]',
    );
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('CLI error:', err);
  process.exit(1);
});
