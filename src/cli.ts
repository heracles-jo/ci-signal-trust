import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { evaluateClassifier, evaluateGate } from './eval/evaluation.js';
import { computeFfr, type FfrReport } from './reporting.js';

/**
 * CLI for operators. Subcommands:
 *   report   [--window-days N] [--json]   FFR + quarantine over the rolling window (DB)
 *   evaluate [--json]                      classifier precision/recall + hard gate (no DB)
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

async function main(): Promise<void> {
  const { command, windowDays, json } = parseArgs(process.argv.slice(2));
  if (command === 'report') {
    await runReport(windowDays, json);
  } else if (command === 'evaluate') {
    runEvaluate(json);
  } else {
    console.error('Usage: cli <report [--window-days N] | evaluate> [--json]');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('CLI error:', err);
  process.exit(1);
});
