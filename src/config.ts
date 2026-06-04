import 'dotenv/config';

/**
 * 12-factor config: everything comes from the environment. We never hardcode
 * secrets. `loadConfig` throws loudly at startup if a required var is missing so
 * misconfiguration fails fast rather than at first request.
 */
export type AppConfig = {
  databaseUrl: string;
  ingestSigningSecret: string;
  readApiToken: string;
  port: number;
  ffrWindowDays: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intOr(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  return {
    databaseUrl: required('DATABASE_URL'),
    ingestSigningSecret: required('INGEST_SIGNING_SECRET'),
    readApiToken: required('READ_API_TOKEN'),
    port: intOr('PORT', 3000),
    ffrWindowDays: intOr('FFR_WINDOW_DAYS', 14),
  };
}
