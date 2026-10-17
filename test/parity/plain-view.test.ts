// The page-world scripts the harness gives both renders (harness/plain-view.ts): the freeze step and the
// seeded Math.random of --seed-random. Run here in fresh V8 contexts.
import { describe, expect, it, vi } from 'vitest';
import * as vm from 'node:vm';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false, on() {}, once() {} },
  BrowserWindow: class {},
  ipcMain: { on() {}, handle() {} },
  session: { fromPartition: () => ({}) },
  protocol: { registerSchemesAsPrivileged() {} },
}));

import { FREEZE_JS, SEEDED_RANDOM_JS } from './harness/plain-view';

function sequence(n: number): number[] {
  const ctx = vm.createContext({});
  vm.runInContext(SEEDED_RANDOM_JS, ctx);
  return vm.runInContext(`Array.from({ length: ${n} }, () => Math.random())`, ctx) as number[];
}

describe('seeded Math.random', () => {
  it('gives every load the same sequence, in [0, 1)', () => {
    const a = sequence(1000);
    expect(sequence(1000)).toEqual(a);
    expect(a.every((x) => x >= 0 && x < 1)).toBe(true);
    // Not a constant: it spreads over the range.
    expect(new Set(a.map((x) => Math.floor(x * 10))).size).toBe(10);
  });

  it('replaces Math.random in the context it runs in, and only there', () => {
    const ctx = vm.createContext({});
    const before = vm.runInContext('Math.random', ctx);
    vm.runInContext(SEEDED_RANDOM_JS, ctx);
    expect(vm.runInContext('Math.random', ctx)).not.toBe(before);
    expect(vm.runInContext('Math.random.name', ctx)).toBe('random');
    expect(Math.random).not.toBe(vm.runInContext('Math.random', ctx));
  });
});

describe('freeze step', () => {
  it('finishes finite animations and stops infinite ones at time 0', () => {
    const calls: string[] = [];
    const anim = (endTime: number, playState: string) => ({
      playState,
      currentTime: 500,
      effect: { getComputedTiming: () => ({ endTime }) },
      finish() {
        calls.push(`finish ${endTime}`);
      },
      pause() {
        calls.push(`pause ${endTime}`);
      },
    });
    const list = [anim(300, 'running'), anim(Infinity, 'running'), anim(200, 'finished')];
    const ctx = vm.createContext({ document: { getAnimations: () => list } });
    expect(vm.runInContext(FREEZE_JS, ctx)).toBe(2);
    expect(calls).toEqual(['finish 300', 'pause Infinity']);
    expect(list[1].currentTime).toBe(0);
  });

  it('survives a page without getAnimations', () => {
    expect(vm.runInContext(FREEZE_JS, vm.createContext({ document: {} }))).toBe(0);
  });
});
