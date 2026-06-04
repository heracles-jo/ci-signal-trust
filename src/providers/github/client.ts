/**
 * Read-only GitHub Actions REST client (the I/O boundary, kept out of the pure
 * mappers). ONLY issues GET requests — no endpoint here can mutate the repo, so a
 * least-privilege token (public repo: no scopes; private: `actions:read` /
 * `repo`-read) is sufficient. HER-8 acceptance: no repo mutation.
 */

import type {
  GithubArtifact,
  GithubArtifactsResponse,
  GithubJob,
  GithubJobsResponse,
  GithubWorkflowRun,
  GithubWorkflowRunsResponse,
} from './types.js';

export type GithubClientOptions = {
  owner: string;
  repo: string;
  /** Optional token. Public repos work unauthenticated but are rate-limited harder. */
  token?: string;
  /** Override for tests; defaults to the public API host. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

/** Minimal surface the ingester depends on — easy to fake in unit tests. */
export interface GithubActionsApi {
  listWorkflowRuns(opts?: { perPage?: number; maxRuns?: number }): Promise<GithubWorkflowRun[]>;
  getRunAttempt(runId: number, attempt: number): Promise<GithubWorkflowRun>;
  listJobsForAttempt(runId: number, attempt: number): Promise<GithubJob[]>;
  listArtifacts(runId: number): Promise<GithubArtifact[]>;
  downloadArtifactZip(artifactId: number): Promise<Uint8Array>;
}

const DEFAULT_BASE_URL = 'https://api.github.com';

export class GithubActionsClient implements GithubActionsApi {
  private readonly owner: string;
  private readonly repo: string;
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GithubClientOptions) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ci-signal-trust',
    };
    if (this.token) {
      h.authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`GitHub API GET ${path} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  /** Page through completed workflow runs, newest first, up to maxRuns. */
  async listWorkflowRuns(
    opts: { perPage?: number; maxRuns?: number } = {},
  ): Promise<GithubWorkflowRun[]> {
    const perPage = Math.min(opts.perPage ?? 100, 100);
    const maxRuns = opts.maxRuns ?? Number.POSITIVE_INFINITY;
    const runs: GithubWorkflowRun[] = [];
    for (let page = 1; runs.length < maxRuns; page++) {
      const body = await this.getJson<GithubWorkflowRunsResponse>(
        `/repos/${this.owner}/${this.repo}/actions/runs?per_page=${perPage}&page=${page}`,
      );
      const batch = body.workflow_runs ?? [];
      runs.push(...batch);
      if (batch.length < perPage) {
        break;
      }
    }
    return runs.slice(0, maxRuns === Number.POSITIVE_INFINITY ? runs.length : maxRuns);
  }

  async getRunAttempt(runId: number, attempt: number): Promise<GithubWorkflowRun> {
    return this.getJson<GithubWorkflowRun>(
      `/repos/${this.owner}/${this.repo}/actions/runs/${runId}/attempts/${attempt}`,
    );
  }

  async listJobsForAttempt(runId: number, attempt: number): Promise<GithubJob[]> {
    const body = await this.getJson<GithubJobsResponse>(
      `/repos/${this.owner}/${this.repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
    );
    return body.jobs ?? [];
  }

  async listArtifacts(runId: number): Promise<GithubArtifact[]> {
    const body = await this.getJson<GithubArtifactsResponse>(
      `/repos/${this.owner}/${this.repo}/actions/runs/${runId}/artifacts?per_page=100`,
    );
    return body.artifacts ?? [];
  }

  async downloadArtifactZip(artifactId: number): Promise<Uint8Array> {
    // GitHub redirects this to a signed blob URL; fetch follows redirects.
    const res = await this.fetchImpl(
      `${this.baseUrl}/repos/${this.owner}/${this.repo}/actions/artifacts/${artifactId}/zip`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`GitHub artifact ${artifactId} download failed: ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}
