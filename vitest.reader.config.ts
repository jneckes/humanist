// The reader-only unit suite (P2-15; SPEC 9.6, 10 Phase 2 "Reader-only build"): the root suite without the tests
// that need the Edit capability, run by scripts/reader-only-check.mjs in a copy of the tree with no packages/editor.
// @blueline/editor has no alias here, so a reader test that imported it would fail to load.
//
// Left out: test/unit/editor/ (the patcher's own tests, except mapper-findings.test.ts, which imports core only)
// and any *.edit.test.ts (for example the probe's cases that drive the real write queue). The fuzz harness's own
// unit tests (test/fuzz/unit) need no editor and run here too.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Every test file of test/unit/editor but the ones that import core only. */
function editorTests(): string[] {
  const keep = new Set(['mapper-findings.test.ts']);
  try {
    return readdirSync(r('./test/unit/editor'))
      .filter((f) => f.endsWith('.test.ts') && !keep.has(f))
      .map((f) => `test/unit/editor/${f}`);
  } catch {
    return [];
  }
}

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@blueline\/core$/, replacement: r('./packages/core/src/index.ts') },
      { find: /^@blueline\/core\/(.*)$/, replacement: r('./packages/core/src/$1') },
    ],
  },
  test: {
    include: ['test/unit/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'test/fuzz/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.edit.test.ts', ...editorTests()],
    environment: 'node',
    testTimeout: 30000,
  },
});
