import { describe, expect, it } from 'vitest';
import { GithubActionsClient } from '../src/providers/github/client.js';

type Call = { url: string; headers: Record<string, string> };

/** Build a fake fetch that records calls and returns canned JSON/bytes per URL. */
function fakeFetch(
  routes: Record<string, { json?: unknown; bytes?: Uint8Array; status?: number }>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const match = Object.keys(routes).find((r) => url.includes(r));
    const route = match ? routes[match] : undefined;
    const status = route?.status ?? (route ? 200 : 404);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'ERR',
      json: async () => route?.json,
      arrayBuffer: async () => (route?.bytes ?? new Uint8Array()).buffer,
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function client(fetchImpl: typeof fetch): GithubActionsClient {
  return new GithubActionsClient({
    owner: 'o',
    repo: 'r',
    token: 'secret-token',
    baseUrl: 'https://api.example/',
    fetchImpl,
  });
}

describe('GithubActionsClient', () => {
  it('sends versioned headers and a bearer token; strips a trailing slash from baseUrl', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/actions/runs': { json: { total_count: 0, workflow_runs: [] } },
    });
    await client(fetchImpl).listWorkflowRuns({ perPage: 1, maxRuns: 1 });
    expect(calls[0]?.url).toBe('https://api.example/repos/o/r/actions/runs?per_page=1&page=1');
    expect(calls[0]?.headers.authorization).toBe('Bearer secret-token');
    expect(calls[0]?.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('omits the authorization header when no token is given', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/actions/runs': { json: { total_count: 0, workflow_runs: [] } },
    });
    const c = new GithubActionsClient({
      owner: 'o',
      repo: 'r',
      baseUrl: 'https://api.example',
      fetchImpl,
    });
    await c.listWorkflowRuns({ maxRuns: 1 });
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('paginates until a short page and respects maxRuns', async () => {
    // perPage capped at 100; return a full first page then a short second page.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const page2 = [{ id: 100 }];
    let call = 0;
    const fetchImpl = (async (url: string) => {
      call++;
      const runs = /[?&]page=1(?:&|$)/.test(url) ? page1 : page2;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ workflow_runs: runs }),
      };
    }) as unknown as typeof fetch;
    const all = await client(fetchImpl).listWorkflowRuns();
    expect(all.length).toBe(101);
    expect(call).toBe(2);
  });

  it('caps maxRuns even when more are returned', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ workflow_runs: page1 }),
    })) as unknown as typeof fetch;
    const all = await client(fetchImpl).listWorkflowRuns({ maxRuns: 10 });
    expect(all.length).toBe(10);
  });

  it('fetches a specific run attempt and a run attempt jobs', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/attempts/2/jobs': { json: { total_count: 1, jobs: [{ id: 1 }] } },
      '/attempts/2': { json: { id: 5, run_attempt: 2 } },
    });
    const c = client(fetchImpl);
    expect((await c.getRunAttempt(5, 2)).run_attempt).toBe(2);
    expect((await c.listJobsForAttempt(5, 2)).length).toBe(1);
    expect(calls.some((x) => x.url.includes('/actions/runs/5/attempts/2'))).toBe(true);
  });

  it('lists artifacts and downloads an artifact zip as bytes', async () => {
    const bytes = new Uint8Array([80, 75, 3, 4]);
    const { fetchImpl } = fakeFetch({
      '/artifacts/42/zip': { bytes },
      '/artifacts': { json: { total_count: 1, artifacts: [{ id: 42, name: 'junit' }] } },
    });
    const c = client(fetchImpl);
    expect((await c.listArtifacts(1))[0]?.name).toBe('junit');
    const zip = await c.downloadArtifactZip(42);
    expect(Array.from(zip)).toEqual([80, 75, 3, 4]);
  });

  it('throws on a non-2xx JSON response', async () => {
    const { fetchImpl } = fakeFetch({ '/actions/runs': { status: 500 } });
    await expect(client(fetchImpl).listWorkflowRuns({ maxRuns: 1 })).rejects.toThrow(/500/);
  });

  it('throws when an artifact download fails', async () => {
    const { fetchImpl } = fakeFetch({ '/zip': { status: 404 } });
    await expect(client(fetchImpl).downloadArtifactZip(1)).rejects.toThrow(/download failed/);
  });
});
