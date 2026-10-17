// The slide index, thumbnails and Find in the real app (6.7 Background renders; 6.9 Navigation and Find;
// 9.7 thumbs/). The app runs as `launchApp` runs it (bltest, OS sandbox on, when available); the render
// products are driven through the test build's main-process harness (`__blRenderTest`, pdf-command.ts),
// which opens each document in its own partition as `blueline pdf` does.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });
test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run through `npm run test:e2e` (its global setup starts Xvfb)');
test.setTimeout(300_000);

interface Entry {
  index: number;
  title: string;
  nav: { kind: string; value: unknown };
  text: string[];
  heading?: number | null;
}
interface Index {
  version: string;
  kind: string;
  navKind: string;
  slides: Entry[];
  designSize: { w: number; h: number };
  complete: boolean;
}
interface Thumb {
  version: string;
  slide: number;
  width: number;
  file: string;
  pixelWidth: number;
  pixelHeight: number;
  cached: boolean;
}
interface Opened {
  docId: string;
  fileKey: string;
  version: string;
}

let s: Scratch;
let app: BlApp;
let dir: string;

/** Calls one of the harness's functions in main. */
function rt<T>(app: BlApp, fn: string, ...args: unknown[]): Promise<T> {
  return app.electronApp.evaluate(
    async (_e, a) => (globalThis as unknown as Record<string, Record<string, (...x: unknown[]) => unknown>>).__blRenderTest[a.fn](...a.args),
    { fn, args },
  ) as Promise<T>;
}

function png(file: string): { width: number; height: number } {
  const b = fs.readFileSync(file);
  expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function thumbsDir(fileKey: string): string {
  return path.join(app.userData, 'files', fileKey, 'thumbs');
}

test.beforeAll(async () => {
  s = new Scratch(resolveRunAs());
  dir = s.dir('render');
  fs.cpSync(path.join(FIXTURES, 'decks/reveal-hash'), path.join(dir, 'reveal'), { recursive: true });
  for (const f of ['generic-index.html', 'generic-hash.html', 'report.html', 'single.html']) copyInto(path.join(FIXTURES, 'decks', f), dir);
  for (const f of fs.readdirSync(path.join(FIXTURES, 'render'))) copyInto(path.join(FIXTURES, 'render', f), dir);
  s.own(dir);
  app = await launchApp({ files: [path.join(dir, 'single.html')], scratch: s });
  await app.waitForDeck('single.html');
});

test.afterAll(async () => {
  await app?.close();
  s?.cleanup();
});

const DECKS: { file: string; kind: string; count: number; navKind: string }[] = [
  { file: 'reveal/index.html', kind: 'reveal', count: 8, navKind: 'reveal' },
  { file: 'generic-index.html', kind: 'generic', count: 6, navKind: 'index' },
  { file: 'generic-hash.html', kind: 'generic', count: 5, navKind: 'hash' },
];

test('the index and thumbnails of the committed decks: counts, 2x sizes, then all from the cache', async () => {
  for (const d of DECKS) {
    const o = await rt<Opened>(app, 'open', path.join(dir, d.file));
    const index = await rt<Index>(app, 'index', o.docId);
    expect(index.version, d.file).toBe(o.version);
    expect(index.kind, d.file).toBe(d.kind);
    expect(index.navKind, d.file).toBe(d.navKind);
    expect(index.slides, d.file).toHaveLength(d.count);
    expect(index.complete, d.file).toBe(true);
    expect(index.slides.every((e) => e.title.length > 0 && e.text.length > 0), `${d.file}: every slide has a title and text`).toBe(true);
    if (d.kind === 'reveal') expect(index.slides.map((e) => e.nav.kind)).toEqual(Array(d.count).fill('reveal'));
    if (d.navKind === 'hash') expect(index.slides.every((e) => e.nav.kind === 'hash' && typeof e.nav.value === 'string' && (e.nav.value as string).startsWith('#'))).toBe(true);
    if (d.navKind === 'index') expect(index.slides.map((e) => e.nav.value)).toEqual([...Array(d.count).keys()]);

    // The index is cached in app data (9.7 thumbs/index-<version>.json).
    expect(fs.existsSync(path.join(thumbsDir(o.fileKey), `index-${o.version}.json`))).toBe(true);

    const first = await rt<{ events: Thumb[]; result: { rendered: number; cached: number; missed: number[] }; ms: number; views: number }>(app, 'thumbs', o.docId, 160);
    expect(first.result, d.file).toEqual({ version: o.version, width: 160, rendered: d.count, cached: 0, missed: [] });
    expect(first.events.map((e) => e.slide).sort((a, b) => a - b)).toEqual([...Array(d.count).keys()]);
    expect(first.views, '9.1: at most two render windows per document').toBeLessThanOrEqual(2);
    const wantH = Math.round((160 * index.designSize.h) / index.designSize.w) * 2;
    for (const e of first.events) {
      expect(e.file).toBe(`${o.version}-${e.slide}-160.png`);
      expect(e.pixelWidth).toBe(320);
      expect(e.pixelHeight).toBe(wantH);
      expect(png(path.join(thumbsDir(o.fileKey), e.file)), `${d.file} slide ${e.slide}: 160 CSS px at 2x`).toEqual({ width: 320, height: wantH });
    }
    // Every slide's thumbnail differs from the next (navigation really moved).
    const bytes = first.events.map((e) => fs.readFileSync(path.join(thumbsDir(o.fileKey), e.file)).toString('base64'));
    expect(new Set(bytes).size, `${d.file}: one distinct thumbnail per slide`).toBe(d.count);

    const again = await rt<{ events: Thumb[]; result: { rendered: number; cached: number }; ms: number }>(app, 'thumbs', o.docId, 160);
    expect(again.result.rendered, `${d.file}: second run from the cache`).toBe(0);
    expect(again.result.cached).toBe(d.count);
    expect(again.events.every((e) => e.cached)).toBe(true);
    expect(again.ms).toBeLessThan(first.ms);
    await rt(app, 'close', o.docId);
  }
});

test('a document: one entry per rendered h1–h3 section, thumbnails per section', async () => {
  const o = await rt<Opened>(app, 'open', path.join(dir, 'report.html'));
  const index = await rt<Index>(app, 'index', o.docId);
  expect(index.kind).toBe('scroll');
  expect(index.designSize).toEqual({ w: 1600, h: 900 });
  const src = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
  const headings = (src.match(/<h[1-3][\s>]/g) ?? []).length;
  const sections = index.slides.filter((e) => typeof e.heading === 'number');
  expect(sections.length).toBe(headings);
  expect(sections.map((e) => e.heading)).toEqual([...Array(headings).keys()]);
  expect(index.slides.every((e) => e.nav.kind === 'none')).toBe(true);
  const t = await rt<{ result: { rendered: number; missed: number[] } }>(app, 'thumbs', o.docId, 120);
  expect(t.result).toMatchObject({ rendered: index.slides.length, missed: [] });

  const doc = await rt<Opened>(app, 'open', path.join(dir, 'document.html'));
  const di = await rt<Index>(app, 'index', doc.docId);
  expect(di.kind).toBe('single');
  expect(di.slides.map((e) => [e.title, e.heading])).toEqual([
    ['A short report on the café survey, before any heading.', null],
    ['Overview', 0],
    ['Method', 1],
    // The hidden h2 (heading 2) starts no section, and its text is not indexed.
    ['Sample', 3],
    ['Findings', 4],
  ]);
  expect(JSON.stringify(di)).not.toContain('Invisible paragraph');
  expect(JSON.stringify(di)).not.toContain('QUARTZNOTE');
  await rt(app, 'close', o.docId);
  await rt(app, 'close', doc.docId);
});

test('Find lists hits by slide, on slides that are not showing, ignoring case and accents', async () => {
  // A window on a copy (its own file, so its own partition): the visible view shows slide 1.
  const shown = path.join(dir, 'generic-index-window.html');
  fs.copyFileSync(path.join(dir, 'generic-index.html'), shown);
  s.own(shown);
  const deckWin = await app.electronApp.evaluate(async (_e, p) => (globalThis as unknown as { __blTest: { open(p: string): Promise<string | null> } }).__blTest.open(p), shown);
  expect(deckWin).not.toBeNull();
  const o = await rt<Opened>(app, 'open', path.join(dir, 'generic-index.html'));
  const r = await rt<{ hits: { slide: number; matchIndex: number; text: string; snippet: string; snippetMatch: { start: number; end: number } }[]; pending: boolean }>(app, 'find', o.docId, 'LATENCY');
  expect(r.pending).toBe(false);
  expect(r.hits.length).toBeGreaterThan(0);
  // The visible window shows slide 1; the hits are on later slides.
  const win = (await app.windows()).find((w) => w.docId === deckWin)!;
  expect(win.state.slide?.current ?? 0).toBe(0);
  expect(r.hits.every((h) => h.slide > 0)).toBe(true);
  for (const h of r.hits) expect(h.snippet.slice(h.snippetMatch.start, h.snippetMatch.end).toLowerCase()).toBe('latency');

  const doc = await rt<Opened>(app, 'open', path.join(dir, 'document.html'));
  const d = await rt<{ hits: { slide: number; matchIndex: number; text: string }[] }>(app, 'find', doc.docId, 'resume');
  expect(d.hits.map((h) => [h.slide, h.matchIndex, h.text])).toEqual([
    [1, 0, 'Résumé'],
    [2, 1, 'resume'],
    [4, 2, 'résumé'],
  ]);
  expect((await rt<{ hits: unknown[] }>(app, 'find', doc.docId, 'invisible paragraph')).hits).toEqual([]);

  // reveal.js fragments are indexed with every fragment shown.
  const rv = await rt<Opened>(app, 'open', path.join(dir, 'reveal/index.html'));
  const f = await rt<{ hits: { slide: number }[] }>(app, 'find', rv.docId, 'partners sell the enterprise tier');
  expect(f.hits).toHaveLength(1);
  for (const id of [o.docId, doc.docId, rv.docId]) await rt(app, 'close', id);
});

test('findInPage highlights the hit on its slide, not a match on a slide that is rendered off screen', async () => {
  const o = await rt<Opened>(app, 'open', path.join(dir, 'find-strip.html'));
  const r = await rt<{ hits: { slide: number; matchIndex: number; text: string }[] }>(app, 'find', o.docId, 'quartz');
  expect(r.hits.map((h) => [h.slide, h.matchIndex])).toEqual([
    [0, 0],
    [2, 0],
    [2, 1],
  ]);
  const h = await rt<{ ok: boolean; ordinal: number; matches: number }>(app, 'highlight', o.docId, 2, r.hits[2].text, r.hits[2].matchIndex);
  // findInPage sees all three (the other slides are transparent and off screen): the second on slide 3 is its third.
  expect(h).toMatchObject({ ok: true, ordinal: 3, matches: 3 });
  const first = await rt<{ ok: boolean; ordinal: number }>(app, 'highlight', o.docId, 0, r.hits[0].text, 0);
  expect(first).toMatchObject({ ok: true, ordinal: 1 });
  await rt(app, 'close', o.docId);

  // A document is one page: the occurrence counts across it, and findInPage scrolls the match into view.
  const doc = await rt<Opened>(app, 'open', path.join(dir, 'document.html'));
  const d = await rt<{ hits: { slide: number; matchIndex: number; text: string }[] }>(app, 'find', doc.docId, 'the closing line');
  expect(d.hits).toHaveLength(1);
  const dh = await rt<{ ok: boolean; ordinal: number; rect: { x: number; y: number; width: number; height: number }; scrollY: number }>(app, 'highlight', doc.docId, d.hits[0].slide, d.hits[0].text, d.hits[0].matchIndex);
  // The match lies below the first screen: findInPage scrolled the page to it. (It reports a newly active match
  // where it was before that scroll, so `rect` is not checked against the view here; Phase 1 finding.)
  expect(dh).toMatchObject({ ok: true, ordinal: 1, matches: 1 });
  expect(dh.scrollY).toBeGreaterThan(0);
  await rt(app, 'close', doc.docId);
});

test('Index replay presses Session.deckNav’s ArrowDown (render-service acceleratorKeyFor)', async () => {
  const plain = await rt<Opened>(app, 'open', path.join(dir, 'arrowdown.html'));
  const without = await rt<Index>(app, 'index', plain.docId);
  expect(without.complete, 'the 6.7 defaults (ArrowRight, PageDown) do not move this deck').toBe(false);
  await rt(app, 'close', plain.docId);
  // The same file again: its index of this version is cached; the deckNav walk rebuilds it with force.
  const o = await rt<Opened>(app, 'open', path.join(dir, 'arrowdown.html'), { deckNav: { forward: 'ArrowDown', back: 'ArrowUp' } });
  const index = await rt<Index>(app, 'index', o.docId, { force: true });
  expect(index.complete).toBe(true);
  expect(index.slides.map((e) => e.title)).toEqual(['Down one', 'Down two', 'Down three', 'Down four']);
  expect(index.slides[3].text).toContain('Zebra quartz.');
  const t = await rt<{ result: { rendered: number; missed: number[] } }>(app, 'thumbs', o.docId, 96);
  expect(t.result).toMatchObject({ missed: [] });
  await rt(app, 'close', o.docId);
});

test('key-gated build steps do not stop the slide visits (F25 patience): every slide gets its thumbnail', async () => {
  const o = await rt<Opened>(app, 'open', path.join(dir, 'builds-many.html'));
  const index = await rt<Index>(app, 'index', o.docId);
  expect(index.complete).toBe(true);
  expect(index.slides[0].text).toEqual(['Builds', 'Step one', 'Step two', 'Step three', 'Step four', 'Step five']);
  const t = await rt<{ result: { rendered: number; missed: number[] } }>(app, 'thumbs', o.docId, 96);
  expect(t.result).toMatchObject({ rendered: 3, missed: [] });
  await rt(app, 'close', o.docId);
});

test('background renders use reduced motion', async () => {
  const o = await rt<Opened>(app, 'open', path.join(dir, 'motion-text.html'));
  const index = await rt<Index>(app, 'index', o.docId);
  expect(index.slides[0].text).toContain('Motion reduced');
  await rt(app, 'close', o.docId);
});

test('a new version renders anew and prunes the old version’s thumbnails and index', async () => {
  const file = path.join(dir, 'version-deck.html');
  fs.copyFileSync(path.join(dir, 'page-css.html'), file);
  s.own(file);
  const v1 = await rt<Opened>(app, 'open', file);
  await rt(app, 'thumbs', v1.docId, 100);
  const tdir = thumbsDir(v1.fileKey);
  expect(fs.readdirSync(tdir).filter((n) => n.startsWith(v1.version))).toHaveLength(3);
  await rt(app, 'close', v1.docId);
  fs.appendFileSync(file, '\n<!-- edited -->\n');
  const v2 = await rt<Opened>(app, 'open', file);
  expect(v2.fileKey).toBe(v1.fileKey);
  expect(v2.version).not.toBe(v1.version);
  const t = await rt<{ result: { rendered: number }; views: number }>(app, 'thumbs', v2.docId, 100);
  expect(t.result.rendered).toBe(3);
  expect(t.views).toBeLessThanOrEqual(2);
  const names = fs.readdirSync(tdir);
  expect(names.filter((n) => n.includes(v1.version)), 'the old version is pruned').toEqual([]);
  expect(names.filter((n) => n.startsWith(v2.version))).toHaveLength(3);
  expect(names).toContain(`index-${v2.version}.json`);
  await rt(app, 'close', v2.docId);
});
