// Playwright global setup for the E2E tests and the security suite: an X display before any test file is
// loaded (Playwright runs global setup before loading tests, and workers inherit process.env), and a check
// that the app is built. Returns the teardown.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDisplay } from './display';

const ROOT = path.resolve(__dirname, '../..');

export default async function globalSetup(): Promise<() => Promise<void>> {
  for (const f of ['packages/app/dist/main.cjs', 'packages/app/dist/preload-deck.cjs', 'packages/app/dist/preload-shell.cjs']) {
    if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`${f} is missing: run \`npm run build\` first`);
  }
  const display = await ensureDisplay();
  if (display) console.log(`[bl-test] X display ${display.display}${display.process ? ' (Xvfb started for this run)' : ''}`);
  const stop = () => {
    if (display?.process && display.process.exitCode === null) display.process.kill('SIGKILL');
  };
  process.once('exit', stop);
  return async () => {
    await display?.stop();
  };
}
