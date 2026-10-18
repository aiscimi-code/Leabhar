import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    pool: 'forks',
    globalSetup: ['./vitest.globalSetup.ts'],
    // The rules-store tests do real statute ingestion work that takes
    // 5–10s per test. The default 5s timeout causes false failures (#753).
    testTimeout: 60_000,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
