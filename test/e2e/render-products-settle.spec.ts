// Script-timed content in every render product (decision D-5; review findings 10 and 11): the scripted settle
// a still image of a slide waits (RenderView.waitScripted) also runs before every print of a document or a
// print-CSS deck (Save as PDF and Print), and before the slide index reads a slide's text (Find), in the same
// walk as the rail's thumbnails. Driven through the test build's main-process harness (`__blRenderTest`,
// pdf-command.ts) and, for Find in a window, `__blTest`. poppler (pdftotext, pdftoppm) reads the PDFs.

import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, ROOT, Scratch, copyInto, launchApp, resolveRunAs, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });
test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run through `npm run test:e2e` (its global setup starts Xvfb)');
test.setTimeout(300_000);

interface PdfResult {
  out: string;
  pages: number;
  mode: 'print-css' | 'raster' | 'document';
  title: string | null;
  missed: number[];
}
interface Hit {
  slide: number;
  matchIndex: number;
  text: string;
}

let s: Scratch;
let app: BlApp;
let dir: string;
let outDir: string;

function rt<T>(fn: string, ...args: unknown[]): Promise<T> {
  return app.electronApp.evaluate(
    async (_e, a) => (globalThis as unknown as Record<string, Record<string, (...x: unknown[]) => unknown>>).__blRenderTest[a.fn](...a.args),
    { fn, args },
  ) as Promise<T>;
}

async function open(file: string): Promise<{ docId: string; fileKey: string; version: string }> {
  return rt('open', path.join(dir, file));
}

function poppler(): void {
  for (const cmd of ['pdftotext', 'pdftoppm']) expect(spawnSync('sh', ['-c', `command -v ${cmd}`]).status, `${cmd} (poppler-utils) reads the PDFs here`).toBe(0);
}

function pdfText(file: string): string {
  const r = spawnSync('pdftotext', ['-enc', 'UTF-8', '-layout', file, '-'], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/** Page `page` (1-based) of a PDF as RGB pixels at `dpi`. */
function pageImage(file: string, page: number, dpi: number): { width: number; height: number; rgb: Buffer } {
  const r = spawnSync('pdftoppm', ['-r', String(dpi), '-f', String(page), '-l', String(page), file], { maxBuffer: 256 * 1024 * 1024 });
  expect(r.status, String(r.stderr)).toBe(0);
  return parsePpm(r.stdout);
}

/** A binary PPM (P6, maxval 255). */
function parsePpm(b: Buffer): { width: number; height: number; rgb: Buffer } {
  const fields: string[] = [];
  let i = 0;
  while (fields.length < 4) {
    while (/\s/.test(String.fromCharCode(b[i]))) i++;
    if (b[i] === 0x23) {
      while (b[i] !== 0x0a) i++;
      continue;
    }
    let tok = '';
    while (!/\s/.test(String.fromCharCode(b[i]))) tok += String.fromCharCode(b[i++]);
    fields.push(tok);
  }
  expect(fields[0]).toBe('P6');
  const width = Number(fields[1]);
  const height = Number(fields[2]);
  return { width, height, rgb: b.subarray(i + 1, i + 1 + width * height * 3) };
}

/** Pixels within `tol` of colour `c`. */
function countColour(img: { rgb: Buffer }, c: [number, number, number], tol = 24): number {
  let n = 0;
  for (let p = 0; p + 2 < img.rgb.length; p += 3) {
    if (Math.abs(img.rgb[p] - c[0]) <= tol && Math.abs(img.rgb[p + 1] - c[1]) <= tol && Math.abs(img.rgb[p + 2] - c[2]) <= tol) n++;
  }
  return n;
}

/** The print stand-in of `__blRenderTest.print`: printToPDF of the page that would go to the system dialog. */
async function print(docId: string, out: string): Promise<{ ok: boolean; mode: string; pages: number | null }> {
  return rt('print', docId, out, { locale: 'en-US' });
}

const BAR_BLUE: [number, number, number] = [0x2d, 0x6c, 0xdf];
/** The finished bar: 100 × 280 CSS px, so at 96 dpi about 28,000 pixels of the bar's blue. */
const BAR_PIXELS = 100 * 280;

test.beforeAll(async () => {
  s = new Scratch(resolveRunAs());
  dir = s.dir('settle');
  outDir = s.dir('settle-out');
  for (const f of ['chart-doc.html', 'chart-below-doc.html', 'timer-print.html', 'timer-deck.html', 'timer-doc.html', 'canvas-deck.html']) copyInto(path.join(FIXTURES, 'render', f), dir);
  copyInto(path.join(FIXTURES, 'decks', 'single.html'), dir);
  // The committed repro of D5's timer reveal (docs/PHASE1-RESULTS.md, PDF).
  copyInto(path.join(ROOT, 'test/parity/fixtures/delayed-build.html'), dir);
  s.own(dir);
  app = await launchApp({ files: [path.join(dir, 'single.html')], scratch: s });
  await app.waitForDeck('single.html');
});

test.afterAll(async () => {
  await app?.close();
  s?.cleanup();
});

test('Save as PDF and Print of a document print what its scripts draw and fill in after load (review finding 10)', async () => {
  poppler();
  const o = await open('chart-doc.html');
  const out = path.join(outDir, 'chart.pdf');
  expect(await rt<PdfResult>('pdf', o.docId, out, { locale: 'en-US' })).toMatchObject({ mode: 'document', title: 'Chart report' });
  const printed = path.join(outDir, 'chart-print.pdf');
  expect(await print(o.docId, printed)).toMatchObject({ ok: true, mode: 'document' });
  for (const f of [out, printed]) {
    const text = pdfText(f);
    expect(text, f).toContain('BAR COMPLETE');
    expect(text, f).toContain('RESULTS FILLED AT 300 MS');
    expect(text, f).toContain('SUMMARY FILLED AT 800 MS');
    expect(text, f).not.toContain('LOADING');
    // The bar is drawn to its full height: the page image holds the whole bar, not a strip.
    const blue = countColour(pageImage(f, 1, 96), BAR_BLUE);
    expect(blue, `${f}: the bar's pixels`).toBeGreaterThan(BAR_PIXELS * 0.9);
  }
  await rt('close', o.docId);
});

test('a document whose only timed content is a canvas chart below the first screen is printed whole, even after the index walk (review finding 10 re-verification)', async () => {
  poppler();
  const o = await open('chart-below-doc.html');
  // The index walk runs first (slot null, a full wait). Its DOM observer sees no mutation and its picture check
  // samples only the first screen, so before the fix it learnt the page "quiet" and Save as PDF / Print then used
  // the no-minimum wait and printed the bar at about 58%. A document's page keeps the full wait.
  await rt('index', o.docId);
  const out = path.join(outDir, 'chart-below.pdf');
  expect(await rt<PdfResult>('pdf', o.docId, out, { locale: 'en-US' })).toMatchObject({ mode: 'document' });
  const printed = path.join(outDir, 'chart-below-print.pdf');
  expect(await print(o.docId, printed)).toMatchObject({ ok: true, mode: 'document' });
  for (const f of [out, printed]) {
    // The bar is below the first screen, so it may land on a later page: count its blue across every page.
    const info = spawnSync('pdfinfo', [f], { encoding: 'utf8' }).stdout ?? '';
    const pages = Number(/Pages:\s*(\d+)/.exec(info)?.[1] ?? '1');
    let blue = 0;
    for (let p = 1; p <= pages; p++) blue += countColour(pageImage(f, p, 96), BAR_BLUE);
    expect(blue, `${f}: the whole bar (not a mid-animation strip)`).toBeGreaterThan(BAR_PIXELS * 0.9);
  }
  await rt('close', o.docId);
});

test('a print-CSS deck is printed after the timer that fills its slides (review finding 10)', async () => {
  poppler();
  const o = await open('timer-print.html');
  const filled = (f: string) => {
    const text = pdfText(f);
    for (const n of [1, 2, 3]) expect(text, f).toContain(`TIMER FILLED ${n}`);
    expect(text, f).not.toContain('PENDING');
  };
  const out = path.join(outDir, 'timer-print.pdf');
  expect(await rt<PdfResult>('pdf', o.docId, out)).toMatchObject({ mode: 'print-css', pages: 3, missed: [] });
  filled(out);
  const printed = path.join(outDir, 'timer-print-print.pdf');
  expect(await print(o.docId, printed)).toMatchObject({ ok: true, mode: 'print-css', pages: 3 });
  filled(printed);
  await rt('close', o.docId);
});

test('the slide index reads each slide after what its scripts reveal: Find has a hit on every slide, and the document’s late text (review finding 11)', async () => {
  const deck = await open('timer-deck.html');
  const r = await rt<{ hits: Hit[]; pending: boolean }>('find', deck.docId, 'zebra');
  expect(r.pending).toBe(false);
  expect(r.hits.map((h) => [h.slide, h.text])).toEqual([
    [0, 'Zebra'],
    [1, 'Zebra'],
    [2, 'Zebra'],
  ]);
  // The rail's thumbnails were taken in the same walk (one wait per slide): the thumbnail run at the rail's
  // width finds every one cached.
  const t = await rt<{ result: { rendered: number; cached: number; missed: number[] } }>('thumbs', deck.docId, 152);
  expect(t.result).toMatchObject({ rendered: 0, cached: 3, missed: [] });
  await rt('close', deck.docId);

  const doc = await open('timer-doc.html');
  const d = await rt<{ hits: Hit[] }>('find', doc.docId, 'quokka');
  expect(d.hits.map((h) => h.text)).toEqual(['Quokka', 'Quokka']);
  await rt('close', doc.docId);
});

test('Find in the app’s own window has the timer-revealed text of every slide (review finding 11)', async () => {
  const file = path.join(dir, 'timer-deck-window.html');
  fs.copyFileSync(path.join(dir, 'timer-deck.html'), file);
  s.own(file);
  const docId = await app.open(file);
  expect(docId).not.toBeNull();
  const find = () => app.electronApp.evaluate((_e, a) => (globalThis as unknown as { __blTest: { find(d: string, q: string): { pending: boolean; hits: Hit[] } | null } }).__blTest.find(a.id, 'zebra'), { id: docId as string });
  await expect.poll(async () => (await find())?.pending ?? true, { timeout: 120_000 }).toBe(false);
  expect((await find())!.hits.map((h) => h.slide)).toEqual([0, 1, 2]);
  await app.closeDoc(docId as string);
});

test('delayed-build.html (a panel a timer shows 400 ms after each slide arrives) is still captured complete in every raster page', async () => {
  poppler();
  const o = await open('delayed-build.html');
  const out = path.join(outDir, 'delayed.pdf');
  expect(await rt<PdfResult>('pdf', o.docId, out)).toMatchObject({ mode: 'raster', pages: 3, missed: [] });
  for (const page of [1, 2, 3]) {
    // The panel: 1200 × 500 of #2d6cdf on a 1600 × 900 slide, a large share of the page.
    const img = pageImage(out, page, 24);
    const share = countColour(img, BAR_BLUE) / (img.width * img.height);
    expect(share, `page ${page}: the panel is there`).toBeGreaterThan(0.3);
  }
  await rt('close', o.docId);
});

test('the adaptive settle keeps the full wait where a canvas still moves after the DOM is still: every raster page has its whole bar', async () => {
  poppler();
  const o = await open('canvas-deck.html');
  // The index walk (full waits) learns first; then the raster walk, where a slide that looked still would get
  // the quiet-only wait. These slides do not look still: their bars grow for 1 s with no DOM change.
  await rt('index', o.docId);
  const out = path.join(outDir, 'canvas.pdf');
  expect(await rt<PdfResult>('pdf', o.docId, out)).toMatchObject({ mode: 'raster', pages: 3, missed: [] });
  for (const page of [1, 2, 3]) {
    // The bar: 200 × 560 px of a 1600 × 900 slide, 7.8% of the page when it is whole.
    const img = pageImage(out, page, 24);
    const share = countColour(img, BAR_BLUE) / (img.width * img.height);
    expect(share, `page ${page}: the whole bar`).toBeGreaterThan(0.07);
  }
  await rt('close', o.docId);
});
