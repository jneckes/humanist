// The slide index's pure parts (6.9 design size, titles, nav; 6.7 Index replay keys and the 300 ms quiet
// wait; the per-document pool of render windows; the cache file) and the slide visits against a fake render
// view. Real-Electron runs: test/e2e/render-products-index.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { getName: () => 'Blueline', getPath: () => os.tmpdir(), getLocale: () => 'en-US', getSystemLocale: () => 'en-US', getLocaleCountryCode: () => '', on() {}, once() {}, removeListener() {}, isPackaged: false },
  BrowserWindow: class {},
  WebContentsView: class {},
  ipcMain: { on() {}, handle() {} },
  protocol: { registerSchemesAsPrivileged() {} },
  session: { fromPartition: () => ({}) },
  nativeTheme: { shouldUseDarkColors: false },
}));

import type { SlideIndex } from '@blueline/core/ipc-render';
import {
  ACCELERATOR_KEY,
  acceleratorKeyFor,
  isAgentNavKey,
  isNavKey,
  navKeyFor,
  noteDocumentWrite,
  outlineOf,
  quietDelay,
  renderTargetFor,
  resultCheck,
  untilQuiet,
  ViewSlots,
  type KeyPress,
  type NavKey,
  type RenderTarget,
  type RenderView,
} from '../../../packages/app/src/main/render-service';
import {
  chooseDesignSize,
  collapse,
  deckEntries,
  documentEntries,
  indexFileName,
  parseSlideIndex,
  indexWalkTakesThumbs,
  noteJoins,
  pressPatiently,
  pruneOtherIndexFiles,
  QUIET_SETTLE,
  RAIL_THUMB_WIDTH,
  replayKeys,
  SCRIPTED_SETTLE,
  SettleMemory,
  settleMemoryFor,
  slideTitleFor,
  textBySlide,
  thumbsDir,
  trimLine,
  visitSlides,
  waitAdaptive,
  type NodeJoins,
  type ScriptedSettle,
} from '../../../packages/app/src/main/slide-index';

const V = 'a'.repeat(64);

describe('6.7 Index replay keys (acceleratorKeyFor; PHASE0-FINDINGS Still open)', () => {
  it('maps ArrowDown to Down and ArrowUp to Up', () => {
    expect(acceleratorKeyFor('ArrowDown')).toBe('Down');
    expect(acceleratorKeyFor('ArrowUp')).toBe('Up');
  });

  it('keeps the 6.7 names and the space bar spellings', () => {
    expect(acceleratorKeyFor('ArrowRight')).toBe('Right');
    expect(acceleratorKeyFor('ArrowLeft')).toBe('Left');
    expect(acceleratorKeyFor('PageDown')).toBe('PageDown');
    expect(acceleratorKeyFor('PageUp')).toBe('PageUp');
    for (const k of [' ', 'Space', 'Spacebar']) expect(acceleratorKeyFor(k)).toBe('Space');
    // The 6.7 table itself is unchanged (the map's report test reads it).
    expect(Object.keys(ACCELERATOR_KEY)).toEqual(['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp', ' ']);
  });

  it('refuses anything else, prototype keys included', () => {
    for (const k of ['Enter', 'Down', 'arrowdown', '__proto__', 'constructor', 'toString', '']) expect(acceleratorKeyFor(k)).toBeNull();
  });

  it('isNavKey, isAgentNavKey and navKeyFor', () => {
    expect(isNavKey('ArrowDown')).toBe(true);
    expect(isNavKey('ArrowUp')).toBe(true);
    expect(isNavKey('Enter')).toBe(false);
    expect(isAgentNavKey('ArrowDown')).toBe(false);
    expect(isAgentNavKey('ArrowRight')).toBe(true);
    expect(navKeyFor('Spacebar')).toBe(' ');
    expect(navKeyFor('ArrowDown')).toBe('ArrowDown');
    expect(navKeyFor('Tab')).toBeNull();
    expect(navKeyFor(undefined)).toBeNull();
  });

  it('replay keys: Session.deckNav when pressable, else the 6.7 defaults with PageDown as the fallback', () => {
    expect(replayKeys(null)).toEqual({ forward: 'ArrowRight', back: 'ArrowLeft', fallback: 'PageDown' });
    expect(replayKeys({ forward: 'ArrowDown' })).toEqual({ forward: 'ArrowDown', back: 'ArrowUp', fallback: null });
    expect(replayKeys({ forward: 'ArrowDown', back: 'PageUp' })).toEqual({ forward: 'ArrowDown', back: 'PageUp', fallback: null });
    expect(replayKeys({ forward: 'Enter', back: 'Escape' })).toEqual({ forward: 'ArrowRight', back: 'ArrowLeft', fallback: 'PageDown' });
  });
});

describe('6.9 design size', () => {
  it('decks take detection’s size; documents and nonsense take 1600×900', () => {
    expect(chooseDesignSize('reveal', { w: 960, h: 700 })).toEqual({ w: 960, h: 700 });
    expect(chooseDesignSize('generic', { w: 1279.6, h: 720.2 })).toEqual({ w: 1280, h: 720 });
    expect(chooseDesignSize('generic', null)).toEqual({ w: 1600, h: 900 });
    expect(chooseDesignSize('generic', { w: 0, h: 900 })).toEqual({ w: 1600, h: 900 });
    expect(chooseDesignSize('generic', { w: 8, h: 8 })).toEqual({ w: 1600, h: 900 });
    expect(chooseDesignSize('generic', { w: 20_000, h: 900 })).toEqual({ w: 1600, h: 900 });
    expect(chooseDesignSize('generic', { w: Number.NaN, h: 900 })).toEqual({ w: 1600, h: 900 });
    expect(chooseDesignSize('scroll', { w: 1280, h: 720 })).toEqual({ w: 1600, h: 900 });
    expect(chooseDesignSize('single', { w: 1280, h: 720 })).toEqual({ w: 1600, h: 900 });
  });
});

describe('titles and text', () => {
  it('9.4 title first, else the first line of text trimmed to 120, else Slide N', () => {
    expect(slideTitleFor('Agenda', 0, ['x'])).toBe('Agenda');
    expect(slideTitleFor('Slide 3', 2, ['  Quarterly   numbers  ', 'more'])).toBe('Quarterly numbers');
    expect(slideTitleFor(undefined, 4, [])).toBe('Slide 5');
    expect(slideTitleFor('', 0, ['', '  '])).toBe('Slide 1');
    const long = 'word '.repeat(60);
    const t = slideTitleFor('Slide 1', 0, [long]);
    expect(t.length).toBeLessThanOrEqual(120);
    expect(t.endsWith('word')).toBe(true);
  });

  it('trimLine never splits a surrogate pair', () => {
    const s = 'x'.repeat(119) + '😀' + 'y';
    const t = trimLine(s, 120);
    expect(t.length).toBe(119);
    expect(t.endsWith('x')).toBe(true);
  });

  it('collapse and textBySlide keep walk order per slide', () => {
    expect(collapse(' a \n\t b ')).toBe('a b');
    const nodes = [
      { w: { node: { stamp: null, textIndex: 0, data: 'one' } }, slide: 0 },
      { w: { node: { stamp: null, textIndex: 0, data: 'two' } }, slide: 1 },
      { w: { node: { stamp: null, textIndex: 0, data: 'three' } }, slide: 0 },
      { w: { node: { stamp: null, textIndex: 0, data: 'lost' } }, slide: 7 },
    ];
    expect(textBySlide(nodes, 2)).toEqual([['one', 'three'], ['two']]);
  });

  it('one string per block: a block’s inline runs are joined as the page shows them, never across blocks or line breaks (review finding 12)', () => {
    const n = (key: number, data: string, slide = 0) => ({ w: { key, node: { stamp: null, textIndex: 0, data } }, slide });
    // <h2>Growth</h2><p>Plan ahead.</p> · <p>Bold<b>er</b> moves <i>first</i>.</p> · <p>Hello<br>world</p>
    const res = {
      nodes: [1, 2, 3, 4, 5, 6, 7, 8].map((key) => ({ key })),
      blocks: [
        { key: 100, nodeKeys: [1] },
        { key: 101, nodeKeys: [2] },
        { key: 102, nodeKeys: [3, 4, 5, 6] },
        { key: 103, nodeKeys: [7, 8] },
      ],
      // joins[i] for nodes[i]: 4 continues 3 directly ("Bold|er"), 5 continues 4 (" moves " is its own data),
      // 6 after a space-only node the walk skipped, 8 after a <br> (0: not joined).
      joins: [0, 0, 0, 1, 1, 2, 0, 0] as (0 | 1 | 2)[],
    };
    const joins: NodeJoins = new Map();
    noteJoins(res as never, joins);
    expect([...joins.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [4, { prev: 3, sep: 1 }],
      [5, { prev: 4, sep: 1 }],
      [6, { prev: 5, sep: 2 }],
    ]);
    const nodes = [n(1, 'Growth'), n(2, 'Plan ahead.'), n(3, 'Bold'), n(4, 'er'), n(5, ' moves'), n(6, 'first.'), n(7, 'Hello'), n(8, 'world')];
    expect(textBySlide(nodes, 1, joins)).toEqual([['Growth', 'Plan ahead.', 'Bolder moves first.', 'Hello', 'world']]);
    // A node only joins the string that ends with the node it continues: here 5 arrives after another slide's
    // node, and 4 was never collected, so nothing joins.
    expect(textBySlide([n(3, 'Bold'), n(9, 'other', 1), n(5, ' moves')], 2, joins)).toEqual([['Bold', ' moves'], ['other']]);
    // Without joins, as before: one string per node.
    expect(textBySlide(nodes.slice(2, 4), 1)).toEqual([['Bold', 'er']]);
    // A later collect that sees no join for a node forgets the earlier one.
    noteJoins({ nodes: [{ key: 4 }], blocks: [{ key: 102, nodeKeys: [4] }], joins: [0] } as never, joins);
    expect(joins.has(4)).toBe(false);
  });

  it('deck entries carry the SlideRef nav of each kind (9.4)', () => {
    const reveal = deckEntries({ kind: 'reveal', count: 2, titles: ['A', 'Slide 2'], navKind: 'reveal', revealIndices: [[0, 0], [1, 2]] }, [['a'], ['  Second   slide ']]);
    expect(reveal.map((e) => e.nav)).toEqual([{ kind: 'reveal', value: [0, 0] }, { kind: 'reveal', value: [1, 2] }]);
    expect(reveal[1].title).toBe('Second slide');
    expect(reveal[1].text).toEqual(['Second slide']);
    const hash = deckEntries({ kind: 'generic', count: 2, titles: ['A', 'B'], navKind: 'hash', hashes: ['#/1', '#/2'] }, [[], []]);
    expect(hash.map((e) => e.nav)).toEqual([{ kind: 'hash', value: '#/1' }, { kind: 'hash', value: '#/2' }]);
    const index = deckEntries({ kind: 'generic', count: 3, titles: ['A', 'B', 'C'], navKind: 'index' }, []);
    expect(index.map((e) => e.nav)).toEqual([0, 1, 2].map((i) => ({ kind: 'index', value: i })));
    expect(index.map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it('document entries: one per rendered h1–h3 section; the text before the first heading only when it has text', () => {
    const d = documentEntries(
      [
        { heading: null, level: 0, title: '', text: ['Intro line'] },
        { heading: 0, level: 1, title: 'Overview', text: ['Overview', 'Body'] },
        { heading: 2, level: 2, title: 'Method', text: ['Method'] },
      ],
      'Doc',
    );
    expect(d.map((e) => [e.index, e.title, e.heading, e.level, e.nav])).toEqual([
      [0, 'Intro line', null, undefined, { kind: 'none', value: 0 }],
      [1, 'Overview', 0, 1, { kind: 'none', value: 0 }],
      [2, 'Method', 2, 2, { kind: 'none', value: 0 }],
    ]);
    const noIntro = documentEntries(
      [
        { heading: null, level: 0, title: '', text: [] },
        { heading: 0, level: 1, title: 'Only', text: ['Only'] },
      ],
      'Doc',
    );
    expect(noIntro.map((e) => e.title)).toEqual(['Only']);
    expect(documentEntries([{ heading: null, level: 0, title: '', text: [] }], 'Empty page')[0].title).toBe('Empty page');
  });
});

describe('the index cache (9.7 thumbs/index-<version>.json)', () => {
  const index: SlideIndex = {
    version: V,
    kind: 'generic',
    navKind: 'hash',
    slides: [
      { index: 0, title: 'A', nav: { kind: 'hash', value: '#a' }, text: ['a'] },
      { index: 1, title: 'B', nav: { kind: 'hash', value: '#b' }, text: [] },
    ],
    designSize: { w: 1600, h: 900 },
    complete: true,
  };

  it('round-trips through JSON', () => {
    expect(parseSlideIndex(JSON.parse(JSON.stringify(index)), V)).toEqual(index);
    const doc: SlideIndex = { ...index, kind: 'scroll', navKind: 'scroll', slides: [{ index: 0, title: 'S', nav: { kind: 'none', value: 0 }, text: ['x'], heading: null }, { index: 1, title: 'T', nav: { kind: 'none', value: 0 }, text: [], heading: 3, level: 2 }] };
    expect(parseSlideIndex(JSON.parse(JSON.stringify(doc)), V)).toEqual(doc);
  });

  it('refuses anything off: another version, a bad kind, a gap in indices, a bad nav, a prototype trick', () => {
    expect(parseSlideIndex(JSON.parse(JSON.stringify(index)), 'b'.repeat(64))).toBeNull();
    expect(parseSlideIndex({ ...index, kind: 'other' }, V)).toBeNull();
    expect(parseSlideIndex({ ...index, slides: [index.slides[1]] }, V)).toBeNull();
    expect(parseSlideIndex({ ...index, slides: [{ ...index.slides[0], nav: { kind: 'hash', value: { x: 1 } } }] }, V)).toBeNull();
    expect(parseSlideIndex({ ...index, designSize: { w: 0, h: 9 } }, V)).toBeNull();
    expect(parseSlideIndex({ ...index, slides: [{ ...index.slides[0], level: 4 }] }, V)).toBeNull();
    expect(parseSlideIndex(JSON.parse('{"__proto__":{"kind":"generic"}}'), V)).toBeNull();
    expect(parseSlideIndex([], V)).toBeNull();
  });

  it('paths stay inside <userData>/files/<fileKey>/thumbs', () => {
    expect(thumbsDir('/u', '0123456789abcdef')).toBe('/u/files/0123456789abcdef/thumbs');
    expect(() => thumbsDir('/u', '../../etc')).toThrow();
    expect(indexFileName(V)).toBe(`index-${V}.json`);
    expect(() => indexFileName('x/../y')).toThrow();
  });
});

describe('6.7 step 1: no write for 300 ms', () => {
  it('quietDelay is what is left of the 300 ms', () => {
    expect(quietDelay(undefined, 1000)).toBe(0);
    expect(quietDelay(1000, 1000)).toBe(300);
    expect(quietDelay(1000, 1250)).toBe(50);
    expect(quietDelay(1000, 1300)).toBe(0);
    expect(quietDelay(1000, 5000)).toBe(0);
    // A clock that went back never waits more than 300 ms.
    expect(quietDelay(5000, 1000)).toBe(300);
  });

  it('untilQuiet waits after a write and returns at once without one', async () => {
    const key = '00000000000000aa';
    let t0 = Date.now();
    await untilQuiet(key);
    expect(Date.now() - t0).toBeLessThan(50);
    noteDocumentWrite(key);
    t0 = Date.now();
    await untilQuiet(key);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    // Not a fileKey: ignored.
    noteDocumentWrite('../x');
  });

  it('untilQuiet stops when cancelled', async () => {
    const key = '00000000000000bb';
    noteDocumentWrite(key);
    const c = new AbortController();
    const p = untilQuiet(key, c.signal);
    c.abort();
    await expect(p).rejects.toThrow(/cancelled/);
  });
});

describe('ViewSlots: at most two render windows per document (9.1), keyed by viewport', () => {
  const make = () => {
    const made: string[] = [];
    const closed: string[] = [];
    let n = 0;
    const slots = new ViewSlots<{ key: string; id: number; dead?: boolean }>(
      (key) => {
        made.push(key);
        return { key, id: ++n };
      },
      (v) => closed.push(`${v.key}#${v.id}`),
      (v) => v.dead === true,
      2,
      60_000,
    );
    return { slots, made, closed };
  };

  it('reuses an idle view of the same viewport and never holds more than two', async () => {
    const { slots, made, closed } = make();
    const a = await slots.acquire('1600x900@2');
    slots.release(a);
    const a2 = await slots.acquire('1600x900@2');
    expect(a2).toBe(a);
    const b = await slots.acquire('960x700@2');
    expect(slots.size).toBe(2);
    slots.release(a2);
    // A third viewport replaces the idle one.
    const c = await slots.acquire('1280x720@2');
    expect(slots.size).toBe(2);
    expect(closed).toEqual(['1600x900@2#1']);
    expect(made).toEqual(['1600x900@2', '960x700@2', '1280x720@2']);
    slots.release(b);
    slots.release(c);
    slots.close();
    expect(slots.size).toBe(0);
  });

  it('waits for a release when both are busy, and a cancelled waiter leaves the queue', async () => {
    const { slots } = make();
    const a = await slots.acquire('k1');
    const b = await slots.acquire('k2');
    const ctrl = new AbortController();
    const cancelled = slots.acquire('k3', ctrl.signal);
    let got: unknown = null;
    const waiting = slots.acquire('k1').then((v) => (got = v));
    ctrl.abort();
    await expect(cancelled).rejects.toThrow(/cancelled/);
    expect(got).toBeNull();
    slots.release(a);
    await waiting;
    expect(got).toBe(a);
    slots.release(b);
    slots.close();
  });

  it('drops dead views and refuses more than two', async () => {
    const { slots } = make();
    const a = await slots.acquire('k');
    a.dead = true;
    slots.release(a);
    expect(slots.size).toBe(0);
    expect(() => new ViewSlots(() => 1, () => undefined, () => false, 3)).toThrow(RangeError);
  });
});

describe('outlineOf: the document walk’s result is checked', () => {
  it('accepts a well-formed outline and gives an empty section when there is none', () => {
    const o = outlineOf({ headings: 2, sections: [{ heading: null, level: 0, title: '', text: ['a'] }, { heading: 1, level: 3, title: 'H', text: ['H', 'b'] }], cut: false });
    expect(o.sections.map((s) => s.heading)).toEqual([null, 1]);
    expect(outlineOf({ headings: 0, sections: [], cut: false }).sections).toHaveLength(1);
  });

  it('refuses headings out of range, level mismatches and non-strings', () => {
    expect(() => outlineOf({ headings: 1, sections: [{ heading: 1, level: 1, title: '', text: [] }], cut: false })).toThrow();
    expect(() => outlineOf({ headings: 1, sections: [{ heading: 0, level: 0, title: '', text: [] }], cut: false })).toThrow();
    expect(() => outlineOf({ headings: 1, sections: [{ heading: null, level: 0, title: '', text: [1] }], cut: false })).toThrow();
    expect(() => outlineOf(null)).toThrow();
  });
});

describe('resultCheck.detect keeps the per-slide hashes and ids SlideRef.nav needs (9.4 step 2)', () => {
  const base = { kind: 'generic', count: 2, current: 0, titles: ['A', 'B'], navKind: 'hash', designSize: { w: 1600, h: 900 } };
  it('keeps well-formed lists of one entry per slide', () => {
    const r = resultCheck.detect({ ...base, hashes: ['#a', '#/2'], ids: ['a', null] });
    expect(r.hashes).toEqual(['#a', '#/2']);
    expect(r.ids).toEqual(['a', null]);
  });
  it('drops a list with a wrong length or a bad entry, and never fails the detect for it', () => {
    expect(resultCheck.detect({ ...base, hashes: ['#a'] }).hashes).toBeUndefined();
    expect(resultCheck.detect({ ...base, hashes: ['#a', 'b'] }).hashes).toBeUndefined();
    expect(resultCheck.detect({ ...base, ids: ['a', 'x'.repeat(2000)] }).ids).toBeUndefined();
    expect(resultCheck.detect({ ...base, ids: ['a', 3] }).ids).toBeUndefined();
    expect(resultCheck.detect(base).count).toBe(2);
    expect(() => resultCheck.detect({ ...base, kind: 'other' })).toThrow();
  });
});

describe('renderTargetFor', () => {
  it('reads trust live and defaults to reduced motion (background renders)', () => {
    let network = false;
    const t = renderTargetFor({
      docId: '0123456789abcdef',
      fileName: 'deck.html',
      partition: 'deck-0123456789abcdef',
      folderReal: '/d',
      realpath: '/d/deck.html',
      fileKey: 'fedcba9876543210',
      version: V,
      title: 'T',
      marker: null,
      trust: () => 'protected',
      networkAllowed: () => network,
    });
    expect(t.reducedMotion).toBe(true);
    expect(t.isProtected()).toBe(true);
    expect(t.networkOpen()).toBe(false);
    network = true;
    expect(t.networkOpen()).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------- slide visits

function press(key: NavKey, from: number, to: number, via: 'input' | 'synthetic' = 'input', delivered: boolean | null = true): KeyPress {
  return { key, from, to, moved: to !== from, via, delivered, navOk: to !== from };
}

describe('pressPatiently (6.7 Index replay with the walk’s patience, F25)', () => {
  it('presses again when a delivered key changed nothing', async () => {
    const results = [press('ArrowDown', 0, 0), press('ArrowDown', 0, 1)];
    const keys: NavKey[] = [];
    const view = { pressKey: async (k: NavKey) => (keys.push(k), results.shift()!) };
    const p = await pressPatiently(view as unknown as RenderView, 'ArrowDown');
    expect(p.moved).toBe(true);
    expect(keys).toEqual(['ArrowDown', 'ArrowDown']);
  });

  it('a press that shows a build step (the visible text changed) uses up no retry', async () => {
    // Five build steps, then the move: more than the three retries a press that changes nothing gets.
    const results = [...Array(5)].map(() => press('ArrowRight', 0, 0)).concat([press('ArrowRight', 0, 1)]);
    let shown = 0;
    let n = 0;
    const view = {
      pressKey: async () => {
        n++;
        const r = results.shift()!;
        if (!r.moved) shown++;
        return r;
      },
      visibleTextSignature: async () => `sig${shown}`,
    };
    const p = await pressPatiently(view as unknown as RenderView, 'ArrowRight');
    expect(p.moved).toBe(true);
    expect(n).toBe(6);
  });

  it('without a change it gives up after the three retries', async () => {
    let n = 0;
    const view = { pressKey: async () => (n++, press('ArrowRight', 1, 1)), visibleTextSignature: async () => 'same' };
    const p = await pressPatiently(view as unknown as RenderView, 'ArrowRight');
    expect(p.moved).toBe(false);
    expect(n).toBe(4);
  }, 10_000);

  it('does not retry a key the deck never saw', async () => {
    let n = 0;
    const view = { pressKey: async () => (n++, press('ArrowRight', 0, 0, 'synthetic', false)) };
    const p = await pressPatiently(view as unknown as RenderView, 'ArrowRight');
    expect(p.moved).toBe(false);
    expect(n).toBe(1);
  });
});

/** A fake render view over a generic deck of `count` slides that moves on `moveKey` only. */
function fakeDeck(count: number, moveKey: NavKey, opts: { start?: number; overlay?: boolean } = {}) {
  let cur = opts.start ?? 0;
  const log: string[] = [];
  const view = {
    load: async () => {
      cur = opts.start ?? 0;
      log.push('load');
    },
    waitStable: async () => (log.push('stable'), { fontsReady: true, stillRunning: 0 }),
    waitScripted: async (o: ScriptedSettle) => (log.push(`scripted:${o.minMs}/${o.quietMs}/${o.maxMs}`), { waitedMs: o.minMs, quiet: true }),
    overlayMounted: async () => opts.overlay === true,
    detect: async () => ({ kind: 'generic', count, current: cur, titles: [], navKind: 'index', designSize: { w: 1600, h: 900 } }),
    current: async () => ({ current: cur, count, hash: '', scrollY: 0, reveal: null }),
    pauseAnimations: async () => (log.push('pause'), 0),
    resumeAnimations: async () => undefined,
    pressKey: async (k: NavKey) => {
      const from = cur;
      if (k === moveKey && cur < count - 1) cur++;
      else if ((k === 'ArrowLeft' || k === 'ArrowUp') && cur > 0) cur--;
      log.push(`${k}:${from}->${cur}`);
      return press(k, from, cur);
    },
    setHash: async () => false,
  };
  return { view: view as unknown as RenderView, log };
}

function target(deckNav: RenderTarget['deckNav'] = null): RenderTarget {
  return {
    docId: '0123456789abcdef',
    fileName: 'deck.html',
    partition: 'p',
    folderReal: '/d',
    realpath: '/d/deck.html',
    fileKey: '00000000000000cc',
    version: V,
    title: '',
    marker: null,
    isProtected: () => false,
    networkOpen: () => true,
    renderPolicyTag: () => 'test-policy',
    reducedMotion: true,
    deckNav,
  };
}

function genericIndex(count: number): SlideIndex {
  return {
    version: V,
    kind: 'generic',
    navKind: 'index',
    slides: Array.from({ length: count }, (_, i) => ({ index: i, title: `S${i}`, nav: { kind: 'index' as const, value: i }, text: [] })),
    designSize: { w: 1600, h: 900 },
    complete: true,
  };
}

describe('visitSlides (6.7 step 2: replay slide.nav)', () => {
  it('walks a generic deck with Session.deckNav’s ArrowDown and visits every slide once', async () => {
    const { view, log } = fakeDeck(4, 'ArrowDown');
    const seen: number[] = [];
    const r = await visitSlides(view, target({ forward: 'ArrowDown', back: 'ArrowUp' }), genericIndex(4), async (i) => void seen.push(i));
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(r.missed).toEqual([]);
    expect(log.filter((l) => l.startsWith('ArrowDown'))).toHaveLength(3);
  });

  it('visits only the slides asked for, and reports the ones it could not reach', async () => {
    const { view } = fakeDeck(4, 'ArrowRight');
    const seen: number[] = [];
    const r = await visitSlides(view, target(), genericIndex(4), async (i) => void seen.push(i), { only: new Set([2]) });
    expect(seen).toEqual([2]);
    expect(r.missed).toEqual([]);
  });

  it('brings a deck that opens elsewhere back to its first slide', async () => {
    const { view } = fakeDeck(3, 'ArrowRight', { start: 2 });
    const seen: number[] = [];
    await visitSlides(view, target(), genericIndex(3), async (i) => void seen.push(i));
    expect(seen).toEqual([0, 1, 2]);
  });

  it('waits for what the slide’s scripts reveal before each still image, then settles and pauses (6.7 step 3)', async () => {
    const { view, log } = fakeDeck(2, 'ArrowRight');
    // A version no walk has seen: every slide gets the full wait.
    await visitSlides(view, { ...target(), version: 'e'.repeat(64) }, { ...genericIndex(2), version: 'e'.repeat(64) }, async (i) => void log.push(`visit:${i}`));
    const firstVisit = log.indexOf('visit:0');
    const w = `scripted:${SCRIPTED_SETTLE.minMs}/${SCRIPTED_SETTLE.quietMs}/${SCRIPTED_SETTLE.maxMs}`;
    expect(log.slice(firstVisit - 4, firstVisit)).toEqual(['stable', w, 'stable', 'pause']);
    expect(log.filter((l) => l === w)).toHaveLength(2);
    expect(SCRIPTED_SETTLE.minMs).toBeGreaterThanOrEqual(1300); // D5 reveals its draft 1.3 s after the slide arrives
    const custom = fakeDeck(1, 'ArrowRight');
    await visitSlides(custom.view, target(), genericIndex(1), async () => undefined, { scripted: { minMs: 0, quietMs: 0, maxMs: 0 } });
    expect(custom.log).toContain('scripted:0/0/0');
  });

  it('refuses a view that shows the overlay (render mode has no UI)', async () => {
    const { view } = fakeDeck(3, 'ArrowRight', { overlay: true });
    await expect(visitSlides(view, target(), genericIndex(3), async () => undefined)).rejects.toThrow(/overlay/);
  });
});

describe('the adaptive settle (SettleMemory; decision D-5)', () => {
  const late = { quiet: true, late: true };
  const still = { quiet: true, late: false };
  const ticker = { quiet: false, late: false };

  it('a slide gets the full wait until a full wait showed it still; then the quiet-only wait', () => {
    const m = new SettleMemory();
    expect(m.waitFor(0)).toBe(SCRIPTED_SETTLE);
    m.learn(0, SCRIPTED_SETTLE, still);
    expect(m.waitFor(0)).toBe(QUIET_SETTLE);
    expect(QUIET_SETTLE).toEqual({ minMs: 0, quietMs: 400, maxMs: 3000 });
    // Other slides are not decided by slide 0: D5 reveals by timer on its fifth slide only.
    expect(m.waitFor(4)).toBe(SCRIPTED_SETTLE);
    // A quiet-only wait proves nothing more, so it never makes a slide quiet.
    m.learn(5, QUIET_SETTLE, still);
    expect(m.waitFor(5)).toBe(SCRIPTED_SETTLE);
  });

  it('a slide whose DOM changed after a pause (a timer) keeps the full wait, for good', () => {
    const m = new SettleMemory();
    m.learn(1, SCRIPTED_SETTLE, late);
    expect(m.waitFor(1)).toBe(SCRIPTED_SETTLE);
    m.learn(1, SCRIPTED_SETTLE, still);
    expect(m.waitFor(1)).toBe(SCRIPTED_SETTLE);
    // A slide that never went quiet (a ticker) waits to the cap either way.
    m.learn(2, SCRIPTED_SETTLE, ticker);
    expect(m.waitFor(2)).toBe(SCRIPTED_SETTLE);
  });

  it('a late change during or after a quiet-only wait restores the full wait for every slide', () => {
    const m = new SettleMemory();
    for (const i of [0, 1, 2]) m.learn(i, SCRIPTED_SETTLE, still);
    expect([0, 1, 2].map((i) => m.isQuiet(i))).toEqual([true, true, true]);
    m.learn(1, QUIET_SETTLE, late);
    expect([0, 1, 2].map((i) => m.waitFor(i))).toEqual([SCRIPTED_SETTLE, SCRIPTED_SETTLE, SCRIPTED_SETTLE]);
    const n = new SettleMemory();
    n.learn(0, SCRIPTED_SETTLE, still);
    n.changedAfterQuiet();
    expect(n.waitFor(0)).toBe(SCRIPTED_SETTLE);
  });

  it('a document’s page always keeps the full wait, even after it looked still (review finding 10)', () => {
    // A canvas a script animates below the first screen (no DOM mutation, outside the viewport the picture check
    // samples) looked "quiet", and the no-minimum wait then printed it mid-animation. A document's page is one
    // page printed once, so it keeps the full wait regardless of what a walk observed.
    const m = new SettleMemory();
    m.learn(null, SCRIPTED_SETTLE, still);
    expect(m.waitFor(null)).toBe(SCRIPTED_SETTLE);
    expect(m.isQuiet(null)).toBe(false);
  });

  it('waitAdaptive: a quiet-only wait that saw a late change goes on with the full wait, for that slide and every other', async () => {
    const m = new SettleMemory();
    for (const i of [0, 1]) m.learn(i, SCRIPTED_SETTLE, still);
    const seen: number[] = [];
    const view = {
      waitScripted: async (o: ScriptedSettle) => {
        seen.push(o.minMs);
        // The quiet-only wait sees a canvas still moving (late); the full wait after it sees the slide still.
        return { waitedMs: o.minMs || 300, quiet: true, late: o.minMs === 0, stamp: 1 };
      },
    };
    const w = await waitAdaptive(view, m, 1, null);
    expect(seen).toEqual([0, 1500]);
    expect(w).toMatchObject({ settle: SCRIPTED_SETTLE, waitedMs: 1800, late: false });
    expect([m.waitFor(0), m.waitFor(1)]).toEqual([SCRIPTED_SETTLE, SCRIPTED_SETTLE]);
  });

  it('is kept per (fileKey, version) and shared by every walk of that version', () => {
    const a = settleMemoryFor('00000000000000aa', 'b'.repeat(64));
    expect(settleMemoryFor('00000000000000aa', 'b'.repeat(64))).toBe(a);
    expect(settleMemoryFor('00000000000000aa', 'c'.repeat(64))).not.toBe(a);
  });

  it('visitSlides: the first walk of a version waits in full and learns; the next waits quiet-only where it may (delayed-build keeps the full wait)', async () => {
    const version = 'd'.repeat(64);
    const doc = { ...target(), fileKey: '00000000000000dd', version };
    const index = { ...genericIndex(3), version };
    // Slide 1 reveals a panel by timer after the slide arrives (test/parity/fixtures/delayed-build.html).
    const timed = new Set([1]);
    const run = async () => {
      const { view, log } = fakeDeck(3, 'ArrowRight');
      let cur = 0;
      const v = view as unknown as Record<string, unknown>;
      const press = v.pressKey as (k: NavKey) => Promise<KeyPress>;
      v.pressKey = async (k: NavKey) => {
        const p = await press(k);
        cur = p.to;
        return p;
      };
      v.waitScripted = async (o: ScriptedSettle) => {
        log.push(`scripted:${cur}:${o.minMs}`);
        return { waitedMs: o.minMs, quiet: true, late: timed.has(cur), stamp: 1 };
      };
      v.mutationStamp = async () => 1;
      await visitSlides(view, doc, index, async () => undefined);
      return log.filter((l) => l.startsWith('scripted:'));
    };
    expect(await run()).toEqual(['scripted:0:1500', 'scripted:1:1500', 'scripted:2:1500']);
    expect(await run()).toEqual(['scripted:0:0', 'scripted:1:1500', 'scripted:2:0']);
  });

  it('visitSlides: a change after a quiet-only wait (the page’s mutation stamp moved) gives every slide the full wait again', async () => {
    const version = 'f'.repeat(64);
    const doc = { ...target(), fileKey: '00000000000000ee', version };
    const index = { ...genericIndex(3), version };
    const m = settleMemoryFor(doc.fileKey, version);
    for (const i of [0, 1, 2]) m.learn(i, SCRIPTED_SETTLE, still);
    const { view, log } = fakeDeck(3, 'ArrowRight');
    const v = view as unknown as Record<string, unknown>;
    v.waitScripted = async (o: ScriptedSettle) => (log.push(`scripted:${o.minMs}`), { waitedMs: 0, quiet: true, late: false, stamp: 1 });
    // The DOM changed after slide 1's quiet-only wait ended.
    let stamp = 1;
    v.mutationStamp = async () => stamp;
    await visitSlides(view, doc, index, async (i) => void (i === 0 ? (stamp = 2) : undefined));
    expect(log.filter((l) => l.startsWith('scripted:'))).toEqual(['scripted:0', 'scripted:1500', 'scripted:1500']);
  });
});

describe('index walk thumbnails and index files', () => {
  it('the index walk takes the rail’s thumbnails only where they render at its own viewport (1600×900 at 2x)', () => {
    expect(RAIL_THUMB_WIDTH).toBe(152);
    expect(indexWalkTakesThumbs('generic', { w: 1600, h: 900 }, RAIL_THUMB_WIDTH)).toBe(true);
    expect(indexWalkTakesThumbs('reveal', { w: 1600, h: 900 }, RAIL_THUMB_WIDTH)).toBe(true);
    expect(indexWalkTakesThumbs('reveal', { w: 960, h: 700 }, RAIL_THUMB_WIDTH)).toBe(false);
    expect(indexWalkTakesThumbs('generic', { w: 1280, h: 720 }, RAIL_THUMB_WIDTH)).toBe(false);
    expect(indexWalkTakesThumbs('scroll', { w: 1600, h: 900 }, RAIL_THUMB_WIDTH)).toBe(false);
    expect(indexWalkTakesThumbs('generic', { w: 1600, h: 900 }, null)).toBe(false);
    expect(indexWalkTakesThumbs('generic', { w: 1600, h: 900 }, 4)).toBe(false);
  });

  it('pruneOtherIndexFiles deletes the other versions’ index files and nothing else (review finding 14)', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-index-prune-'));
    try {
      const dir = thumbsDir(userData, '00000000000000ab');
      fs.mkdirSync(dir, { recursive: true });
      const keep = 'a'.repeat(64);
      const names = [indexFileName(keep), indexFileName('b'.repeat(64)), indexFileName('c'.repeat(64)), `${'b'.repeat(64)}-0-152.png`, 'notes.txt'];
      for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');
      expect(await pruneOtherIndexFiles(userData, '00000000000000ab', keep)).toBe(2);
      expect(fs.readdirSync(dir).sort()).toEqual([indexFileName(keep), `${'b'.repeat(64)}-0-152.png`, 'notes.txt'].sort());
      expect(await pruneOtherIndexFiles(userData, '00000000000000ff', keep)).toBe(0);
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});
