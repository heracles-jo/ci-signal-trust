import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config.js';
import { createDb } from './client.js';

/**
 * Apply all generated migrations in ./drizzle to the database in DATABASE_URL.
 * Run via `pnpm db:migrate`.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const { db, pool } = createDb(config.databaseUrl);
  try {
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('Migrations applied successfully.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
