// The deck view at Fit (6.9 Views; PHASE0-FINDINGS F5; docs/PHASE1-PLAN.md: webContents.setZoomFactor, not CSS
// zoom): the deck view's bounds are the design size scaled to fit the content area, centred, and its zoom factor is
// that scale, so the page keeps the design size as its viewport. The deck view's zoom is its own (zoomMode
// 'isolated'): the document's offscreen render views, in the same partition and host, render at 1:1, so the slide
// index walks at 1600×900 and the rail's thumbnails are 152 CSS px at 2x. At Fit < 1 (Review), the overlay draws
// and hit-tests in the page's CSS pixels: a pen loop around a heading targets that heading, and its card opens
// beside the mark.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, loopAround, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';
import { computeLayout, deckBounds } from '../../packages/app/src/main/layout';
import { computeViewLayout } from '../../packages/app/src/main/views';
import type { Note } from '../../packages/core/src/types';

test.describe.configure({ mode: 'serial' });

interface ViewInfo {
  zoomFactor: number;
  deckBounds: { x: number; y: number; width: number; height: number };
  containerBounds: { x: number; y: number; width: number; height: number };
  contentSize: [number, number];
  view: { kind: string | null; zoom: number; zoomMode: string; design: { w: number; h: number } };
  state: { layout: Record<string, number>; appMode: string; index: { ready: boolean } | null; view: { zoom: number } };
  sessionFile: string;
  realpath: string;
}

async function info(app: BlApp, docId: string): Promise<ViewInfo> {
  return (await app.win(docId)) as unknown as ViewInfo;
}

/** What views.ts computes for this window now (the test recomputes it from the layout main reports). */
function expected(i: ViewInfo) {
  const [width, height] = i.contentSize;
  const l = i.state.layout;
  const layout = computeLayout({
    width,
    height,
    appMode: i.state.appMode as 'read',
    trustBarVisible: l.trustBar > 0,
    bannerVisible: l.banner > 0,
    findBarVisible: l.findBar > 0,
    railHidden: l.leftRail === 0,
  });
  return computeViewLayout({
    area: deckBounds(layout, { width, height }),
    kind: 'deck',
    design: i.view.design,
    zoomMode: 'fit',
    readingWidth: false,
    presenting: false,
    scroll: { x: 0, y: 0 },
    dpr: 1,
  });
}

async function readNotes(file: string): Promise<Note[]> {
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { notes?: Note[] }).notes ?? [];
  } catch {
    return [];
  }
}

/** The box of a stored mark path: a snapped ellipse (`M x cy A rx ry …`, geometry.ts) or a polyline. */
function markBox(d: string): { x0: number; y0: number; x1: number; y1: number } {
  const e = /^M(-?[\d.]+) (-?[\d.]+) A(-?[\d.]+) (-?[\d.]+)/.exec(d);
  if (e) {
    const [x, cy, rx, ry] = e.slice(1).map(Number);
    return { x0: x, y0: cy - ry, x1: x + 2 * rx, y1: cy + ry };
  }
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const xs = nums.filter((_, k) => k % 2 === 0);
  const ys = nums.filter((_, k) => k % 2 === 1);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** The deck view's pixels (capturePage: DIP × the display scale, 1 under Xvfb), BGRA. */
async function capture(app: BlApp, deck: DeckView): Promise<{ w: number; h: number; px: Buffer }> {
  const r = await app.electronApp.evaluate(async ({ webContents }, id) => {
    const img = await webContents.fromId(id)!.capturePage();
    const s = img.getSize();
    return { w: s.width, h: s.height, b64: img.toBitmap().toString('base64') };
  }, deck.wcId);
  return { w: r.w, h: r.h, px: Buffer.from(r.b64, 'base64') };
}

/** Pixels within `tol` of an RGB colour inside a rectangle of the capture. */
function countColour(c: { w: number; h: number; px: Buffer }, rgb: [number, number, number], rect: { x0: number; y0: number; x1: number; y1: number }, tol = 6): number {
  let n = 0;
  for (let y = Math.max(0, Math.floor(rect.y0)); y < Math.min(c.h, Math.ceil(rect.y1)); y++) {
    for (let x = Math.max(0, Math.floor(rect.x0)); x < Math.min(c.w, Math.ceil(rect.x1)); x++) {
      const i = (y * c.w + x) * 4;
      if (Math.abs(c.px[i + 2] - rgb[0]) <= tol && Math.abs(c.px[i + 1] - rgb[1]) <= tol && Math.abs(c.px[i] - rgb[2]) <= tol) n++;
    }
  }
  return n;
}

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

test('Fit: the zoom factor is the computed scale, the page keeps the design size, and the render views are not zoomed', async () => {
  const dir = scratch.dir('views-fit');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    // The slide index (render-products) gives the design size; until then the view fits 1600×900 (6.9 default).
    await expect.poll(async () => (await info(app, deck.docId)).state.index?.ready ?? false, { timeout: 60_000 }).toBe(true);
    const i = await info(app, deck.docId);
    expect(i.view.kind).toBe('deck');
    expect(i.view.design).toEqual({ w: 1600, h: 900 });
    const e = expected(i);
    expect(i.zoomFactor).toBeCloseTo(e.zoom, 6);
    expect(i.zoomFactor).toBeLessThan(1);
    expect(i.state.view.zoom).toBeCloseTo(e.zoom, 6);
    expect(i.containerBounds).toEqual(e.container);
    expect(i.deckBounds).toEqual({ x: e.container.x + e.deck.x, y: e.container.y + e.deck.y, width: e.deck.width, height: e.deck.height });
    // Letterboxed: centred in the content area, which is wider than 16:9 here.
    expect(i.deckBounds.width).toBe(e.container.width);
    expect(i.deckBounds.height).toBeLessThan(e.container.height);
    // F5: the page's viewport is the design size (vw, vh and media queries resolve as at 1600×900).
    await expect
      .poll(async () => {
        const vp = await deck.eval<[number, number]>('[innerWidth, innerHeight]');
        return Math.abs(vp[0] - 1600) <= 1 && Math.abs(vp[1] - 900) <= 1;
      })
      .toBe(true);
    // The status bar says it (6.0: "Fit · 85%").
    const shell = await app.shellPage(deck.docId);
    await expect(shell.locator('#status-left')).toContainText(`Fit · ${Math.round(e.zoom * 100)}%`);

    // The render views share the partition and the host but not the zoom: the index walked at 1600×900 (design
    // 1600×900 above), and the thumbnails are 152 CSS px at 2x.
    await expect.poll(async () => shell.locator('#slide-list img').count(), { timeout: 60_000 }).toBe(6);
    const sizes = await shell.locator('#slide-list img').evaluateAll((imgs) =>
      Promise.all((imgs as HTMLImageElement[]).map((im) => (im.complete ? Promise.resolve() : new Promise((r) => im.addEventListener('load', r, { once: true })))).map((p, k) => p.then(() => [(imgs[k] as HTMLImageElement).naturalWidth, (imgs[k] as HTMLImageElement).naturalHeight]))),
    );
    for (const [w, h] of sizes) {
      expect(w).toBe(304);
      expect(h).toBe(172);
    }
  } finally {
    await app.close();
  }
});

test('at Fit < 1 the overlay draws and hit-tests in page pixels: the loop targets the heading, and its card opens beside it', async () => {
  const dir = scratch.dir('views-fit-card');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    await deck.chord('2');
    await expect.poll(async () => (await info(app, deck.docId)).state.appMode).toBe('review');
    // Review shows the notes panel: the area is narrower and the zoom smaller.
    await expect.poll(async () => (await info(app, deck.docId)).zoomFactor).toBeLessThan(0.7);
    await sleep(300);
    const z = (await info(app, deck.docId)).zoomFactor;
    const css = (await deck.rect('h1'))!;
    expect(css).not.toBeNull();
    // The page reports CSS pixels; sendInputEvent takes the view's DIPs (CSS × zoom).
    const view = { x: css.x * z, y: css.y * z, w: css.w * z, h: css.h * z };
    await deck.key('1'); // pen
    await deck.drag(loopAround(view, 10));
    const sessionFile = (await info(app, deck.docId)).sessionFile;
    let notes: Note[] = [];
    await expect
      .poll(async () => {
        notes = await readNotes(sessionFile);
        return notes.length > 0 && notes[0].marks.length > 0;
      })
      .toBe(true);
    // The mark is stored in page pixels, around the heading's CSS box (not the zoomed one).
    const box = markBox(notes[0].marks[0].path ?? '');
    expect(box.x0).toBeLessThan(css.x);
    expect(box.x1).toBeGreaterThan(css.x + css.w);
    expect(box.y0).toBeLessThan(css.y);
    expect(box.y1).toBeGreaterThan(css.y + css.h);
    // Hit-testing found the heading under the loop.
    expect(notes[0].targets.some((t) => (t.text ?? '').includes('Q3 business review'))).toBe(true);

    // The card opened beside the mark (card.ts place(): right of the mark, else left, else below; in page
    // pixels): its focused textarea's outline (#93c5fd) is there at the zoom, and not on the slide's far side.
    await sleep(300);
    const vw = await deck.eval<number>('innerWidth');
    const vh = await deck.eval<number>('innerHeight');
    const a = { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 };
    let cx = a.x + a.w + 14;
    let cy = a.y;
    if (cx + 320 > vw - 8) cx = a.x - 14 - 320;
    if (cx < 8) {
      cx = Math.min(Math.max(8, a.x), vw - 320 - 8);
      cy = a.y + a.h + 14;
    }
    const shot = await capture(app, deck);
    const inCard = countColour(shot, [0x93, 0xc5, 0xfd], { x0: (cx - 4) * z, y0: (cy - 4) * z, x1: (cx + 324) * z, y1: Math.min(vh, cy + 220) * z });
    const elsewhere = countColour(shot, [0x93, 0xc5, 0xfd], { x0: 0, y0: 0, x1: shot.w, y1: Math.max(0, a.y * z - 4) });
    expect(inCard, `the card is drawn at ${Math.round(cx)},${Math.round(cy)} (page px), × the zoom`).toBeGreaterThan(20);
    expect(elsewhere).toBe(0);
    // And it takes typing (the textarea has focus): the text reaches the note.
    await deck.insertText('axis at zero');
    await expect.poll(async () => (await readNotes(sessionFile))[0]?.text ?? '').toContain('axis at zero');
  } finally {
    await app.close();
  }
});
