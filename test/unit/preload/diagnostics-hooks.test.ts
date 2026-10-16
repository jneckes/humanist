// KeyOrderProbe (diagnostics-hooks.ts; SPEC section 10 Diagnostics, 6.2 last paragraph; finding 15). The
// reveal fixture's capture listeners count keydowns in data-bl-key-log; the probe compares the count when the
// router runs with the count when the previous keydown's dispatch ended. Input events outrank timers, so two
// keydowns can be dispatched before any timer runs (Wispr Flow's Cmd+V): the end of a dispatch must be read
// synchronously, not in the deferred report.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyOrderProbe } from '../../../packages/app/src/preload/diagnostics-hooks';
import type { KeyAction } from '../../../packages/app/src/preload/key-router';

type Handler = (e: unknown) => void;

function fakeWindow() {
  const listeners: { type: string; fn: Handler; capture: boolean }[] = [];
  return {
    listeners,
    addEventListener(type: string, fn: Handler, opts?: boolean | AddEventListenerOptions) {
      listeners.push({ type, fn, capture: opts === true || (typeof opts === 'object' && !!opts.capture) });
    },
    /** Window's bubble phase of an event (capture listeners ran earlier, in the router's place). */
    bubble(type: string, e: unknown) {
      for (const l of listeners) if (l.type === type && !l.capture) l.fn(e);
    },
  };
}

/**
 * A page whose capture listeners count keydowns as the reveal fixture does, and a dispatcher that runs the
 * router (KeyOrderProbe.onDecision) first, then the page's listeners unless the router stopped the key, then
 * window's bubble phase.
 */
function setup() {
  const dataset: Record<string, string> = {};
  const doc = { documentElement: { dataset } };
  const win = fakeWindow();
  const sent: { event: string; data: Record<string, unknown> }[] = [];
  const probe = new KeyOrderProbe(doc as unknown as Document, (event, data) => sent.push({ event, data }), win as unknown as Window);
  let seq = 0;
  const pageListener = (e: { key: string }) => {
    seq += 1;
    dataset.blKeyLog = `${seq}:${e.key}:true`;
  };
  const press = (key: string, o: { consumed?: boolean; pageFirst?: boolean; pageStops?: boolean } = {}) => {
    const e = { key, code: `Key${key.toUpperCase()}`, isTrusted: true };
    const action: KeyAction = o.consumed ? { kind: 'shortcut', action: 'next-pin' } : { kind: 'pass' };
    if (o.pageFirst) pageListener(e);
    probe.onDecision(e as unknown as KeyboardEvent, action, !!o.consumed);
    if (o.consumed) return; // stopImmediatePropagation: nothing else runs
    if (!o.pageFirst) pageListener(e);
    if (!o.pageStops) win.bubble('keydown', e);
  };
  const order = () => sent.filter((s) => s.event === 'key-order').map((s) => `${s.data.key}:${s.data.first}`);
  const stops = () => sent.filter((s) => s.event === 'stop-propagation').map((s) => `${s.data.key}:${s.data.pageListenerRan}`);
  return { press, order, stops, win };
}

describe('KeyOrderProbe (finding 15)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers a bubble-phase keydown listener on window', () => {
    const { win } = setup();
    expect(win.listeners.map((l) => [l.type, l.capture])).toEqual([['keydown', false]]);
  });

  it('two keydowns dispatched before the timers run (Cmd+V) both report the preload first', () => {
    const { press, order } = setup();
    press('Control');
    press('v');
    vi.runAllTimers();
    expect(order()).toEqual(['Control:preload', 'v:preload']);
  });

  it('with a gap between keys it reports the preload first, as before', () => {
    const { press, order } = setup();
    press('Shift');
    vi.runAllTimers();
    press('x');
    vi.runAllTimers();
    expect(order()).toEqual(['Shift:preload', 'x:preload']);
  });

  it('still reports the page first when the page listener did run before the router', () => {
    const { press, order } = setup();
    press('a');
    press('b', { pageFirst: true });
    vi.runAllTimers();
    expect(order()).toEqual(['a:preload', 'b:page']);
  });

  it('a stopped key followed at once by a key the page sees: the stopped key reports no page listener', () => {
    const { press, order, stops } = setup();
    press('k', { consumed: true });
    press('ArrowLeft');
    vi.runAllTimers();
    expect(stops()).toEqual(['k:false']);
    expect(order()).toEqual(['k:preload', 'ArrowLeft:preload']);
  });

  it('a page listener that stops a key before window bubble: the deferred read still catches up when no key follows', () => {
    const { press, order } = setup();
    press('a', { pageStops: true });
    vi.runAllTimers();
    press('b');
    vi.runAllTimers();
    expect(order()).toEqual(['a:preload', 'b:preload']);
  });
});
