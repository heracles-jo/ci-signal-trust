/**
 * Provider-neutral ingestion model. Every provider (push webhook, GitHub pull,
 * future CI systems) maps its payloads to these shapes; the persistence layer
 * (src/ingestion.ts persistRun) only ever sees this normalized form. Adding a
 * provider is therefore a mapper, not a schema change (ADR §5.1).
 */

export type Outcome = 'passed' | 'failed';

/**
 * One per-test or per-job observation within a run. `identity` is the stable key
 * the classifier groups on (a JUnit test id, or a job-granularity pseudo-test).
 */
export type ObservationInput = {
  identity: string;
  outcome: Outcome;
  durationMs: number | null;
};

/** A single CI run ready to persist, with its observations. */
export type PersistableRun = {
  provider: string;
  externalRunId: string;
  commitSha: string;
  status: Outcome;
  attempt: number;
  startedAt: Date;
  completedAt: Date;
  observations: ObservationInput[];
};
