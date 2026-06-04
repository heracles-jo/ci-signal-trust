import { defineConfig } from 'drizzle-kit';

// drizzle-kit reads DATABASE_URL from the environment. For `db:generate` it only
// needs the schema; for push/introspect it would use the URL.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ci_signal_trust',
  },
  strict: true,
  verbose: true,
});
