// Present (6.9, Cmd+Option+P): full screen, the chrome hidden, every key but Esc to the deck (Read routing),
// Esc caught in before-input-event; leaving restores the window's full screen state and the mode it had.
import { describe, expect, it } from 'vitest';
import type { AppMode } from '@blueline/core/ipc';
import { Present, isPresentExit, type PresentInput } from '../../../packages/app/src/main/present';

function host(o: { fullScreen?: boolean; mode?: AppMode } = {}) {
  const log: string[] = [];
  const h = {
    fs: o.fullScreen ?? false,
    mode: (o.mode ?? 'read') as AppMode,
    log,
    isFullScreen: () => h.fs,
    setFullScreen: (on: boolean) => {
      log.push(`fullscreen:${on}`);
      h.fs = on;
    },
    appMode: () => h.mode,
    setMode: (m: AppMode) => {
      log.push(`mode:${m}`);
      h.mode = m;
      return true;
    },
    relayout: () => log.push('relayout'),
    focusDeck: () => log.push('focus'),
    onChange: (p: boolean) => log.push(`change:${p}`),
  };
  return h;
}

const key = (p: Partial<PresentInput>): PresentInput => ({ type: 'keyDown', key: '', code: '', control: false, meta: false, alt: false, shift: false, ...p });

describe('Present', () => {
  it('enter: Read routing, full screen, a relayout (no chrome), the keyboard on the deck', () => {
    const h = host({ mode: 'review' });
    const p = new Present(h);
    expect(p.enter()).toBe(true);
    expect(p.active).toBe(true);
    expect(p.savedMode).toBe('review');
    expect(h.log).toEqual(['mode:read', 'fullscreen:true', 'relayout', 'focus', 'change:true']);
    // A second Cmd+Option+P does nothing.
    expect(p.enter()).toBe(false);
  });

  it('Esc (and only Esc) exits and restores the mode and the window', () => {
    const h = host({ mode: 'edit' });
    const p = new Present(h);
    p.enter();
    h.log.length = 0;
    for (const k of [key({ key: 'ArrowRight', code: 'ArrowRight' }), key({ key: 'Escape', code: 'Escape', shift: true }), key({ key: 'p', code: 'KeyP', control: true, alt: true }), key({ type: 'keyUp', key: 'Escape', code: 'Escape' })]) {
      expect(p.onInput(k), JSON.stringify(k)).toBe(false);
    }
    expect(p.active).toBe(true);
    expect(p.onInput(key({ key: 'Escape', code: 'Escape' }))).toBe(true);
    expect(p.active).toBe(false);
    expect(h.log).toEqual(['fullscreen:false', 'mode:edit', 'relayout', 'focus', 'change:false']);
    expect(h.mode).toBe('edit');
    expect(h.fs).toBe(false);
    // Not presenting: Esc is the page's.
    expect(p.onInput(key({ key: 'Escape', code: 'Escape' }))).toBe(false);
  });

  it('a window that was already full screen stays full screen after Present', () => {
    const h = host({ fullScreen: true });
    const p = new Present(h);
    p.enter();
    expect(h.log).not.toContain('fullscreen:true');
    p.exit();
    expect(h.fs).toBe(true);
    expect(h.log).not.toContain('fullscreen:false');
  });

  it('leaving full screen by the system ends Present; the enter animation does not', () => {
    const h = host();
    const p = new Present(h);
    p.enter();
    // macOS: leave-full-screen before enter-full-screen completed is ignored.
    p.onLeaveFullScreen();
    expect(p.active).toBe(true);
    p.onEnterFullScreen();
    h.fs = false;
    p.onLeaveFullScreen();
    expect(p.active).toBe(false);
    expect(h.log.filter((x) => x === 'change:false')).toHaveLength(1);
  });

  it('a held Esc exits once', () => {
    const h = host();
    const p = new Present(h);
    p.enter();
    expect(p.onInput(key({ key: 'Escape', code: 'Escape', isAutoRepeat: true }))).toBe(true);
    expect(p.active).toBe(true);
    expect(p.onInput(key({ key: 'Escape', code: 'Escape' }))).toBe(true);
    expect(p.active).toBe(false);
  });

  it('isPresentExit: exactly Esc, keyDown, no modifier', () => {
    expect(isPresentExit(key({ key: 'Escape', code: 'Escape' }))).toBe(true);
    expect(isPresentExit(key({ key: 'Escape', code: '' }))).toBe(true);
    expect(isPresentExit(key({ key: '', code: 'Escape' }))).toBe(true);
    expect(isPresentExit(key({ key: 'Escape', code: 'Escape', meta: true }))).toBe(false);
    expect(isPresentExit(key({ key: 'Escape', code: 'Escape', alt: true }))).toBe(false);
    expect(isPresentExit(key({ type: 'char', key: 'Escape', code: 'Escape' }))).toBe(false);
  });
});
