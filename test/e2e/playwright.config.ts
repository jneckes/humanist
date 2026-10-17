// E2E tests with Playwright's Electron launcher (SPEC section 11). `npm run test:e2e` builds first.
// Global setup starts Xvfb on Linux (test/helpers/display.ts), so no xvfb-run is needed around this command.

import { defineConfig } from '@playwright/test';
import * as path from 'node:path';
import { useWorkerDisplay } from '../helpers/display';

// In a worker process: this worker's own X display (one per worker, so no two share a clipboard).
useWorkerDisplay();

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts$/,
  outputDir: path.resolve(__dirname, '../../test-results/e2e'),
  globalSetup: path.resolve(__dirname, '../helpers/global-setup.ts'),
  // Each test launches its own app; Electron is heavy, so keep parallelism modest.
  workers: process.env.CI ? 1 : 2,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: path.resolve(__dirname, '../../test-results/e2e/results.json') }]],
});
