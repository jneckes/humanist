// Playwright global setup for the E2E tests and the security suite: one X display per worker before any test
// file is loaded (Playwright runs global setup before it starts the workers, and workers inherit process.env;
// each takes its own display in useWorkerDisplay, test/helpers/display.ts), and a check that the app is built.
// Returns the teardown.

import type { FullConfig } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDisplays } from './display';

const ROOT = path.resolve(__dirname, '../..');

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  for (const f of ['packages/app/dist/main.cjs', 'packages/app/dist/preload-deck.cjs', 'packages/app/dist/preload-shell.cjs']) {
    if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`${f} is missing: run \`npm run build\` first`);
  }
  const displays = await ensureDisplays(config.workers);
  if (displays.length > 0) {
    const started = displays.some((d) => d.process) ? ' (Xvfb started for this run, one per worker)' : '';
    console.log(`[bl-test] X display${displays.length > 1 ? 's' : ''} ${displays.map((d) => d.display).join(', ')}${started}`);
  }
  const stop = () => {
    for (const d of displays) if (d.process && d.process.exitCode === null) d.process.kill('SIGKILL');
  };
  process.once('exit', stop);
  return async () => {
    await Promise.all(displays.map((d) => d.stop()));
  };
}
