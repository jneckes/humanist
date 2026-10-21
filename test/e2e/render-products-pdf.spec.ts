// Save as PDF and Print in the real app (6.9 Save as PDF, Print; section 11 Render parity and PDF): a raster
// deck (one page per slide at the slide's aspect, the title from <title>), print-CSS decks (preferCSSPageSize
// honoured; a linked same-folder sheet read), decks whose print CSS does not print them as slide pages (an
// @page rule alone, @media print on the default paper: rendered slide by slide, decision D-6), documents
// (Letter or A4 by the injected locale), a document
// without a <title> (the URL never becomes the title), notes never printed, and Print through the same
// pipeline with printToPDF in place of the system dialog. Driven through the test build's main-process
// harness (`__blRenderTest`, pdf-command.ts). pdfinfo/pdftotext (poppler) check the files independently
// when installed.

import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, type BlApp } from '../helpers/app';

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

async function open(file: string): Promise<string> {
  return (await rt<{ docId: string }>('open', path.join(dir, file))).docId;
}

/** Page sizes in points, rounded to 0.01. */
async function pageSizes(file: string): Promise<{ w: number; h: number }[]> {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  return doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    return { w: Math.round(width * 100) / 100, h: Math.round(height * 100) / 100 };
  });
}

function has(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
}

/** pdfinfo's fields, or null when poppler is not installed. */
function pdfinfo(file: string): Record<string, string> | null {
  if (!has('pdfinfo')) return null;
  const r = spawnSync('pdfinfo', ['-enc', 'UTF-8', file], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  const out: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) out[m[1].trim()] = m[2];
  }
  return out;
}

test.beforeAll(async () => {
  s = new Scratch(resolveRunAs());
  dir = s.dir('pdf');
  outDir = s.dir('pdf-out');
  fs.cpSync(path.join(FIXTURES, 'decks/reveal-hash'), path.join(dir, 'reveal'), { recursive: true });
  for (const f of ['generic-index.html', 'single.html']) copyInto(path.join(FIXTURES, 'decks', f), dir);
  for (const f of fs.readdirSync(path.join(FIXTURES, 'render'))) copyInto(path.join(FIXTURES, 'render', f), dir);
  s.own(dir);
  app = await launchApp({ files: [path.join(dir, 'single.html')], scratch: s });
  await app.waitForDeck('single.html');
});

test.afterAll(async () => {
  await app?.close();
  s?.cleanup();
});

test('a raster deck: one page per slide, each the slide’s aspect at 0.75 pt per px, the title from <title>', async () => {
  const id = await open('generic-index.html');
  const index = await rt<{ slides: unknown[]; designSize: { w: number; h: number } }>('index', id);
  const out = path.join(outDir, 'generic-index.pdf');
  const r = await rt<PdfResult>('pdf', id, out);
  expect(r).toEqual({ out, pages: index.slides.length, mode: 'raster', title: 'Q3 business review', missed: [] });
  const sizes = await pageSizes(out);
  expect(sizes).toHaveLength(6);
  for (const p of sizes) expect(p).toEqual({ w: index.designSize.w * 0.75, h: index.designSize.h * 0.75 });
  expect((await PDFDocument.load(fs.readFileSync(out))).getTitle()).toBe('Q3 business review');
  const info = pdfinfo(out);
  if (info) {
    expect(info.Title).toBe('Q3 business review');
    expect(info.Pages).toBe('6');
  }

  // reveal.js: the page has the configured design size's aspect.
  const rv = await open('reveal/index.html');
  const ri = await rt<{ slides: unknown[]; designSize: { w: number; h: number } }>('index', rv);
  const rout = path.join(outDir, 'reveal.pdf');
  const rr = await rt<PdfResult>('pdf', rv, rout);
  expect(rr).toMatchObject({ pages: 8, mode: 'raster', title: 'Northwind 2027 strategy', missed: [] });
  for (const p of await pageSizes(rout)) expect(p.w / p.h).toBeCloseTo(ri.designSize.w / ri.designSize.h, 3);
});

test('a <title> that needs escaping becomes the PDF title exactly', async () => {
  const id = await open('title-escape.html');
  const out = path.join(outDir, 'title.pdf');
  const r = await rt<PdfResult>('pdf', id, out);
  const want = 'Q&A: “Growth” <2027> (draft) \\ ½ — Ünïcödé 🎉 \'26';
  expect(r).toMatchObject({ mode: 'raster', pages: 3, title: want });
  expect((await PDFDocument.load(fs.readFileSync(out))).getTitle()).toBe(want);
  const info = pdfinfo(out);
  if (info) expect(info.Title).toBe(want);
});

test('print CSS: an @page rule (preferCSSPageSize honoured), a linked sibling sheet, and @media print alone', async () => {
  const page = await open('page-css.html');
  const out = path.join(outDir, 'page-css.pdf');
  expect(await rt<PdfResult>('pdf', page, out)).toMatchObject({ mode: 'print-css', pages: 3, title: 'Print CSS deck' });
  // @page { size: 1280px 720px } → 960 × 540 pt.
  expect(await pageSizes(out)).toEqual(Array(3).fill({ w: 960, h: 540 }));
  const raw = fs.readFileSync(out).toString('latin1');
  expect(raw).toContain('Skia/PDF');
  expect(raw).not.toContain('blueline://');
  const info = pdfinfo(out);
  if (info) expect(info.Title).toBe('Print CSS deck');

  const linked = await open('linked-print.html');
  const lout = path.join(outDir, 'linked.pdf');
  expect(await rt<PdfResult>('pdf', linked, lout)).toMatchObject({ mode: 'print-css', pages: 3 });
  for (const p of await pageSizes(lout)) {
    expect(p.w).toBeCloseTo(1200, 0);
    expect(p.h).toBeCloseTo(675, 0);
  }

  // @media print alone on the default paper: one Letter page per slide is not the slide's aspect, so the
  // slides are rendered instead (decision D-6; review finding 35), each page the slide's aspect.
  const media = await open('media-print.html');
  const mout = path.join(outDir, 'media.pdf');
  const mi = await rt<{ designSize: { w: number; h: number } }>('index', media);
  expect(await rt<PdfResult>('pdf', media, mout)).toMatchObject({ mode: 'raster', pages: 4, missed: [] });
  for (const p of await pageSizes(mout)) expect(p.w / p.h).toBeCloseTo(mi.designSize.w / mi.designSize.h, 3);

  // A print layout that is not one page per slide: the slides are rendered instead.
  const flow = await open('media-print-flow.html');
  const fout = path.join(outDir, 'flow.pdf');
  expect(await rt<PdfResult>('pdf', flow, fout)).toMatchObject({ mode: 'raster', pages: 4 });
  expect(await pageSizes(fout)).toEqual(Array(4).fill({ w: 1200, h: 675 }));
});

/** The colour in the middle of each page of a PDF (pdftoppm at a low resolution). */
function pageColours(file: string): [number, number, number][] {
  expect(has('pdftoppm'), 'pdftoppm (poppler-utils) reads the pages here').toBe(true);
  const out: [number, number, number][] = [];
  for (let page = 1; page <= 50; page++) {
    const r = spawnSync('pdftoppm', ['-r', '8', '-f', String(page), '-l', String(page), file], { maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || r.stdout.length === 0) break;
    const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(r.stdout.subarray(0, 64).toString('latin1'));
    expect(m, 'a P6 image').not.toBeNull();
    const [w, h] = [Number(m![1]), Number(m![2])];
    const at = m![0].length + (Math.floor(h / 2) * w + Math.floor(w / 2)) * 3;
    out.push([r.stdout[at], r.stdout[at + 1], r.stdout[at + 2]]);
  }
  return out;
}

test('an @page rule alone is no print layout: the deck is rendered slide by slide, every slide a page in slide order (decision D-6; review finding 9)', async () => {
  // pagemargin.html: only `@page { margin: 0 }`; pagesize.html: only `@page { size: 1280px 720px; margin: 0 }`.
  // Chromium's print of either is the screen layout, slide 1 alone.
  const red = (c: number[]) => c[0] > 150 && c[1] < 100 && c[2] < 100;
  const green = (c: number[]) => c[0] < 100 && c[1] > 150 && c[2] < 100;
  const blue = (c: number[]) => c[0] < 100 && c[1] < 100 && c[2] > 150;
  const yellow = (c: number[]) => c[0] > 150 && c[1] > 150 && c[2] < 100;
  for (const file of ['pagemargin.html', 'pagesize.html']) {
    const id = await open(file);
    const out = path.join(outDir, file.replace(/\.html$/, '.pdf'));
    expect(await rt<PdfResult>('pdf', id, out), file).toMatchObject({ mode: 'raster', pages: 4, missed: [] });
    expect(await pageSizes(out)).toEqual(Array(4).fill({ w: 960, h: 540 }));
    const colours = pageColours(out);
    expect([red(colours[0]), green(colours[1]), blue(colours[2]), yellow(colours[3])], `${file}: slides 1 to 4 in order`).toEqual([true, true, true, true]);
    const printed = path.join(outDir, file.replace(/\.html$/, '-print.pdf'));
    expect(await rt<{ ok: boolean; mode: string; pages: number }>('print', id, printed), file).toMatchObject({ ok: true, mode: 'raster', pages: 4 });
    await rt('close', id);
  }

  // reveal.js with an @page rule: Chromium prints reveal's paper handout (9 pages for 8 slides), so raster.
  const rv = path.join(dir, 'reveal-page');
  fs.cpSync(path.join(dir, 'reveal'), rv, { recursive: true });
  const html = path.join(rv, 'index.html');
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('</head>', '<style>@page { size: 960px 700px; margin: 0; }</style>\n</head>'));
  s.own(rv);
  const rid = await open('reveal-page/index.html');
  const rout = path.join(outDir, 'reveal-page.pdf');
  expect(await rt<PdfResult>('pdf', rid, rout)).toMatchObject({ mode: 'raster', pages: 8, missed: [] });
  await rt('close', rid);
});

test('a document: Letter or A4 by the locale, its title, and never the notes block', async () => {
  const id = await open('document.html');
  const us = path.join(outDir, 'doc-us.pdf');
  const de = path.join(outDir, 'doc-de.pdf');
  const mx = path.join(outDir, 'doc-mx.pdf');
  expect(await rt<PdfResult>('pdf', id, us, { locale: 'en-US' })).toMatchObject({ mode: 'document', title: 'Field notes' });
  await rt<PdfResult>('pdf', id, de, { locale: 'de-DE' });
  await rt<PdfResult>('pdf', id, mx, { locale: 'es-MX' });
  for (const p of await pageSizes(us)) expect(p).toEqual({ w: 612, h: 792 });
  for (const p of await pageSizes(mx)) expect(p).toEqual({ w: 612, h: 792 });
  for (const p of await pageSizes(de)) {
    // A4 is 595.28 × 841.89 pt; Chromium rounds to its device units.
    expect(p.w).toBeCloseTo(595.5, 0);
    expect(p.h).toBeCloseTo(842.5, 0);
  }
  if (has('pdftotext')) {
    const text = spawnSync('pdftotext', ['-enc', 'UTF-8', us, '-'], { encoding: 'utf8' }).stdout;
    expect(text).toContain('Résumé screening was the slowest step.');
    expect(text).not.toContain('QUARTZNOTE');
    expect(text).not.toContain('Invisible paragraph');
  }
});

test('a document without a <title>: no title, and its URL (with the docId) is nowhere in the file', async () => {
  const id = await open('no-title-doc.html');
  const out = path.join(outDir, 'no-title.pdf');
  expect(await rt<PdfResult>('pdf', id, out)).toMatchObject({ mode: 'document', title: null });
  const raw = fs.readFileSync(out).toString('latin1');
  expect(raw).not.toContain('blueline://');
  expect(raw).not.toContain(id);
  expect((await PDFDocument.load(fs.readFileSync(out))).getTitle()).toBeUndefined();
  const info = pdfinfo(out);
  if (info) expect(info.Title).toBeUndefined();
});

test('the PDF never overwrites the document, and a refused output leaves it untouched', async () => {
  const id = await open('page-css.html');
  const deck = path.join(dir, 'page-css.html');
  const before = fs.readFileSync(deck);
  await expect(rt('pdf', id, deck)).rejects.toThrow(/overwrite the document itself/);
  await expect(rt('pdf', id, path.join(dir, 'page-css.txt'))).rejects.toThrow(/not a \.pdf/);
  expect(fs.readFileSync(deck).equals(before)).toBe(true);
});

test('Print: the same pipeline, then the print call (printToPDF in place of the system dialog)', async () => {
  // A raster deck prints a print-only document of its slide images, from app data, in a window that runs no script.
  const raster = await open('title-escape.html');
  const rout = path.join(outDir, 'print-raster.pdf');
  const r = await rt<{ ok: boolean; mode: string; pages: number; missed: number[]; seen: { url: string; options: Record<string, unknown>; overlay: boolean | null }[] }>('print', raster, rout);
  expect(r).toMatchObject({ ok: true, mode: 'raster', pages: 3, missed: [] });
  expect(r.seen).toHaveLength(1);
  expect(r.seen[0].url).toBe('blueline://ID/print.html');
  expect(r.seen[0].options).toMatchObject({ silent: false, printBackground: true, landscape: true, margins: { marginType: 'none' } });
  expect(r.seen[0].overlay).not.toBe(true);
  const printed = await PDFDocument.load(fs.readFileSync(rout));
  expect(printed.getPageCount()).toBe(3);
  // The deck's title went through the print document's escaped <title>.
  expect(printed.getTitle()).toBe('Q&A: “Growth” <2027> (draft) \\ ½ — Ünïcödé 🎉 \'26');
  // The print folder is gone afterwards.
  const files = path.join(app.userData, 'files');
  const left = fs.readdirSync(files).flatMap((k) => (fs.existsSync(path.join(files, k, 'print')) ? fs.readdirSync(path.join(files, k, 'print')) : []));
  expect(left).toEqual([]);

  // Print CSS: printed from the render view itself, which shows no overlay.
  const css = await open('page-css.html');
  const c = await rt<{ ok: boolean; mode: string; seen: { url: string; options: Record<string, unknown>; overlay: boolean | null }[] }>('print', css, path.join(outDir, 'print-css.pdf'));
  expect(c).toMatchObject({ ok: true, mode: 'print-css' });
  expect(c.seen[0].url).toBe('blueline://ID/page-css.html');
  expect(c.seen[0].overlay).toBe(false);
  expect(c.seen[0].options).toMatchObject({ silent: false, printBackground: true });

  // A document: the locale's paper.
  const doc = await open('document.html');
  const d = await rt<{ ok: boolean; mode: string; seen: { options: Record<string, unknown>; overlay: boolean | null }[] }>('print', doc, path.join(outDir, 'print-doc.pdf'), { locale: 'de-DE' });
  expect(d).toMatchObject({ ok: true, mode: 'document' });
  expect(d.seen[0].options.pageSize).toBe('A4');
  expect(d.seen[0].overlay).toBe(false);
});

test('a PDF running when its document closes settles at once (disposeRenderer cancels it) and writes nothing', async () => {
  // The views item saw a closed window's render job wait forever on a destroyed webContents and keep the
  // document in memory; RenderView now rejects whatever still waits on a closed view (RenderCancelled).
  // A copy no walk has seen (its own file key): the index walk pays the full scripted settle on every slide,
  // and the raster walk then waits on each slide too (the adaptive settle, decision D-5).
  const file = path.join(dir, 'closed-mid-way.html');
  fs.copyFileSync(path.join(dir, 'generic-index.html'), file);
  s.own(file);
  const id = await open('closed-mid-way.html');
  const out = path.join(outDir, 'closed-mid-way.pdf');
  const settled = rt('pdf', id, out).then(
    () => 'resolved',
    (e: unknown) => String(e instanceof Error ? e.message : e),
  );
  // Closed once the index is built, while the raster walk is on its slides.
  await expect.poll(() => app.logsMatching(/slide index: closed-mid-way\.html: generic/).length, { timeout: 60_000 }).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, 800));
  const closedAt = Date.now();
  await rt('close', id);
  const outcome = await Promise.race([settled, new Promise<string>((r) => setTimeout(() => r('still pending'), 15_000))]);
  test.info().annotations.push({ type: 'outcome', description: outcome.slice(0, 300) });
  // Cancelled, wherever the close lands: never a failure such as "a render view showed the overlay" (a probe of
  // the closed view answered with its fallback, seen under load) or a load error from a new renderer of the closed
  // document (a later stage of the job asking rendererFor again).
  expect(outcome).toMatch(/\bRenderCancelled: /);
  expect(Date.now() - closedAt).toBeLessThan(15_000);
  expect(fs.existsSync(out)).toBe(false);
  expect(fs.readdirSync(outDir).filter((f) => f.includes('closed-mid-way'))).toEqual([]);
});
