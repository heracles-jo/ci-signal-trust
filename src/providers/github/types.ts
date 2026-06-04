/**
 * Subset of the GitHub Actions REST API payloads we consume. Only the fields the
 * pure mapper depends on are typed; the live client passes through whatever the
 * API returns, so unknown extra fields are ignored rather than rejected.
 *
 * Refs:
 *  - GET /repos/{owner}/{repo}/actions/runs
 *  - GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}
 *  - GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs
 */

/** A workflow run (or a single re-run attempt of one). */
export type GithubWorkflowRun = {
  id: number;
  name?: string | null;
  run_number?: number;
  run_attempt?: number;
  head_sha: string;
  /** Lifecycle: 'queued' | 'in_progress' | 'completed' | 'waiting' | ... */
  status: string | null;
  /** Terminal result when status==='completed': 'success' | 'failure' | 'cancelled' | ... */
  conclusion: string | null;
  run_started_at?: string | null;
  created_at: string;
  updated_at: string;
  workflow_id?: number;
  event?: string;
};

export type GithubWorkflowRunsResponse = {
  total_count: number;
  workflow_runs: GithubWorkflowRun[];
};

/** A job within a workflow run attempt. */
export type GithubJob = {
  id: number;
  run_id: number;
  run_attempt?: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  workflow_name?: string | null;
};

export type GithubJobsResponse = {
  total_count: number;
  jobs: GithubJob[];
};

export type GithubArtifact = {
  id: number;
  name: string;
  expired?: boolean;
  archive_download_url?: string;
};

export type GithubArtifactsResponse = {
  total_count: number;
  artifacts: GithubArtifact[];
};
