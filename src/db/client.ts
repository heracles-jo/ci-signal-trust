import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export type DbHandle = {
  db: Database;
  pool: Pool;
};

/**
 * Create a Drizzle database handle backed by a node-postgres connection pool.
 * The pool is returned so callers (server shutdown, tests) can close it.
 */
export function createDb(databaseUrl: string): DbHandle {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
