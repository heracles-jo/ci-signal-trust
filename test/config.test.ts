import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const KEYS = [
  'DATABASE_URL',
  'INGEST_SIGNING_SECRET',
  'READ_API_TOKEN',
  'PORT',
  'FFR_WINDOW_DAYS',
] as const;

describe('loadConfig', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it('loads required values and applies defaults for PORT and FFR_WINDOW_DAYS', () => {
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.INGEST_SIGNING_SECRET = 'secret';
    process.env.READ_API_TOKEN = 'token';
    const config = loadConfig();
    expect(config.databaseUrl).toBe('postgres://u:p@localhost:5432/db');
    expect(config.port).toBe(3000);
    expect(config.ffrWindowDays).toBe(14);
  });

  it('honors explicit PORT and FFR_WINDOW_DAYS', () => {
    process.env.DATABASE_URL = 'x';
    process.env.INGEST_SIGNING_SECRET = 's';
    process.env.READ_API_TOKEN = 't';
    process.env.PORT = '8080';
    process.env.FFR_WINDOW_DAYS = '30';
    const config = loadConfig();
    expect(config.port).toBe(8080);
    expect(config.ffrWindowDays).toBe(30);
  });

  it('throws when a required variable is missing', () => {
    process.env.INGEST_SIGNING_SECRET = 's';
    process.env.READ_API_TOKEN = 't';
    expect(() => loadConfig()).toThrow(/DATABASE_URL/);
  });

  it('throws when a numeric variable is not a positive integer', () => {
    process.env.DATABASE_URL = 'x';
    process.env.INGEST_SIGNING_SECRET = 's';
    process.env.READ_API_TOKEN = 't';
    process.env.PORT = 'not-a-number';
    expect(() => loadConfig()).toThrow(/PORT/);
  });
});
