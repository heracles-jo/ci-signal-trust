import 'dotenv/config';
import { pino } from 'pino';
import { createDb } from './db/client.js';
import { GithubActionsClient } from './providers/github/client.js';
import { pullIngest } from './providers/github/ingest.js';

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
  } finally {
    await dbHandle.pool.end();
  }
}

main().catch((err) => {
  console.error('github pull ingest error:', err);
  process.exit(1);
});
