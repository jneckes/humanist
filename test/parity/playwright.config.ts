// The exit gate's committed check (SPEC 11: "Render parity and PDF ... run nightly on the committed fixtures"):
// test/parity/parity.spec.ts runs scripts/parity.mjs on three committed fixtures, the seeded-random and
// delayed-build fixtures, and the negative controls of test/parity/fixtures (each beforeAll sets its own timeout).
//   npm run build && npx playwright test -c test/parity/playwright.config.ts
// Global setup starts Xvfb on Linux and checks the build (test/helpers/global-setup.ts).

import { defineConfig } from '@playwright/test';
import * as path from 'node:path';
import { useWorkerDisplay } from '../helpers/display';

// In a worker process: this worker's own X display (one per worker, so no two share a clipboard).
useWorkerDisplay();

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts$/,
  outputDir: path.resolve(__dirname, '../../test-results/parity-e2e'),
  globalSetup: path.resolve(__dirname, '../helpers/global-setup.ts'),
  workers: 1,
  fullyParallel: false,
  timeout: 600_000,
  retries: 0,
  reporter: [['list']],
});
