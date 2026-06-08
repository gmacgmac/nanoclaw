import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
    // Tests require a running PostgreSQL instance (docker compose up -d).
    // DATABASE_URL can be overridden via environment; defaults to local dev DB.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ||
        'postgres://nanoclaw:nanoclaw_dev@localhost:5432/nanoclaw_test',
    },
    // Run test files sequentially — they share a single PG database
    // and _initTestDatabase() drops/recreates tables.
    fileParallelism: false,
  },
});
