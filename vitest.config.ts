import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@blueline\/core$/, replacement: r('./packages/core/src/index.ts') },
      { find: /^@blueline\/core\/(.*)$/, replacement: r('./packages/core/src/$1') },
      { find: /^@blueline\/editor$/, replacement: r('./packages/editor/src/index.ts') },
      { find: /^@blueline\/editor\/(.*)$/, replacement: r('./packages/editor/src/$1') },
    ],
  },
  test: {
    include: ['test/unit/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
