// Unit tests of the Chromium fuzz gate's pure parts and of the probe's edited-text checks (test/fuzz/unit). The
// root vitest config runs test/unit only, so these run with:
//   npx vitest run -c test/fuzz/vitest.config.mts
// They import core and the app's main modules only, never @blueline/editor, so the reader-only gate runs them too.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('../..'),
  resolve: {
    alias: [
      { find: /^@blueline\/core$/, replacement: r('../../packages/core/src/index.ts') },
      { find: /^@blueline\/core\/(.*)$/, replacement: r('../../packages/core/src/$1') },
    ],
  },
  test: {
    include: ['test/fuzz/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
