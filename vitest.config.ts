import { defineConfig } from 'vitest/config';

// In CI we additionally emit a JUnit XML report (uploaded as a build artifact)
// so per-test outcomes are captured going forward. Locally we keep the default
// reporter only, so `pnpm test` does not leave a stray report file behind.
const inCI = !!process.env.GITHUB_ACTIONS;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: inCI ? ['default', 'junit'] : ['default'],
    outputFile: inCI ? { junit: './reports/junit.xml' } : undefined,
    // E2E spins up a real Postgres + Fastify; give it room and run files serially
    // so the shared DB isn't truncated out from under a parallel suite.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/db/migrate.ts', 'src/cli.ts', 'src/ingest-github.ts'],
      // Hard gate: CI fails (blocks merge) if coverage regresses below these
      // floors. Current actuals are ~93% stmts / ~85% branch; these floors are
      // the ratchet baseline (raise as coverage rises, per ADR-006).
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
