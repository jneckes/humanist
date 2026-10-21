// The render service's checks of page-controlled results and its key replay (SPEC 6.7 Index replay; section
// 10 map step 3). Electron is mocked: a RenderView here drives a fake webContents, and the render agent's
// replies are answered by a fake deck. The real-Electron runs are test/e2e/render-agent.spec.ts and
// map-walk.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';

vi.mock('electron', () => {
  class FakeWebContents {
    id = 7;
    sent: unknown[] = [];
    inputs: unknown[] = [];
    on() {}
    once() {}
    focus() {}
    isDestroyed() {
      return false;
    }
    send(...a: unknown[]) {
      this.sent.push(a);
    }
    sendInputEvent(e: unknown) {
      this.inputs.push(e);
    }
    async loadURL() {}
    async executeJavaScriptInIsolatedWorld() {
      return { fontsReady: true, stillRunning: 0 };
    }
    close() {}
  }
  class BrowserWindow {
    webContents = new FakeWebContents();
    isDestroyed() {
      return false;
    }
    destroy() {}
  }
  return {
    app: { getName: () => 'Blueline', getVersion: () => '0.0.0', getPath: () => os.tmpdir(), on() {}, once() {}, removeListener() {} },
    BrowserWindow,
    WebContentsView: class {},
    ipcMain: { on() {}, handle() {} },
    protocol: { registerSchemesAsPrivileged() {} },
    session: { fromPartition: () => ({}) },
    nativeTheme: { shouldUseDarkColors: false },
    Menu: {},
    dialog: {},
    shell: {},
  };
});
vi.mock('../../../packages/app/src/main/channels', () => ({ attachDeckView: () => undefined }));
vi.mock('../../../packages/app/src/main/trust-hooks', () => ({ installDeckWebContentsPolicy: () => ({ dispose() {} }) }));

import type { RenderCmd } from '@blueline/core/ipc';
import { RenderCancelled, RenderError, RenderView, disposeRenderer, framesDiffer, renderPolicyTag, rendererFor, renderTargetFor, resultCheck } from '../../../packages/app/src/main/render-service';

// ------------------------------------------------------------------------------------------- results

describe('resultCheck.collect: the walk result is validated and copied in the render service (decision D-b)', () => {
  const wn = (extra: Record<string, unknown> = {}, node: Record<string, unknown> = {}) => ({
    key: 3,
    locator: { stamp: 'bl-2', cssPath: '#a > p:nth-of-type(1)', childIndex: 1 },
    node: { stamp: 'bl-2', textIndex: 1, data: 'Docs', texts: [' / ', 'Docs'], ...node },
    rect: { x: 1, y: 2, w: 3, h: 4 },
    ...extra,
  });

  it("copies the parent's live text nodes (texts), the node's tree and its slide", () => {
    const r = resultCheck.collect({ nodes: [wn({ slide: 2 }), wn({ key: 4, tree: 'shadow', slide: null })], blocks: [{ key: 9, hasInline: true, nodeKeys: [3, 4] }], crossOriginFrames: [11] });
    expect(r.nodes[0]).toEqual({ ...wn({ slide: 2 }) });
    expect(r.nodes[1]).toMatchObject({ key: 4, tree: 'shadow', slide: null });
    expect(r.blocks).toEqual([{ key: 9, hasInline: true, nodeKeys: [3, 4] }]);
    expect(r.crossOriginFrames).toEqual([11]);
    // A copy, not the page's object.
    const src = wn();
    expect(resultCheck.collect({ nodes: [src], blocks: [] }).nodes[0].node.texts).not.toBe(src.node.texts);
  });

  it('omits texts that break the caps or are not strings (the matcher then falls through to step 2)', () => {
    const omitted = (texts: unknown) => resultCheck.collect({ nodes: [wn({}, { texts })], blocks: [] }).nodes[0].node.texts;
    expect(omitted(Array.from({ length: 257 }, () => 'x'))).toBeUndefined();
    expect(omitted(['x'.repeat(256 * 1024 + 1)])).toBeUndefined();
    expect(omitted(['ok', 5])).toBeUndefined();
    expect(omitted('Docs')).toBeUndefined();
    expect(omitted(Array.from({ length: 256 }, () => 'x'))).toHaveLength(256);
  });

  it('keeps the slide index’s block joins when they are whole and well formed, and drops them otherwise (review finding 12)', () => {
    const blocks = [{ key: 9, hasInline: true, nodeKeys: [3, 4] }];
    expect(resultCheck.collect({ nodes: [wn(), wn({ key: 4 })], blocks, joins: [0, 1] }).joins).toEqual([0, 1]);
    expect(resultCheck.collect({ nodes: [wn(), wn({ key: 4 })], blocks, joins: [0] }).joins).toBeUndefined();
    expect(resultCheck.collect({ nodes: [wn(), wn({ key: 4 })], blocks, joins: [0, 3] }).joins).toBeUndefined();
    expect(resultCheck.collect({ nodes: [wn(), wn({ key: 4 })], blocks, joins: 'x' }).joins).toBeUndefined();
    expect(resultCheck.collect({ nodes: [wn()], blocks: [] }).joins).toBeUndefined();
  });

  it('refuses a malformed node, tree or frame list', () => {
    expect(() => resultCheck.collect({ nodes: [wn({ key: -1 })], blocks: [] })).toThrow();
    expect(() => resultCheck.collect({ nodes: [wn({ tree: 'window' })], blocks: [] })).toThrow();
    expect(() => resultCheck.collect({ nodes: [], blocks: [], crossOriginFrames: ['a'] })).toThrow();
    expect(() => resultCheck.collect({ nodes: [{ ...wn(), locator: { stamp: 'evil"]', cssPath: 'p', childIndex: 0 } }], blocks: [] })).toThrow();
  });

  it('find reports whether a match is clipped to a zero area and its tree (review findings 31, 32)', () => {
    const m = { key: 1, locator: { stamp: null, cssPath: 'div', childIndex: 0 }, node: { stamp: null, textIndex: 0, data: 'x' }, visible: false, slide: null };
    const r = resultCheck.find({ truncated: false, matches: [{ ...m, clipped: true }, { ...m, clipped: false, tree: 'frame' }] });
    expect(r.matches.map((x) => [x.clipped, x.tree])).toEqual([
      [true, undefined],
      [false, 'frame'],
    ]);
    expect(() => resultCheck.find({ truncated: false, matches: [{ ...m, clipped: 'yes' }] })).toThrow();
  });
});

// ------------------------------------------------------------------------------------------- keys

/**
 * A RenderView whose agent replies come from a fake generic deck. `counterSees` decides whether the trusted
 * keydown counter sees a key (false: a page window-capture listener hid it, as the old lazily injected counter
 * allowed); `trustedMoves` whether trusted input moves the deck.
 */
function viewOnDeck(opts: { counterSees: boolean; trustedMoves: boolean; syntheticMoves: boolean }) {
  const view = RenderView.create({ partition: 'p', preload: 'x.cjs', folderReal: '/tmp', isProtected: () => false, networkOpen: () => false });
  const deck = { cur: 0, count: 5, trusted: 0, synthetic: 0 };
  const wc = view.wc as unknown as { sendInputEvent(e: { type: string }): void; executeJavaScriptInIsolatedWorld(id: number, s: { code: string }[]): Promise<unknown> };
  // A counter injected into the page after its scripts ran (the old world-1029 counter) sees what counterSees says.
  wc.executeJavaScriptInIsolatedWorld = async (_id, s) => (s[0].code.includes('__blRenderKeys') ? deck.trusted : { fontsReady: true, stillRunning: 0 });
  wc.sendInputEvent = (e) => {
    if (e.type !== 'keyDown') return;
    if (opts.counterSees) deck.trusted++;
    if (opts.trustedMoves && deck.cur < deck.count - 1) deck.cur++;
  };
  view.request = async (cmd: RenderCmd) => {
    switch (cmd.type) {
      case 'current':
        return { current: deck.cur, count: deck.count, hash: '', scrollY: 0, reveal: null };
      case 'detect':
        return { kind: 'generic', count: deck.count, current: deck.cur, titles: ['1', '2', '3', '4', '5'], navKind: 'index', designSize: { w: 1600, h: 900 } };
      case 'keydowns':
        return { trusted: deck.trusted, all: deck.trusted + deck.synthetic };
      case 'key':
        deck.synthetic++;
        if (opts.syntheticMoves && deck.cur < deck.count - 1) deck.cur++;
        return { dispatched: true, current: deck.cur };
      default:
        throw new Error(`unexpected ${cmd.type}`);
    }
  };
  return { view, deck };
}

describe('RenderView.pressKey: trusted keys (review finding 33; 6.7 Index replay)', () => {
  it('never falls back to synthetic keys after a trusted key that moved the deck', async () => {
    // stopimm.html: the page's window capture listener calls stopImmediatePropagation, so a counter behind it
    // never sees the key, but trusted input moved the deck; it ignores synthetic keys.
    const { view, deck } = viewOnDeck({ counterSees: false, trustedMoves: true, syntheticMoves: false });
    const first = await view.pressKey('ArrowRight', { settleMs: 0 });
    expect(first).toMatchObject({ from: 0, to: 1, moved: true, via: 'input' });
    expect(view.trustedKeys).not.toBe(false);
    const second = await view.pressKey('ArrowRight', { settleMs: 0 });
    expect(second).toMatchObject({ from: 1, to: 2, moved: true, via: 'input' });
    expect(deck.synthetic).toBe(0);
  });

  it('reads the trusted-keydown counter with a render command, and falls back only when trusted keys never arrive', async () => {
    const { view, deck } = viewOnDeck({ counterSees: false, trustedMoves: false, syntheticMoves: true });
    const p = await view.pressKey('ArrowRight', { settleMs: 0 });
    expect(p).toMatchObject({ via: 'synthetic', delivered: false, moved: true });
    expect(view.trustedKeys).toBe(false);
    expect(deck.synthetic).toBe(1);
    const ok = viewOnDeck({ counterSees: true, trustedMoves: true, syntheticMoves: false });
    expect(await ok.view.pressKey('ArrowRight', { settleMs: 0 })).toMatchObject({ via: 'input', delivered: true, moved: true });
    expect(ok.view.trustedKeys).toBe(true);
  });

  it('forgets what it learnt about keys on every load (a probe reload is a new page)', async () => {
    const { view } = viewOnDeck({ counterSees: false, trustedMoves: false, syntheticMoves: true });
    await view.pressKey('ArrowRight', { settleMs: 0 });
    expect(view.trustedKeys).toBe(false);
    await view.load({ docId: '0123456789abcdef', fileName: 'deck.html' });
    expect(view.trustedKeys).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------- scripted settle

describe('RenderView.waitScripted: what scripts reveal after a slide arrives (decision D-5)', () => {
  /**
   * A view whose page mutates at the given times (ms after the wait starts), read through main's own world;
   * `frame(ms)` is the picture's brightness at that time (a canvas a script draws on, no DOM change).
   */
  function viewMutating(at: number[], frame: (ms: number) => number = () => 128) {
    const view = RenderView.create({ partition: 'p', preload: 'x.cjs', folderReal: '/tmp', isProtected: () => false, networkOpen: () => false });
    const t0 = Date.now();
    const wc = view.wc as unknown as { executeJavaScriptInIsolatedWorld(id: number, s: { code: string }[]): Promise<unknown>; capturePage(): Promise<unknown> };
    wc.capturePage = async () => {
      const v = frame(Date.now() - t0);
      const small = { toBitmap: () => Buffer.alloc(64 * 36 * 4, v) };
      return { isEmpty: () => false, resize: () => small };
    };
    wc.executeJavaScriptInIsolatedWorld = async (_id, s) => {
      const now = Date.now() - t0;
      const last = Math.max(0, ...at.filter((m) => m <= now));
      if (s[0].code.includes('return true')) return true; // the observer is installed
      if (s[0].code.includes('performance.now()-m.last')) return [now - last, last];
      if (s[0].code.includes('return m?m.last')) return last;
      return null;
    };
    return view;
  }

  it('says a change came after a pause (late) when the DOM changes again after being still for 200 ms', async () => {
    const r = await viewMutating([0, 400]).waitScripted({ minMs: 600, quietMs: 300, maxMs: 2000 });
    expect(r).toMatchObject({ quiet: true, late: true });
    expect(r.stamp).toBe(400);
  });

  it('a slide whose changes all come close together is not late, and a quiet-only wait ends at its quiet point', async () => {
    const dense = await viewMutating([0, 100, 200, 300]).waitScripted({ minMs: 600, quietMs: 300, maxMs: 2000 });
    expect(dense).toMatchObject({ quiet: true, late: false, stamp: 300 });
    const quiet = await viewMutating([0]).waitScripted({ minMs: 0, quietMs: 300, maxMs: 2000 });
    expect(quiet).toMatchObject({ quiet: true, late: false });
    expect(quiet.waitedMs).toBeLessThan(600);
  });

  it('a picture that still changes while the DOM is still (a canvas a script draws on) is late too', async () => {
    const r = await viewMutating([0], (ms) => (ms < 500 ? 40 : 200)).waitScripted({ minMs: 700, quietMs: 300, maxMs: 2000 });
    expect(r).toMatchObject({ quiet: true, late: true });
    const still = await viewMutating([0], () => 90).waitScripted({ minMs: 700, quietMs: 300, maxMs: 2000 });
    expect(still).toMatchObject({ quiet: true, late: false });
    // Without frames to compare (watchFrames off), only the DOM counts.
    expect(await viewMutating([0], (ms) => (ms < 500 ? 40 : 200)).waitScripted({ minMs: 700, quietMs: 300, maxMs: 2000, watchFrames: false })).toMatchObject({ late: false });
  });

  it('framesDiffer: more than 0.2% of the pixels changed, or a frame missing', () => {
    const a = new Uint8Array(64 * 36 * 4).fill(100);
    const b = a.slice();
    expect(framesDiffer(a, b)).toBe(false);
    for (let i = 0; i < 4 * 4; i += 4) b[i] = 200; // 4 pixels of 2,304: 0.17%
    expect(framesDiffer(a, b)).toBe(false);
    for (let i = 0; i < 8 * 4; i += 4) b[i] = 200; // 8 pixels: 0.35%
    expect(framesDiffer(a, b)).toBe(true);
    expect(framesDiffer(null, a)).toBe(true);
    expect(framesDiffer(a, a.subarray(4))).toBe(true);
  });

  it('a page that never goes quiet is waited for up to the cap', async () => {
    const ticks = Array.from({ length: 40 }, (_, i) => i * 50);
    const r = await viewMutating(ticks).waitScripted({ minMs: 100, quietMs: 300, maxMs: 700 });
    expect(r.quiet).toBe(false);
    expect(r.waitedMs).toBeGreaterThanOrEqual(700);
  });
});

describe('renderPolicyTag: the product cache keys on the trust policy (review finding 15)', () => {
  it('differs when the network is open vs blocked, and with the strict option and the allowlist', () => {
    const blocked = renderPolicyTag(false, false, ['a.example']);
    const open = renderPolicyTag(true, false, ['a.example']);
    expect(open).not.toBe(blocked);
    // Same inputs give the same tag; the allowlist order does not matter.
    expect(renderPolicyTag(false, false, ['a.example'])).toBe(blocked);
    expect(renderPolicyTag(false, false, ['b.example', 'a.example'])).toBe(renderPolicyTag(false, false, ['a.example', 'b.example']));
    // The strict option and the allowlist contents each change it.
    expect(renderPolicyTag(false, true, ['a.example'])).not.toBe(blocked);
    expect(renderPolicyTag(false, false, ['a.example', 'c.example'])).not.toBe(blocked);
  });

  it('renderTargetFor gives a Protected target a different tag from a Trusted one', () => {
    const base = {
      docId: 'd', fileName: 'x.html', partition: 'persist:x', folderReal: '/f', realpath: '/f/x.html',
      fileKey: '0123456789abcdef', version: 'a'.repeat(64), title: '', marker: null,
      networkAllowed: () => false, strict: () => false, allowlist: () => ['a.example'],
    };
    const prot = renderTargetFor({ ...base, trust: () => 'protected' as const });
    const trust = renderTargetFor({ ...base, trust: () => 'trusted' as const });
    expect(prot.renderPolicyTag()).not.toBe(trust.renderPolicyTag());
  });
});

// ------------------------------------------------------------------------------------------- a view closed mid-job

describe('a render view closed mid-job ends the job as RenderCancelled (never a failure or an "overlay mounted" refusal)', () => {
  const newView = () => RenderView.create({ partition: 'p', preload: 'x.cjs', folderReal: '/tmp', isProtected: () => false, networkOpen: () => false });
  type Probe = (world: number, code: { code: string }[]) => Promise<unknown>;
  const probe = (v: RenderView, fn: Probe) => {
    (v.wc as unknown as { executeJavaScriptInIsolatedWorld: Probe }).executeJavaScriptInIsolatedWorld = fn;
  };

  it('a probe running when the view closes rejects with RenderCancelled, overlayMounted included', async () => {
    const v = newView();
    probe(v, () => new Promise(() => undefined)); // the page never answers (a closing renderer)
    const mounted = v.overlayMounted();
    const stable = v.waitStable();
    const title = v.documentTitle();
    v.close();
    await expect(mounted).rejects.toBeInstanceOf(RenderCancelled);
    await expect(stable).rejects.toBeInstanceOf(RenderCancelled);
    await expect(title).rejects.toBeInstanceOf(RenderCancelled);
  });

  it('a probe that answers after the close does not count: the view is closed', async () => {
    const v = newView();
    let answer: (x: unknown) => void = () => undefined;
    probe(v, () => new Promise((r) => (answer = r)));
    const mounted = v.overlayMounted();
    v.close();
    answer(false);
    await expect(mounted).rejects.toBeInstanceOf(RenderCancelled);
  });

  it('every call on a closed view rejects with RenderCancelled', async () => {
    const v = newView();
    v.close();
    for (const call of [
      () => v.overlayMounted(),
      () => v.waitStable(),
      () => v.documentTitle(),
      () => v.capture(),
      () => v.detect(),
      () => v.printToPDF({}),
      () => v.load({ docId: '0123456789abcdef', fileName: 'x.html' }),
      () => v.cdp('DOM.enable'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(RenderCancelled);
    }
    // The class carries its own name (what a caller across IPC or a log sees).
    expect(new RenderCancelled('x').name).toBe('RenderCancelled');
    expect(new RenderCancelled('x')).toBeInstanceOf(RenderError);
  });

  it('on a live view a probe that cannot answer still counts as "mounted" (when unsure, refuse)', async () => {
    const v = newView();
    probe(v, async () => {
      throw new Error('the page threw');
    });
    expect(await v.overlayMounted()).toBe(true);
    probe(v, async () => false);
    expect(await v.overlayMounted()).toBe(false);
    v.close();
  });

  it('rendererFor: a job whose document closed gets RenderCancelled, never a new renderer of the closed document', () => {
    const host = { preload: 'x.cjs', userData: os.tmpdir(), log: () => undefined };
    const doc = {
      docId: '00112233445566aa', fileName: 'x.html', partition: 'persist:x', folderReal: '/f', realpath: '/f/x.html',
      fileKey: '0123456789abcdef', version: 'a'.repeat(64), title: '', marker: null,
      trust: () => 'trusted' as const, networkAllowed: () => false,
    };
    const job = renderTargetFor(doc);
    const r = rendererFor(job, host);
    expect(rendererFor(job, host)).toBe(r);
    disposeRenderer(doc.docId);
    expect(r.closed).toBe(true);
    // The job's next stage (a PDF's raster walk after its print-CSS try) asks again: cancelled.
    expect(() => rendererFor(job, host)).toThrow(RenderCancelled);
    // The same file opened again (a Trusted file keeps its docId) comes with targets of its own: served.
    const reopened = rendererFor(renderTargetFor(doc), host);
    expect(reopened).not.toBe(r);
    expect(reopened.closed).toBe(false);
    disposeRenderer(doc.docId);
  });
});
