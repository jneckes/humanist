// The deck preload's file-drop guard in frames (preload/drop-guard.ts "frames"; SPEC 9.1; review finding 2): a
// drag over an <iframe> goes to that frame's own window, so every frame of a deck view needs the guard. These
// tests use fake windows: the top frame guards the same-origin frames below it (those there already, those that
// load later, nested ones) and guards them again after document.open() erased their listeners; a frame it
// cannot reach (cross-origin) is left to that frame's own preload (guardFrameDrops). The real-Electron checks
// are the E2E and security suites'.

import { describe, expect, it } from 'vitest';
import { guardChildFrames, guardFrameDrops } from '../../../packages/app/src/preload/drop-guard';

type Fn = (e: unknown) => void;
interface L {
  type: string;
  fn: Fn;
  capture: boolean;
}

function add(list: L[], type: string, fn: Fn, opts?: boolean | AddEventListenerOptions): void {
  const capture = opts === true || (typeof opts === 'object' && !!opts?.capture);
  if (list.some((l) => l.type === type && l.fn === fn && l.capture === capture)) return; // as the DOM does
  list.push({ type, fn, capture });
}

interface FakeWin {
  win: Window;
  frames: FakeWin[];
  /** Listeners on the window. */
  wl: L[];
  /** Listeners on its document. */
  dl: L[];
  /** A drag event at this window, capture phase first: returns what the page's later listener saw. */
  drag(type: string, files: boolean): { stopped: boolean; prevented: boolean; dropEffect: string; pageSaw: boolean };
  /** A frame element in this document fires load (the initial about:blank one fires it during insertion). */
  load(child: FakeWin): void;
  /** document.open(): every listener on the window and in the document goes, and the root element is replaced. */
  open(): void;
}

function fakeWin(o: { crossOrigin?: boolean } = {}): FakeWin {
  const wl: L[] = [];
  const dl: L[] = [];
  const observers: { cb: () => void }[] = [];
  const frames: FakeWin[] = [];
  const doc = { addEventListener: (t: string, fn: Fn, opts?: boolean) => add(dl, t, fn, opts) };
  const framesProxy = {
    get length() {
      return frames.length;
    },
  } as Record<string | number, unknown>;
  const win = {
    addEventListener: (t: string, fn: Fn, opts?: boolean) => add(wl, t, fn, opts),
    get document() {
      if (o.crossOrigin) throw new Error('SecurityError: Blocked a frame from accessing a cross-origin frame');
      return doc;
    },
    frames: new Proxy(framesProxy, {
      get: (t, k) => (k === 'length' ? frames.length : typeof k === 'string' && /^\d+$/.test(k) ? frames[Number(k)]?.win : t[k as string]),
    }),
    MutationObserver: class {
      constructor(readonly cb: () => void) {
        observers.push(this);
      }
      observe(): void {}
    },
  };
  const self: FakeWin = {
    win: win as unknown as Window,
    frames,
    wl,
    dl,
    drag(type, files) {
      let stopped = false;
      let prevented = false;
      const e = {
        type,
        isTrusted: true,
        dataTransfer: { types: files ? ['Files'] : ['text/plain'], dropEffect: 'copy' },
        stopImmediatePropagation: () => {
          stopped = true;
        },
        preventDefault: () => {
          prevented = true;
        },
      };
      for (const l of wl.slice()) {
        if (l.type !== type || !l.capture) continue;
        l.fn(e);
        if (stopped) break;
      }
      return { stopped, prevented, dropEffect: e.dataTransfer.dropEffect, pageSaw: !stopped };
    },
    load(child) {
      const e = { type: 'load', target: { tagName: 'IFRAME', contentWindow: child.win } };
      for (const l of dl.slice()) if (l.type === 'load' && l.capture) l.fn(e);
    },
    open() {
      wl.length = 0;
      dl.length = 0;
      for (const ob of observers) ob.cb();
    },
  };
  return self;
}

describe('guardChildFrames (the top frame guards the same-origin frames below it)', () => {
  it('guards a frame that is already there, and one that loads later (the synchronous about:blank load)', () => {
    const top = fakeWin();
    const a = fakeWin();
    top.frames.push(a);
    let notices = 0;
    guardChildFrames(top.win, { onRefused: () => notices++, now: () => 0 });
    // The top window is not touched here (guardDeckFileDrops guards it, with its own notice).
    expect(top.wl).toEqual([]);
    const r = a.drag('drop', true);
    expect(r).toEqual({ stopped: true, prevented: true, dropEffect: 'none', pageSaw: false });
    expect(notices).toBe(1);

    const b = fakeWin();
    top.load(b);
    expect(b.drag('dragenter', true).pageSaw).toBe(false);
    expect(b.drag('dragover', true)).toMatchObject({ prevented: true, dropEffect: 'none' });
  });

  it('leaves drags without files and synthetic drags alone', () => {
    const top = fakeWin();
    const a = fakeWin();
    top.frames.push(a);
    guardChildFrames(top.win);
    expect(a.drag('dragover', false)).toMatchObject({ stopped: false, prevented: false });
    const e = { type: 'drop', isTrusted: false, dataTransfer: { types: ['Files'], dropEffect: 'copy' }, stopImmediatePropagation: () => undefined, preventDefault: () => undefined };
    for (const l of a.wl) if (l.type === 'drop') l.fn(e);
    expect(e.dataTransfer.dropEffect).toBe('copy');
  });

  it('guards nested frames, those there already and those that load later', () => {
    const top = fakeWin();
    const a = fakeWin();
    const a1 = fakeWin();
    a.frames.push(a1);
    top.frames.push(a);
    guardChildFrames(top.win);
    expect(a1.drag('drop', true).pageSaw).toBe(false);
    const a2 = fakeWin();
    a.load(a2);
    expect(a2.drag('drop', true).pageSaw).toBe(false);
  });

  it('guards a frame again after document.open() erased its listeners, and still sees its new frames', () => {
    const top = fakeWin();
    const a = fakeWin();
    top.load(a);
    guardChildFrames(top.win);
    top.load(a);
    a.open();
    expect(a.drag('drop', true).pageSaw).toBe(false);
    const a1 = fakeWin();
    a.load(a1);
    expect(a1.drag('drop', true).pageSaw).toBe(false);
    // The top document's own document.open() is handled by listeners.ts reinstall (listenOn); here the child's.
  });

  it('leaves a cross-origin frame to its own preload (its document cannot be reached)', () => {
    const top = fakeWin();
    const x = fakeWin({ crossOrigin: true });
    top.frames.push(x);
    expect(() => guardChildFrames(top.win)).not.toThrow();
    expect(x.wl).toEqual([]);
  });

  it('says "refused" at most once per quiet period', () => {
    const top = fakeWin();
    const a = fakeWin();
    top.frames.push(a);
    let t = 0;
    let notices = 0;
    guardChildFrames(top.win, { onRefused: () => notices++, now: () => t });
    a.drag('dragenter', true);
    a.drag('drop', true);
    t += 2500;
    a.drag('dragenter', true);
    expect(notices).toBe(2);
  });
});

describe('guardFrameDrops (the preload in a subframe)', () => {
  it('guards its own window and the same-origin frames inside it, with no notice', () => {
    const f = fakeWin();
    const inner = fakeWin();
    f.frames.push(inner);
    guardFrameDrops(f.win);
    expect(f.drag('drop', true)).toEqual({ stopped: true, prevented: true, dropEffect: 'none', pageSaw: false });
    expect(inner.drag('dragover', true).pageSaw).toBe(false);
    f.open();
    expect(f.drag('drop', true).pageSaw).toBe(false);
  });
});
