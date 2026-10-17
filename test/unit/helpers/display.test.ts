// test/helpers/display.ts useWorkerDisplay: each Playwright worker takes its own X display, so no two workers'
// apps share an X clipboard (the clipboard tests in card-input, preload-electron and diagnostics paste what
// they wrote).

import { describe, expect, it } from 'vitest';
import { DISPLAYS_ENV, useWorkerDisplay } from '../../helpers/display';

describe('useWorkerDisplay', () => {
  it('gives each parallel slot its own display', () => {
    const seen = new Set<string>();
    for (const slot of ['0', '1', '2']) {
      const env: NodeJS.ProcessEnv = { [DISPLAYS_ENV]: ':140,:141,:142', DISPLAY: ':140', TEST_PARALLEL_INDEX: slot };
      const d = useWorkerDisplay(env);
      expect(env.DISPLAY).toBe(d);
      seen.add(String(d));
    }
    expect([...seen]).toEqual([':140', ':141', ':142']);
  });

  it('does nothing in the runner (no TEST_PARALLEL_INDEX) or without displays from global setup', () => {
    const runner: NodeJS.ProcessEnv = { [DISPLAYS_ENV]: ':140,:141', DISPLAY: ':140' };
    expect(useWorkerDisplay(runner)).toBeNull();
    expect(runner.DISPLAY).toBe(':140');
    const none: NodeJS.ProcessEnv = { DISPLAY: ':0', TEST_PARALLEL_INDEX: '1' };
    expect(useWorkerDisplay(none)).toBeNull();
    expect(none.DISPLAY).toBe(':0');
  });

  it('ignores malformed entries and wraps a slot past the list', () => {
    const env: NodeJS.ProcessEnv = { [DISPLAYS_ENV]: ':150,bogus,,:151', TEST_PARALLEL_INDEX: '3' };
    expect(useWorkerDisplay(env)).toBe(':151');
    const bad: NodeJS.ProcessEnv = { [DISPLAYS_ENV]: ':150', TEST_PARALLEL_INDEX: '-1', DISPLAY: ':9' };
    expect(useWorkerDisplay(bad)).toBeNull();
    expect(bad.DISPLAY).toBe(':9');
  });
});
