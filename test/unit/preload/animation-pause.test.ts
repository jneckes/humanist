// The Edit-mode animation pause (preload/animation-pause.ts; 6.3 "Animations pause while editing"): it pauses the
// running animations and adopts the pause sheet on entering Edit, and on leaving removes only its sheet and plays
// only what it paused and is still paused. Checked in Electron by test/e2e/edit-overlay-ui.spec.ts.

import { describe, expect, it } from 'vitest';
import { AnimationPause, adoptSheet, pauseRunning, removeSheet, type AnimationLike, type PauseDoc } from '../../../packages/app/src/preload/animation-pause';

class FakeAnimation implements AnimationLike {
  constructor(public playState: string) {}
  pause(): void {
    if (this.playState === 'running') this.playState = 'paused';
  }
  play(): void {
    this.playState = 'running';
  }
}

function doc(anims: FakeAnimation[], sheets: unknown[] = []): PauseDoc & { anims: FakeAnimation[] } {
  return { anims, getAnimations: () => anims, adoptedStyleSheets: sheets };
}

describe('AnimationPause (6.3)', () => {
  it('pauses what runs and adopts the sheet; resumes only what it paused', () => {
    const running = new FakeAnimation('running');
    const pagePaused = new FakeAnimation('paused');
    const finished = new FakeAnimation('finished');
    const pageSheet = { page: true };
    const d = doc([running, pagePaused, finished], [pageSheet]);
    const ours = { ours: true };
    const p = new AnimationPause(() => d, () => ours);
    expect(p.pause()).toBe(1);
    expect(p.active).toBe(true);
    expect(running.playState).toBe('paused');
    expect(d.adoptedStyleSheets).toEqual([pageSheet, ours]);
    expect(p.resume()).toBe(1);
    expect(p.active).toBe(false);
    expect(running.playState).toBe('running');
    // The page's own paused animation stays paused; the page's sheet stays.
    expect(pagePaused.playState).toBe('paused');
    expect(finished.playState).toBe('finished');
    expect(d.adoptedStyleSheets).toEqual([pageSheet]);
  });

  it('a second pause adds what started meanwhile and adopts the sheet again if the page replaced the list', () => {
    const a = new FakeAnimation('running');
    const d = doc([a]);
    const ours = {};
    const p = new AnimationPause(() => d, () => ours);
    p.pause();
    const b = new FakeAnimation('running');
    d.anims.push(b);
    d.adoptedStyleSheets = [];
    expect(p.pause()).toBe(1);
    expect(d.adoptedStyleSheets).toEqual([ours]);
    expect(p.resume()).toBe(2);
    expect([a.playState, b.playState]).toEqual(['running', 'running']);
  });

  it('does not restart what the page finished, cancelled or played itself meanwhile', () => {
    const a = new FakeAnimation('running');
    const b = new FakeAnimation('running');
    const c = new FakeAnimation('running');
    const d = doc([a, b, c]);
    const p = new AnimationPause(() => d, () => ({}));
    p.pause();
    a.playState = 'finished';
    b.playState = 'idle';
    c.playState = 'running';
    expect(p.resume()).toBe(0);
    expect([a.playState, b.playState, c.playState]).toEqual(['finished', 'idle', 'running']);
    // Resuming twice does nothing.
    expect(p.resume()).toBe(0);
  });

  it('the helpers tolerate a page that broke getAnimations or adoptedStyleSheets', () => {
    const broken = {
      getAnimations: () => {
        throw new Error('no');
      },
      get adoptedStyleSheets(): unknown[] {
        throw new Error('no');
      },
      set adoptedStyleSheets(_v: unknown[]) {
        throw new Error('no');
      },
    } as PauseDoc;
    expect(pauseRunning(broken)).toEqual([]);
    expect(adoptSheet(broken, {})).toBe(false);
    expect(() => removeSheet(broken, {})).not.toThrow();
    expect(adoptSheet(doc([]), null)).toBe(false);
  });
});
