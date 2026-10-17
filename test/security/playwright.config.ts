// The security suite (SPEC 6.10, 9.9, section 10 Security fixtures, section 11): the Phase 0 security fixtures
// in both trust states. `npm run test:security` builds first.
//
// One worker: the suite's DNS server binds 127.0.0.1:53 once per worker, and the "the test servers receive
// NOTHING" assertions are made per phase, which concurrent apps would muddy.
// Run as root (the dev container): the app runs as `bltest` with the OS sandbox on, inside a private mount
// namespace whose resolv.conf points at the suite's DNS server (test/helpers/app.ts). BL_TEST_RUN_AS and
// BL_TEST_DNS override that; every result records which mode ran.

import { defineConfig } from '@playwright/test';
import * as path from 'node:path';
import { useWorkerDisplay } from '../helpers/display';

// In a worker process: this worker's own X display (one per worker, so no two share a clipboard).
useWorkerDisplay();

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts$/,
  outputDir: path.resolve(__dirname, '../../test-results/security'),
  globalSetup: path.resolve(__dirname, '../helpers/global-setup.ts'),
  workers: 1,
  fullyParallel: false,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: path.resolve(__dirname, '../../test-results/security/results.json') }]],
});
