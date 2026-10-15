import { describe, expect, it, vi } from 'vitest';
import { KeyRouter, type KeyRouterDeps, type TextFieldKind } from '../../../packages/app/src/preload/key-router';

type Handler = (e: unknown) => void;

function fakeWindow() {
  const listeners: { type: string; fn: Handler; capture: boolean }[] = [];
  return {
    listeners,
    addEventListener(type: string, fn: Handler, capture?: boolean) {
      listeners.push({ type, fn, capture: capture === true });
    },
    fire(type: string, e: unknown) {
      for (const l of listeners) if (l.type === type) l.fn(e);
    },
  };
}

function fakeKey(code: string, o: Partial<{ key: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; trusted: boolean; target: unknown }> = {}) {
  return {
    code,
    key: o.key ?? code,
    metaKey: !!o.meta,
    ctrlKey: !!o.ctrl,
    altKey: !!o.alt,
    shiftKey: !!o.shift,
    isTrusted: o.trusted ?? true,
    repeat: false,
    isComposing: false,
    target: o.target ?? null,
    composedPath: () => [o.target ?? 'body'],
    stopImmediatePropagation: vi.fn(),
    preventDefault: vi.fn(),
  };
}

function setup(mode: 'read' | 'review' | 'edit', field: TextFieldKind | null = null) {
  const win = fakeWindow();
  const deps: KeyRouterDeps = {
    appMode: () => mode,
    textFieldOf: () => field,
    onAction: vi.fn(),
    onDeckKey: vi.fn(),
    onDecision: vi.fn(),
  };
  new KeyRouter(win as unknown as Window, deps).install();
  return { win, deps };
}

describe('KeyRouter on events (6.2)', () => {
  it('registers capture-phase listeners on window', () => {
    const { win } = setup('read');
    expect(win.listeners.map((l) => [l.type, l.capture])).toEqual([
      ['keydown', true],
      ['keypress', true],
      ['keyup', true],
    ]);
  });

  it('in a text field stops propagation but never prevents the default (typing, undo, paste work)', () => {
    const { win, deps } = setup('review', 'card');
    const e = fakeKey('KeyN', { key: 'n' });
    win.fire('keydown', e);
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(deps.onAction).not.toHaveBeenCalled();
    // Its keypress and keyup are kept from the deck too.
    const p = fakeKey('KeyN');
    win.fire('keypress', p);
    expect(p.stopImmediatePropagation).toHaveBeenCalled();
    const u = fakeKey('KeyN');
    win.fire('keyup', u);
    expect(u.stopImmediatePropagation).toHaveBeenCalled();
    const v = fakeKey('KeyV', { meta: true });
    win.fire('keydown', v);
    expect(v.preventDefault).not.toHaveBeenCalled();
  });

  it('runs a Review shortcut, then stops and prevents it', () => {
    const { win, deps } = setup('review');
    const e = fakeKey('Digit1', { key: '1' });
    win.fire('keydown', e);
    expect(deps.onAction).toHaveBeenCalledWith('tool-pen', e);
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('forwards arrows untouched and reports them as deck keys', () => {
    const { win, deps } = setup('review');
    const e = fakeKey('ArrowRight', { key: 'ArrowRight' });
    win.fire('keydown', e);
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(deps.onDeckKey).toHaveBeenCalledWith(e);
    const u = fakeKey('ArrowRight');
    win.fire('keyup', u);
    expect(u.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('touches nothing for untrusted events and Cmd chords', () => {
    const { win, deps } = setup('review');
    const s = fakeKey('KeyN', { trusted: false });
    win.fire('keydown', s);
    const c = fakeKey('KeyV', { meta: true });
    win.fire('keydown', c);
    for (const e of [s, c]) {
      expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(deps.onAction).not.toHaveBeenCalled();
    expect(deps.onDeckKey).not.toHaveBeenCalled();
  });

  it('gives the active edit Enter and Esc', () => {
    const { win, deps } = setup('edit', 'edit');
    const e = fakeKey('Enter');
    win.fire('keydown', e);
    expect(deps.onAction).toHaveBeenCalledWith('commit-edit', e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
