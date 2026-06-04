/**
 * GitHub Actions pull-ingester.
 *
 * The walking skeleton ingested via a push webhook. Phase 2 needs to PULL our
 * own repo's live CI history from the GitHub REST API and feed it through the
 * same idempotent ingestion path.
 *
 * Granularity: each workflow-run ATTEMPT becomes one observation of a synthetic
 * "test" whose identity is the workflow name. Re-running a failed workflow on
 * the SAME commit therefore yields a passed+failed pair on an identical SHA,
 * which the existing pure classifier already labels a flake. When a run uploads
 * a JUnit report we can later resolve per-test outcomes; until then the whole CI
 * job is the unit, which is enough to compute a real run-level FFR baseline from
 * history that already exists — no waiting required.
 *
 * The mapping is a PURE function (no I/O) so it is exhaustively unit-testable.
 * Network access lives in a thin, injectable shell.
 */

import type { CiWebhookBody } from '../schemas.js';

/** Subset of the GitHub Actions workflow-run object we depend on. */
export type GithubWorkflowRun = {
  id: number;
  name?: string | null;
  head_sha: string;
  /** queued | in_progress | completed */
  status?: string | null;
  /** success | failure | cancelled | skipped | timed_out | ... | null */
  conclusion?: string | null;
  run_attempt?: number | null;
  run_started_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

/**
 * Map a GitHub run conclusion to a clean pass/fail signal, or null when the
 * outcome is not a trustworthy success/failure signal (cancelled, skipped, in
 * progress, etc.) and must be dropped rather than guessed.
 */
export function conclusionToOutcome(
  conclusion: string | null | undefined,
): 'passed' | 'failed' | null {
  switch (conclusion) {
    case 'success':
      return 'passed';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failed';
    default:
      // cancelled, skipped, neutral, action_required, stale, null, in-progress
      return null;
  }
}

/**
 * Map a single workflow-run attempt to an ingestible webhook body, or null when
 * the run carries no trustworthy pass/fail signal (and so must be skipped).
 *
 * `externalRunId` embeds the attempt so re-runs are distinct rows under the
 * (provider, externalRunId) uniqueness constraint, while still sharing a SHA.
 */
export function mapWorkflowRunToBody(run: GithubWorkflowRun): CiWebhookBody | null {
  if (run.status && run.status !== 'completed') {
    return null;
  }
  const outcome = conclusionToOutcome(run.conclusion);
  if (outcome === null) {
    return null;
  }
  const attempt = run.run_attempt && run.run_attempt > 0 ? run.run_attempt : 1;
  const startedAt = run.run_started_at ?? run.created_at ?? run.updated_at;
  const completedAt = run.updated_at ?? startedAt;
  if (!startedAt || !completedAt) {
    return null;
  }
  const workflow = (run.name ?? 'workflow').trim() || 'workflow';

  return {
    provider: 'github',
    externalRunId: `${run.id}#${attempt}`,
    commitSha: run.head_sha,
    status: outcome,
    attempt,
    startedAt,
    completedAt,
    tests: [{ identity: `workflow:${workflow}`, outcome }],
  };
}

/**
 * Pure: map a page (or backfill) of workflow runs to ingestible bodies,
 * dropping runs without a clean signal.
 */
export function mapWorkflowRunsToBodies(runs: GithubWorkflowRun[]): CiWebhookBody[] {
  const bodies: CiWebhookBody[] = [];
  for (const run of runs) {
    const body = mapWorkflowRunToBody(run);
    if (body) {
      bodies.push(body);
    }
  }
  return bodies;
}

// ---------------------------------------------------------------------------
// Network shell — thin I/O layer; pure functions above are tested standalone.
// ---------------------------------------------------------------------------

import type { Database } from '../db/client.js';
import { ingestWebhook } from '../ingestion.js';

export type GithubIngestOptions = {
  owner: string;
  repo: string;
  /** GitHub token with actions:read scope. */
  token: string;
  /** How many days of history to backfill. Default 14. */
  windowDays?: number;
  /** GitHub API page size (max 100). Default 100. */
  perPage?: number;
};

export type IngestSummary = {
  /** Total workflow-run objects fetched from the API. */
  fetched: number;
  /** Runs that mapped to a clean pass/fail CiWebhookBody. */
  mapped: number;
  /** Bodies accepted as new by the DB. */
  accepted: number;
  /** Bodies that were already in the DB (idempotent duplicates). */
  duplicate: number;
};

/** Parse the `Link` header and return the `rel="next"` URL, or null. */
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * Fetch all workflow runs for `owner/repo` created on or after `sinceIso`.
 * Follows pagination automatically; stops early when the oldest run on a page
 * predates the window (the API returns runs newest-first).
 *
 * Injectable `fetchFn` defaults to global `fetch`; pass a mock in tests.
 */
export async function fetchWorkflowRuns(
  opts: GithubIngestOptions,
  sinceIso: string,
  fetchFn: typeof fetch = fetch,
): Promise<GithubWorkflowRun[]> {
  const { owner, repo, token, perPage = 100 } = opts;
  const base = `https://api.github.com/repos/${owner}/${repo}/actions/runs`;
  const sinceMs = Date.parse(sinceIso);

  const all: GithubWorkflowRun[] = [];
  let url: string | null =
    `${base}?per_page=${perPage}&exclude_pull_requests=false&status=completed`;

  while (url) {
    const res = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status} for ${url}: ${text.slice(0, 200)}`);
    }

    const body = (await res.json()) as { workflow_runs: GithubWorkflowRun[] };
    const page = body.workflow_runs ?? [];

    let exhausted = false;
    for (const run of page) {
      const createdMs = Date.parse(run.created_at ?? run.updated_at ?? '');
      if (Number.isFinite(createdMs) && createdMs < sinceMs) {
        exhausted = true;
        break;
      }
      all.push(run);
    }

    if (exhausted || page.length === 0) break;
    url = parseNextLink(res.headers.get('Link'));
  }

  return all;
}

/**
 * Pull-ingest a GitHub repo: fetch all completed workflow runs within the
 * window, map to observations, and persist idempotently via `ingestWebhook`.
 *
 * Safe to call multiple times (duplicate runs are silently skipped).
 */
export async function ingestGithubRepo(
  db: Database,
  opts: GithubIngestOptions,
  fetchFn?: typeof fetch,
): Promise<IngestSummary> {
  const windowDays = opts.windowDays ?? 14;
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const runs = await fetchWorkflowRuns(opts, sinceIso, fetchFn);
  const bodies = mapWorkflowRunsToBodies(runs);

  let accepted = 0;
  let duplicate = 0;
  for (const body of bodies) {
    const result = await ingestWebhook(db, body);
    if (result.status === 'accepted') {
      accepted++;
    } else {
      duplicate++;
    }
  }

  return { fetched: runs.length, mapped: bodies.length, accepted, duplicate };
}
