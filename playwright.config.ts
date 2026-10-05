import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const dataRoot = resolve('data/e2e');

/**
 * Chromium smoke for year-end tax panels, CT decisions, Partners panel and
 * the year-end export (issue #283). CI images already ship Chromium.
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx next dev -p ${port} -H 127.0.0.1`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...process.env,
      DATABASE_PATH: resolve(dataRoot, 'accounting.db'),
      DOCUMENT_STORAGE_PATH: resolve(dataRoot, 'documents'),
      BANK_IMPORT_WATCH_PATH: resolve(dataRoot, 'inbox'),
      BACKUP_PATH: resolve(dataRoot, 'backups'),
      EXTRACTION_PROVIDER: 'local',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.PLAYWRIGHT_CHROME_CHANNEL
          ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL }
          : {}),
      },
    },
  ],
});
