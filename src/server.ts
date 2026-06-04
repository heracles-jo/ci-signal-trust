import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';

/**
 * Production entrypoint. Loads config, opens the DB pool, builds the app, and
 * listens. Handles graceful shutdown so the pool drains on SIGTERM/SIGINT.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const dbHandle = createDb(config.databaseUrl);
  const app = buildApp({ config, dbHandle });

  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await dbHandle.pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
