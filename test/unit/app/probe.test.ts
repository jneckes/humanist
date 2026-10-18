// The mutation probe's judging and loading (SPEC section 10, Mutation probe steps 3-4; PHASE0-FINDINGS F13,
// F17) and the walk's replay after a probe reload. Electron is mocked: these are the parts that run without
// a window. The real-Electron runs are test/e2e/map-walk.spec.ts and map.spec.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

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

import type { EditorModule } from '@blueline/core/capabilities';
import type { CollectResult, DetectResult, FindResult, LocateResult, NodeLocator } from '@blueline/core/ipc';
import { buildMap } from '@blueline/core/mapper';
import { createMatcher } from '@blueline/core/matcher';
import { decodeDeck, encodeDeck } from '@blueline/core/text';
import { createWriteQueue } from '@blueline/editor';
import { sha256Hex } from '../../../packages/app/src/main/atomic-write';
import { DeckWalker } from '../../../packages/app/src/main/map-command';
import { ProbeCopy, ProbeRefused, SENTINEL, batchSentinel, judgeNode, locatorKey, normalizeConsoleMessage, runProbe, type NodeCheck } from '../../../packages/app/src/main/probe';
import type { CountedNode } from '../../../packages/app/src/main/report';
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

// ------------------------------------------------------------------------------------------- fresh origins

describe('every probe load gets a fresh origin (review finding 30; PHASE0-FINDINGS F13)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-probe-origin-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const SRC = '<!doctype html>\n<html><head><title>T</title></head><body>\n<h1>One</h1>\n<p>Two</p>\n<p>Three</p>\n</body></html>\n';
  const bytes = encodeDeck(SRC);
  const version = sha256Hex(bytes);
  const editor: EditorModule = { editorVersion: 'test', createWriteQueue };

  it('loads the copy under a new docId for every run, each one served by the copy and normalized in console messages', async () => {
    const copy = await ProbeCopy.create({ folderReal: dir, fileName: 'deck.html', bytes, trust: () => 'trusted', networkAllowed: () => false, servedProtected: () => false }, '0123456789abcdef');
    const map = buildMap(decodeDeck(bytes).src, { version, utf8: true });
    const matcher = createMatcher(map, { fileName: 'deck.html' });
    const nodes: CountedNode[] = map.runs.map((r, i) => {
      const dn = { stamp: r.stamp, textIndex: r.textIndex, data: r.value, texts: [r.value] };
      return { key: i + 1, slide: 0, stop: 0, locator: { stamp: r.stamp, cssPath: `[data-bl-e="${r.stamp}"]`, childIndex: 0 }, node: dn, match: matcher(dn) };
    });
    const loads: string[] = [];
    let runs: { loc: NodeLocator; data: string }[] = [];
    const view = {
      async load(t: { docId: string; fileName: string }) {
        loads.push(t.docId);
        const m = buildMap(decodeDeck(await copy.read()).src, { version: 'x', utf8: true });
        runs = m.runs.map((r) => ({ loc: { stamp: r.stamp, cssPath: `[data-bl-e="${r.stamp}"]`, childIndex: 0 }, data: r.value }));
      },
      async waitStable() {
        return { fontsReady: true, stillRunning: 0 };
      },
      async detect() {
        return { kind: 'single', count: 1, current: 0, titles: ['T'], navKind: 'none', designSize: { w: 1600, h: 900 } };
      },
      async find(needle: string): Promise<FindResult> {
        return { truncated: false, matches: runs.filter((r) => r.data.includes(needle)).map((r, i) => ({ key: i, locator: r.loc, node: { stamp: r.loc.stamp, textIndex: 0, data: r.data }, visible: true, slide: 0 })) };
      },
      async locate(loc: NodeLocator): Promise<LocateResult> {
        const r = runs.find((x) => locatorKey(x.loc) === locatorKey(loc));
        return r ? { found: true, node: { key: 1, locator: loc, node: { stamp: loc.stamp, textIndex: 0, data: r.data }, rect: { x: 0, y: 0, w: 1, h: 1 } }, visible: true, slide: 0 } : { found: false, node: null, visible: false, slide: null };
      },
      consoleErrors() {
        return [];
      },
    } as unknown as RenderView;
    try {
      const r = await runProbe({
        view,
        editor,
        copy,
        original: { bytes, version },
        nodes,
        slideCount: 1,
        baselineErrors: new Set(),
        normalize: (e) => e.message,
        start: async () => undefined,
        replay: async () => true,
        log: () => undefined,
        interrupted: () => false,
        newDocId: () => randomBytes(8).toString('hex'),
        batchSize: 1,
      });
      expect(r.runs).toBe(3);
      expect(nodes.every((n) => n.probe?.pass === true)).toBe(true);
      // One load per run, each on its own origin: no localStorage, sessionStorage or IndexedDB carries over.
      expect(loads).toHaveLength(3);
      expect(new Set(loads).size).toBe(3);
      expect(loads).not.toContain(copy.docId);
      for (const id of loads) expect(copy.servesDocId(id)).toBe(true);
      expect(copy.servesDocId('fedcba9876543210')).toBe(false);
      // The protocol handler serves a document only under its own docId: each load id gets a view of the copy.
      for (const id of loads) expect(copy.servedAs(id)).toMatchObject({ docId: id, fileName: copy.fileName, folderReal: copy.folderReal });
      expect(copy.servedAs(copy.docId)).toBe(copy);
      expect(copy.servedAs('fedcba9876543210')).toBeUndefined();
      expect(new TextDecoder().decode((await copy.servedAs(loads[0])!.documentBody()).body)).toContain('data-bl-e="bl-1"');
      expect(copy.docIds).toEqual([copy.docId, ...loads]);
      const msg = (id: string) => `Uncaught TypeError at blueline://${id}/.deck.bl-probe.html:3`;
      const norm = (s: string) => normalizeConsoleMessage(s, { docIds: copy.docIds, rename: [[copy.fileName, 'deck.html']] });
      expect(new Set(loads.map((id) => norm(msg(id)))).size).toBe(1);
    } finally {
      copy.removeSync();
    }
  });
});

// ------------------------------------------------------------------------------------------- batches

describe('probe batches: one load for many runs, each run with its own sentinel', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-probe-batch-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const SRC = '<!doctype html>\n<html><head><title>T</title></head><body>\n<h1>One</h1>\n<p>Two</p>\n<p>Three</p>\n</body></html>\n';
  const bytes = encodeDeck(SRC);
  const version = sha256Hex(bytes);
  const editor: EditorModule = { editorVersion: 'test', createWriteQueue };

  /** A fake render view over the copy; `mangle` changes what the page shows after a load. */
  async function probe(name: string, mangle: (runs: { loc: NodeLocator; data: string }[]) => void) {
    const copy = await ProbeCopy.create({ folderReal: dir, fileName: `${name}.html`, bytes, trust: () => 'trusted', networkAllowed: () => false, servedProtected: () => false }, randomBytes(8).toString('hex'));
    const map = buildMap(decodeDeck(bytes).src, { version, utf8: true });
    const matcher = createMatcher(map, { fileName: `${name}.html` });
    const nodes: CountedNode[] = map.runs.map((r, i) => {
      const dn = { stamp: r.stamp, textIndex: r.textIndex, data: r.value, texts: [r.value] };
      return { key: i + 1, slide: 0, stop: 0, locator: { stamp: r.stamp, cssPath: `[data-bl-e="${r.stamp}"]`, childIndex: 0 }, node: dn, match: matcher(dn) };
    });
    const loads: string[] = [];
    let runs: { loc: NodeLocator; data: string }[] = [];
    const view = {
      async load(t: { docId: string; fileName: string }) {
        loads.push(t.docId);
        const m = buildMap(decodeDeck(await copy.read()).src, { version: 'x', utf8: true });
        runs = m.runs.map((r) => ({ loc: { stamp: r.stamp, cssPath: `[data-bl-e="${r.stamp}"]`, childIndex: 0 }, data: r.value }));
        mangle(runs);
      },
      async waitStable() {
        return { fontsReady: true, stillRunning: 0 };
      },
      async detect() {
        return { kind: 'single', count: 1, current: 0, titles: ['T'], navKind: 'none', designSize: { w: 1600, h: 900 } };
      },
      async find(needle: string): Promise<FindResult> {
        return { truncated: false, matches: runs.filter((r) => r.data.includes(needle)).map((r, i) => ({ key: i, locator: r.loc, node: { stamp: r.loc.stamp, textIndex: 0, data: r.data }, visible: true, slide: 0 })) };
      },
      async locate(loc: NodeLocator): Promise<LocateResult> {
        const r = runs.find((x) => locatorKey(x.loc) === locatorKey(loc));
        return r ? { found: true, node: { key: 1, locator: loc, node: { stamp: loc.stamp, textIndex: 0, data: r.data }, rect: { x: 0, y: 0, w: 1, h: 1 } }, visible: true, slide: 0 } : { found: false, node: null, visible: false, slide: null };
      },
      consoleErrors() {
        return [];
      },
    } as unknown as RenderView;
    try {
      const r = await runProbe({
        view,
        editor,
        copy,
        original: { bytes, version },
        nodes,
        slideCount: 1,
        baselineErrors: new Set(),
        normalize: (e) => e.message,
        start: async () => undefined,
        replay: async () => true,
        log: () => undefined,
        interrupted: () => false,
        newDocId: () => randomBytes(8).toString('hex'),
      });
      const after = await copy.read();
      return { r, nodes, loads, restored: Buffer.from(after).equals(Buffer.from(bytes)) };
    } finally {
      copy.removeSync();
    }
  }

  it('gives each run of a batch a sentinel no other contains', () => {
    const s = Array.from({ length: 30 }, (_, j) => batchSentinel(j));
    expect(new Set(s).size).toBe(30);
    for (const a of s) for (const b of s) if (a !== b) expect(b.includes(a)).toBe(false);
    for (const a of s) expect(a.includes(SENTINEL)).toBe(false);
  });

  it('checks three runs on one load, then undoes every write', async () => {
    const { r, nodes, loads, restored } = await probe('batch-pass', () => undefined);
    expect(nodes.every((n) => n.probe?.pass === true)).toBe(true);
    expect(loads).toHaveLength(1);
    expect(r.runs).toBe(3);
    expect(restored).toBe(true);
  });

  it('a write that lands in another node fails on the batch and again on its own', async () => {
    // The page shows the first two runs' texts swapped: each sentinel lands in the other node.
    const { nodes, loads, restored } = await probe('batch-swap', (runs) => {
      if (runs.length >= 2) [runs[0].data, runs[1].data] = [runs[1].data, runs[0].data];
    });
    expect(nodes[0].probe?.pass).toBe(false);
    expect(nodes[1].probe?.pass).toBe(false);
    expect(nodes[2].probe?.pass).toBe(true);
    // One batch load, then one load for each run that failed on it.
    expect(loads).toHaveLength(3);
    const v0 = nodes[0].probe;
    expect(v0 && !v0.pass ? v0.why : '').toMatch(/sentinel/);
    expect(restored).toBe(true);
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
