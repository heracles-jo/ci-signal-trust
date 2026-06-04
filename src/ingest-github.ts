import 'dotenv/config';
import { appendFileSync } from 'node:fs';
import { pino } from 'pino';
import { createDb } from './db/client.js';
import { GithubActionsClient } from './providers/github/client.js';
import { type PullIngestSummary, pullIngest } from './providers/github/ingest.js';

/**
 * Entrypoint for the GitHub Actions pull-ingester (the HER-9 daily-cron target).
 *
 *   pnpm ingest:github --owner <o> --repo <r> [--max-runs N] [--no-artifacts]
 *
 * Config from env: DATABASE_URL (required), GITHUB_TOKEN (read-only, optional for
 * public repos), GITHUB_OWNER / GITHUB_REPO (fallback for --owner/--repo). The
 * token is read-only — this process never mutates the repo.
 */

type Args = { owner?: string; repo?: string; maxRuns?: number; useArtifacts: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { useArtifacts: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--owner') {
      args.owner = argv[++i];
    } else if (a === '--repo') {
      args.repo = argv[++i];
    } else if (a === '--max-runs') {
      const n = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error('--max-runs requires a positive integer');
      }
      args.maxRuns = n;
    } else if (a === '--no-artifacts') {
      args.useArtifacts = false;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const owner = args.owner ?? process.env.GITHUB_OWNER;
  const repo = args.repo ?? process.env.GITHUB_REPO;
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('Missing required environment variable: DATABASE_URL');
  }
  if (!owner || !repo) {
    throw new Error('Repo not specified: pass --owner/--repo or set GITHUB_OWNER/GITHUB_REPO');
  }

  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const client = new GithubActionsClient({ owner, repo, token: process.env.GITHUB_TOKEN });
  const dbHandle = createDb(databaseUrl);
  try {
    const summary = await pullIngest(dbHandle.db, client, {
      maxRuns: args.maxRuns,
      useArtifacts: args.useArtifacts,
      logger,
    });
    logger.info({ owner, repo, ...summary }, 'github pull ingest finished');
    writeRunMarker(owner, repo, summary);
  } finally {
    await dbHandle.pool.end();
  }
}

/**
 * Append a human-readable run-log marker to the GitHub Actions job summary when
 * running under the daily-cron workflow. This is the observable last-ingested
 * marker required by HER-9; outside CI ($GITHUB_STEP_SUMMARY unset) it is a no-op.
 */
function writeRunMarker(owner: string, repo: string, summary: PullIngestSummary): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const md = [
    '### Daily ingest — last run',
    '',
    `- **Repo:** \`${owner}/${repo}\``,
    `- **At (UTC):** ${new Date().toISOString()}`,
    `- **Runs scanned:** ${summary.runsScanned} (attempts: ${summary.attemptsConsidered})`,
    `- **Ingested:** ${summary.ingested} · **Duplicates (idempotent no-op):** ${summary.duplicates} · **Skipped:** ${summary.skipped}`,
    `- **Observations written:** ${summary.observationsWritten} ` +
      `(junit: ${summary.junitAttempts}, job: ${summary.jobAttempts}, run: ${summary.runAttempts})`,
    '',
  ].join('\n');
  appendFileSync(summaryPath, `${md}\n`);
}

main().catch((err) => {
  console.error('github pull ingest error:', err);
  process.exit(1);
});
