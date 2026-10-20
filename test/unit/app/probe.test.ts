// The mutation probe's judging and loading (SPEC section 10, Mutation probe steps 3-4; PHASE0-FINDINGS F13,
// F17) and the walk's replay after a probe reload. Electron is mocked: these are the parts that run without
// a window. The real-Electron runs are test/e2e/map-walk.spec.ts and map.spec.ts. The probe's loads and batches
// through the real patcher are in probe.edit.test.ts (they need the editor, P2-15).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { getName: () => 'Blueline', getVersion: () => '0.0.0', getPath: () => os.tmpdir(), on() {}, once() {}, removeListener() {} },
  BrowserWindow: class {},
  WebContentsView: class {},
  ipcMain: { on() {}, handle() {} },
  protocol: { registerSchemesAsPrivileged() {} },
  session: { fromPartition: () => ({}) },
  nativeTheme: { shouldUseDarkColors: false },
  Menu: {},
  dialog: {},
  shell: {},
}));

import type { CollectResult, DetectResult, FindResult, NodeLocator } from '@blueline/core/ipc';
import { encodeDeck } from '@blueline/core/text';
import { DeckWalker } from '../../../packages/app/src/main/map-command';
import { ProbeCopy, ProbeRefused, SENTINEL, judgeNode, locatorKey, type NodeCheck } from '../../../packages/app/src/main/probe';
import type { KeyPress, NavKey, RenderView } from '../../../packages/app/src/main/render-service';

// ------------------------------------------------------------------------------------------- judgeNode

describe('judgeNode: other nodes holding the sentinel (review finding 31; PHASE0-FINDINGS F17)', () => {
  const self: NodeLocator = { stamp: 'bl-1', cssPath: '#t', childIndex: 0 };
  const twin: NodeLocator = { stamp: null, cssPath: 'html > body:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(1)', childIndex: 0 };
  type Match = FindResult['matches'][number];
  const m = (loc: NodeLocator, data: string, extra: Partial<Match> = {}): Match => ({ key: 2, locator: loc, node: { stamp: loc.stamp, textIndex: 0, data }, visible: false, slide: null, ...extra });
  const check = (other: Match, reported: NodeLocator[] = [self]): NodeCheck => ({
    reached: true,
    slideCountBefore: 1,
    slideCountAfter: 1,
    located: { found: true, node: { key: 1, locator: self, node: { stamp: 'bl-1', textIndex: 0, data: `Quarterly results${SENTINEL}` }, rect: { x: 0, y: 0, w: 1, h: 1 } }, visible: true, slide: 0 },
    found: { truncated: false, matches: [m(self, `Quarterly results${SENTINEL}`, { visible: true, slide: 0 }), other] },
    self,
    sameRun: new Set(),
    reported: new Set(reported.map(locatorKey)),
    newErrors: [],
  });

  it('fails a node whose sentinel also lands in a display:none copy the walk never counted (hiddendup.html)', () => {
    const v = judgeNode(check(m(twin, `Quarterly results${SENTINEL}`, { visible: false, clipped: false })));
    expect(v.pass).toBe(false);
    expect(v).toMatchObject({ why: expect.stringContaining('the report does not count') });
    expect(v).toMatchObject({ why: expect.stringContaining('Quarterly results⟦bl⟧') });
  });

  it('fails on an opacity-0 reveal.js fragment, off-viewport text and a node on a slide the walk never showed', () => {
    expect(judgeNode(check(m(twin, `Recap: x${SENTINEL}`, { visible: false, clipped: false, slide: 0 }))).pass).toBe(false);
    expect(judgeNode(check(m(twin, `Footer: x${SENTINEL}`, { visible: false }))).pass).toBe(false);
    const v = judgeNode(check(m(twin, `x${SENTINEL}`, { visible: false, slide: 3 })));
    expect(v).toMatchObject({ pass: false, why: expect.stringContaining('on slide 4') });
  });

  it('skips only a node clipped to a zero area that the walk never counted (reveal.js .aria-status)', () => {
    const live: NodeLocator = { stamp: null, cssPath: 'div.aria-status', childIndex: 0 };
    expect(judgeNode(check(m(live, `Quarterly results${SENTINEL} more`, { clipped: true })))).toEqual({ pass: true });
    // A clipped node the walk did count elsewhere is a reported node like any other.
    expect(judgeNode(check(m(live, `Quarterly results${SENTINEL}`, { clipped: true }), [self, live])).pass).toBe(false);
  });

  it('fails when the sentinel lands in a shadow root or a frame (review finding 32)', () => {
    const inShadow: NodeLocator = { stamp: null, cssPath: 'stat-card:nth-of-type(1) >>> span', childIndex: 0 };
    const v = judgeNode(check(m(inShadow, `Quarterly results${SENTINEL} this year`, { visible: true, tree: 'shadow' }), [self, inShadow]));
    expect(v).toMatchObject({ pass: false, why: expect.stringContaining('shadow root') });
    const inFrame: NodeLocator = { stamp: null, cssPath: '#f >>frame>> html > body:nth-of-type(1) > p:nth-of-type(1)', childIndex: 0 };
    expect(judgeNode(check(m(inFrame, `x${SENTINEL}`, { visible: true, tree: 'frame' }), [self, inFrame])).pass).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- derived file

describe('the probe copy keeps the deck’s internet marker (9.9 Derived files keep the marker)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-probe-marker-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = encodeDeck('<!doctype html><title>T</title><h1>One</h1>\n');
  const deck = (trust: 'protected' | 'trusted', marker: string | null) => ({
    folderReal: dir,
    fileName: 'deck.html',
    bytes,
    trust: () => trust,
    networkAllowed: () => false,
    servedProtected: () => trust === 'protected',
    realpath: path.join(dir, 'deck.html'),
    marker,
  });

  it('marks the copy with the deck’s marker and trust right after it is created, before any of the deck’s bytes is written (review finding 30)', async () => {
    const seen: unknown[] = [];
    let sizeAtMark = -1;
    const copy = await ProbeCopy.create(deck('protected', '0083;65f1c2a3;Safari;'), '0123456789abcdef', {
      mark: async (c, src) => {
        // A run killed from here on leaves a marked copy, never the deck's bytes without the marker.
        sizeAtMark = fs.statSync(c).size;
        seen.push({ c, ...src });
      },
    });
    try {
      expect(sizeAtMark).toBe(0);
      expect(seen).toEqual([{ c: copy.path, realpath: path.join(dir, 'deck.html'), marker: '0083;65f1c2a3;Safari;', protectedView: true }]);
      expect(fs.readFileSync(copy.path)).toEqual(Buffer.from(bytes));
    } finally {
      copy.removeSync();
    }
  });

  it('a copy whose marker cannot be written is removed, and the probe is refused', async () => {
    const name = path.join(dir, '.deck.bl-probe.html');
    await expect(
      ProbeCopy.create(deck('protected', null), 'fedcba9876543210', {
        mark: async () => {
          throw new Error('helper down');
        },
      }),
    ).rejects.toBeInstanceOf(ProbeRefused);
    expect(fs.existsSync(name)).toBe(false);
  });

  it('without the deck’s realpath (older callers) nothing is marked', async () => {
    let called = false;
    const { realpath: _r, marker: _m, ...plain } = deck('trusted', null);
    const copy = await ProbeCopy.create(plain, '00112233445566aa', { mark: async () => void (called = true) });
    expect(called).toBe(false);
    copy.removeSync();
  });
});


// ------------------------------------------------------------------------------------------- replay

/** A generic deck that can resume where an earlier load left it (localStorage, review-map/resume.html). */
function fakeDeck(count: number) {
  const deck = { cur: 0, openAt: 0, loads: 0, presses: [] as string[] };
  const press = (key: NavKey): KeyPress => {
    const from = deck.cur;
    if (key === 'ArrowRight' && deck.cur < count - 1) deck.cur++;
    if (key === 'ArrowLeft' && deck.cur > 0) deck.cur--;
    deck.presses.push(key);
    return { key, from, to: deck.cur, moved: deck.cur !== from, via: 'input', delivered: true, navOk: deck.cur !== from };
  };
  const view = {
    viewport: { w: 1600, h: 900, dpr: 2 },
    async load() {
      deck.loads++;
      deck.cur = deck.openAt;
    },
    async waitStable() {
      return { fontsReady: true, stillRunning: 0 };
    },
    async detect(): Promise<DetectResult> {
      return { kind: 'generic', count, current: deck.cur, titles: Array.from({ length: count }, (_, i) => `S${i + 1}`), navKind: 'index', designSize: { w: 1600, h: 900 } };
    },
    async collect(): Promise<CollectResult> {
      const k = deck.cur + 1;
      return { nodes: [{ key: k, locator: { stamp: `bl-${k}`, cssPath: 'h1', childIndex: 0 }, node: { stamp: `bl-${k}`, textIndex: 0, data: `S${k}` }, rect: { x: 0, y: 0, w: 1, h: 1 } }], blocks: [] };
    },
    async pressKey(key: NavKey) {
      return press(key);
    },
    async goto() {
      return { navigated: false, current: deck.cur, navKind: 'index', reason: 'index' };
    },
    consoleErrors() {
      return [];
    },
  };
  return { deck, view: view as unknown as RenderView };
}

describe('after a probe reload the walk replays from slide 1 (review finding 30)', () => {
  it('a generic deck that reopens on another slide is brought back to slide 1 before its keys are replayed', async () => {
    const { deck, view } = fakeDeck(4);
    const walker = new DeckWalker(view, () => undefined);
    const walk = await walker.walk({ docId: '0123456789abcdef', fileName: 'deck.html' });
    expect(walk.reached).toEqual([true, true, true, true]);
    // The walk opened on slide 1; a later load resumes on slide 3 (the deck stored where it was).
    for (let stop = 0; stop < walk.stops.length; stop++) {
      deck.openAt = 2;
      await view.load({ docId: 'fedcba9876543210', fileName: 'deck.html' });
      await walker.startReplay();
      expect(deck.cur).toBe(0);
      expect(await walker.replay(stop)).toBe(true);
      expect(deck.cur).toBe(walk.stops[stop].slide);
    }
  });
});
