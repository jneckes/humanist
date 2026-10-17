// Unit tests of the exit-gate harness's pure parts (test/parity/*.test.ts): pixel comparison, PDF pages, deck
// labels. The root vitest config runs test/unit only, so these run with:
//   npx vitest run -c test/parity/vitest.config.mts
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
    include: ['test/parity/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
