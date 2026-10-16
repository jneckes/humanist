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
import { RenderView, resultCheck } from '../../../packages/app/src/main/render-service';

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
