// 6.9 Save as PDF's pure parts: print-CSS detection, the mode, the page size by locale, the title set on
// printToPDF's output (incrementally, or rewritten), the raster pages, and the output checks. Real-Electron
// runs: test/e2e/render-products-pdf.spec.ts.
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inflateSync } from 'node:zlib';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getLocale: () => 'en-US', getSystemLocale: () => 'de-DE', getLocaleCountryCode: () => '', on() {}, once() {}, removeListener() {}, isPackaged: false },
  BrowserWindow: class {},
  ipcMain: { on() {}, handle() {} },
  session: { fromPartition: () => ({}) },
}));

/** A stand-in for the document's renderer (saveAsPdf without Electron); null: the real one. */
const fakeRenderer = vi.hoisted(() => ({ use: null as null | ((vp: unknown, fn: (view: unknown) => Promise<unknown>) => Promise<unknown>) }));
vi.mock('../../../packages/app/src/main/render-service', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/app/src/main/render-service')>();
  return { ...real, rendererFor: (...a: Parameters<typeof real.rendererFor>) => (fakeRenderer.use ? { use: fakeRenderer.use } : real.rendererFor(...a)) };
});

import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import {
  LETTER_REGIONS,
  RasterPdf,
  bgraToRgb,
  decidePdfMode,
  defaultPdfPath,
  documentPageSize,
  importMediaOf,
  mediaAppliesToPrint,
  mediaSelectsPrint,
  pagesHaveSlideAspect,
  pageSizeForRegion,
  paperRegion,
  pdfPageCount,
  pdfTitleOf,
  printCssOf,
  readXrefTable,
  refusePdfOut,
  regionOfLocale,
  retitleIncrementally,
  saveAsPdf,
  scanPrintCss,
  setPdfTitle,
  stripCssComments,
  titleEntryRange,
  writePdfFile,
} from '../../../packages/app/src/main/pdf';

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------- print CSS

describe('print CSS detection (6.9: an @page rule, or a @media print that lays out each slide as a page)', () => {
  const scan = (text: string, media: string | null = null) => scanPrintCss([{ text, media }]);

  it('finds an @page rule anywhere, at top level or nested', () => {
    expect(scan('@page { size: 1280px 720px; margin: 0 }').pageRule).toBe(true);
    expect(scan('@media print { @page { margin: 0 } }').pageRule).toBe(true);
    expect(scan('@page :first { margin: 1in }').pageRule).toBe(true);
    expect(scan('@supports (display: grid) { @page { size: A4 } }').pageRule).toBe(true);
  });

  it('ignores @page in comments and strings, and other at-rules', () => {
    expect(scan('/* @page { size: A4 } */ .a { color: red }').pageRule).toBe(false);
    expect(scan('.a::before { content: "@page { }" }').pageRule).toBe(false);
    expect(scan('@pagex { }').pageRule).toBe(false);
    expect(scan('@media screen { .a { page-break-after: always } }')).toEqual({ pageRule: false, printBreaks: false, printRules: false });
  });

  it('finds forced page breaks in print media: @media print, a print sheet, legacy and modern properties', () => {
    expect(scan('@media print { .slide { page-break-after: always } }').printBreaks).toBe(true);
    expect(scan('@media only print and (orientation: landscape) { .s { break-before: page } }').printBreaks).toBe(true);
    expect(scan('@media screen, print { section { break-after:recto } }').printBreaks).toBe(true);
    expect(scan('.slide { break-after: page }', 'print').printBreaks).toBe(true);
    expect(scan('.slide { break-after: page }', 'screen').printBreaks).toBe(false);
    expect(scan('@media not print { .s { break-after: page } }').printBreaks).toBe(false);
    expect(scan('@media print { .s { break-after: avoid; color: black } }')).toEqual({ pageRule: false, printBreaks: false, printRules: true });
    expect(scan('@media print { @supports (x: y) { .s { break-after: page } } }').printBreaks).toBe(true);
  });

  it('a break outside print media does not count', () => {
    expect(scan('.slide { page-break-after: always }').printBreaks).toBe(false);
  });

  it('reveal.js’s own print sheet (html:not(.print-pdf) …) is a handout layout, not slide pages', () => {
    const reveal = '@media print{html:not(.print-pdf) .reveal .slides section{visibility:visible!important;page-break-after:always!important}html:not(.print-pdf) .reveal .slides section:last-of-type{page-break-after:avoid!important}}';
    expect(scan(reveal)).toEqual({ pageRule: false, printBreaks: false, printRules: true });
    expect(scan(reveal + '@media print{.reveal section{break-after:page}}').printBreaks).toBe(true);
  });

  it('mediaSelectsPrint and comments', () => {
    expect(mediaSelectsPrint('print')).toBe(true);
    expect(mediaSelectsPrint(' PRINT ')).toBe(true);
    expect(mediaSelectsPrint('screen')).toBe(false);
    expect(mediaSelectsPrint('all')).toBe(false);
    expect(mediaSelectsPrint('not print, screen')).toBe(false);
    expect(mediaSelectsPrint('(min-width: 1px), print and (color)')).toBe(true);
    expect(stripCssComments('a/* x */b"/* kept */"')).toBe('a       b"/* kept */"');
  });

  it('printCssOf: style sheets that cannot be read mean no print CSS (the deck is rendered slide by slide)', async () => {
    const logs: string[] = [];
    const failing = { styleSheets: async () => Promise.reject(new Error('Another debugger is already attached')) };
    expect(await printCssOf(failing, (m) => logs.push(m))).toEqual({ pageRule: false, printBreaks: false, printRules: false });
    expect(logs[0]).toMatch(/could not be read/);
    const ok = { styleSheets: async () => ({ sheets: [{ text: '@page { margin: 0 }', url: 'x', media: null }], truncated: true }) };
    expect((await printCssOf(ok, (m) => logs.push(m))).pageRule).toBe(true);
    expect(logs[1]).toMatch(/cut at 16 M/);
  });

  it('decidePdfMode: documents print as documents; a deck prints its CSS only as slide pages (one per slide, the slide’s aspect within 1%), else raster (decision D-6)', () => {
    const none = { pageRule: false, printBreaks: false, printRules: false };
    const page = { ...none, pageRule: true };
    const breaks = { ...none, printBreaks: true, printRules: true };
    const design = { w: 1280, h: 720 };
    const slidePages = (n: number) => ({ pageSizes: Array(n).fill({ w: 960, h: 540 }), design });
    expect(decidePdfMode('scroll', page, null, 3)).toBe('document');
    expect(decidePdfMode('single', none, null, 1)).toBe('document');
    // An @page rule is no longer print-css by itself: Chromium's print must be the deck as slide pages.
    expect(decidePdfMode('generic', page, null, 3)).toBe('raster');
    expect(decidePdfMode('reveal', page, 5, 3)).toBe('raster');
    expect(decidePdfMode('reveal', page, 5, 3, slidePages(5))).toBe('raster');
    expect(decidePdfMode('generic', page, 1, 4, slidePages(1))).toBe('raster');
    expect(decidePdfMode('generic', page, 3, 3, slidePages(3))).toBe('print-css');
    expect(decidePdfMode('generic', breaks, 4, 4, slidePages(4))).toBe('print-css');
    expect(decidePdfMode('generic', breaks, 4, 4)).toBe('raster');
    expect(decidePdfMode('generic', breaks, 2, 4, slidePages(2))).toBe('raster');
    expect(decidePdfMode('generic', breaks, null, 4)).toBe('raster');
    expect(decidePdfMode('generic', none, 4, 4, slidePages(4))).toBe('raster');
    // One page per slide on the default paper (Letter): not the slide's aspect.
    expect(decidePdfMode('generic', breaks, 4, 4, { pageSizes: Array(4).fill({ w: 612, h: 792 }), design: { w: 1600, h: 900 } })).toBe('raster');
    // A page count that matches but one page of another shape.
    expect(decidePdfMode('generic', page, 3, 3, { pageSizes: [{ w: 960, h: 540 }, { w: 960, h: 600 }, { w: 960, h: 540 }], design })).toBe('raster');
    // The page sizes must be the printed pages.
    expect(decidePdfMode('generic', page, 3, 3, slidePages(2))).toBe('raster');
  });

  it('pagesHaveSlideAspect: within 1% of the design size’s aspect', () => {
    const design = { w: 1600, h: 900 };
    expect(pagesHaveSlideAspect({ pageSizes: [{ w: 1200, h: 675 }], design })).toBe(true);
    expect(pagesHaveSlideAspect({ pageSizes: [{ w: 1200, h: 681 }], design })).toBe(true); // 0.9 %
    expect(pagesHaveSlideAspect({ pageSizes: [{ w: 1200, h: 683 }], design })).toBe(false); // 1.2 %
    expect(pagesHaveSlideAspect({ pageSizes: [{ w: 612, h: 792 }], design: { w: 720, h: 932 } })).toBe(true);
    expect(pagesHaveSlideAspect({ pageSizes: [], design })).toBe(false);
    expect(pagesHaveSlideAspect({ pageSizes: [{ w: 0, h: 675 }], design })).toBe(false);
  });

  it('a sheet’s media list: <link>/<style> media, an @import’s list for the sheet it imports, and sheets that never apply to print (review finding 13)', () => {
    const doc = 'blueline://0123456789abcdef/deck.html';
    const files = 'blueline://0123456789abcdef-files/';
    const breaks = '.slide { display: block; break-after: page }';
    // `@import url(x) print` in an inline sheet: the imported sheet (served from the -files host) is print CSS.
    expect(scanPrintCss([{ text: '@import url("print.css") print;', url: doc, media: null }, { text: breaks, url: `${files}print.css`, media: null }]).printBreaks).toBe(true);
    expect(scanPrintCss([{ text: "@import 'print.css' print;", url: doc, media: null }, { text: breaks, url: `${files}print.css`, media: null }]).printBreaks).toBe(true);
    // A wrapper sheet that imports it with print.
    expect(scanPrintCss([{ text: '@import url(print.css) layer(p) print;', url: `${files}wrapper.css`, media: null }, { text: breaks, url: `${files}print.css`, media: null }]).printBreaks).toBe(true);
    // Imported with no media, or for screen: not print CSS.
    expect(scanPrintCss([{ text: '@import url("print.css");', url: doc, media: null }, { text: breaks, url: `${files}print.css`, media: null }]).printBreaks).toBe(false);
    expect(scanPrintCss([{ text: '@import url("print.css") screen;', url: doc, media: null }, { text: `@page { size: 1280px 720px } ${breaks}`, url: `${files}print.css`, media: null }])).toEqual({ pageRule: false, printBreaks: false, printRules: false });
    // <link media="print"> and <style media="print"> (the owner node's media attribute).
    expect(scanPrintCss([{ text: breaks, url: `${files}print.css`, media: 'print' }]).printBreaks).toBe(true);
    // A screen-only sheet is not read at all: its @page rule and @media print layout apply to no print.
    expect(scanPrintCss([{ text: `@page { size: 1280px 720px } @media print { ${breaks} }`, url: `${files}screen.css`, media: 'screen' }])).toEqual({ pageRule: false, printBreaks: false, printRules: false });
    expect(scanPrintCss([{ text: '@page { margin: 0 }', url: doc, media: 'all' }]).pageRule).toBe(true);
    expect(scanPrintCss([{ text: '@page { margin: 0 }', url: doc, media: 'not screen' }]).pageRule).toBe(true);

    // The print scope is inherited down the @import chain (review finding 13 re-verification): an imported sheet
    // with no media list of its own takes the scope of the print-media sheet that pulled it in, at any depth.
    const layout = `${files}layout.css`;
    const wrap = `${files}wrap-plain.css`;
    // N1: <style media=print>@import url(layout.css);</style> — layout.css inherits the style's print scope.
    expect(scanPrintCss([{ text: '@import url(layout.css);', url: doc, media: 'print' }, { text: breaks, url: layout, media: null }]).printBreaks).toBe(true);
    // N2: <style>@import url(wrap-plain.css) print;</style>, wrap-plain.css: @import url(layout.css);
    expect(
      scanPrintCss([
        { text: '@import url(wrap-plain.css) print;', url: doc, media: null },
        { text: '@import url(layout.css);', url: wrap, media: null },
        { text: breaks, url: layout, media: null },
      ]).printBreaks,
    ).toBe(true);
    // N3: <link href=wrap-plain.css media=print>, wrap-plain.css: @import url(layout.css);
    expect(
      scanPrintCss([
        { text: '@import url(layout.css);', url: wrap, media: 'print' },
        { text: breaks, url: layout, media: null },
      ]).printBreaks,
    ).toBe(true);
    // Still screen-scoped when the chain narrows to screen: <style media=print>@import url(x) screen;</style>.
    expect(scanPrintCss([{ text: '@import url(layout.css) screen;', url: doc, media: 'print' }, { text: breaks, url: layout, media: null }]).printBreaks).toBe(false);
  });

  it('mediaAppliesToPrint and importMediaOf', () => {
    expect(mediaAppliesToPrint('')).toBe(true);
    expect(mediaAppliesToPrint('all')).toBe(true);
    expect(mediaAppliesToPrint('print')).toBe(true);
    expect(mediaAppliesToPrint('screen, print and (orientation: landscape)')).toBe(true);
    expect(mediaAppliesToPrint('(min-width: 600px)')).toBe(true);
    expect(mediaAppliesToPrint('not screen')).toBe(true);
    expect(mediaAppliesToPrint('screen')).toBe(false);
    expect(mediaAppliesToPrint('only screen and (max-width: 900px)')).toBe(false);
    expect(mediaAppliesToPrint('not print')).toBe(false);
    expect(mediaAppliesToPrint('speech, tv')).toBe(false);
    const doc = 'blueline://0123456789abcdef/sub/deck.html';
    // A no-media @import (c.css) is kept with media null: the sheet it pulls in inherits the importing sheet's
    // scope (review finding 13 re-verification).
    expect(importMediaOf('@import url("../a.css") print; @import "b.css" screen and (color); @import url(c.css); @import url(d.css) supports(display: grid) print;', doc)).toEqual([
      { key: 'blueline://0123456789abcdef/a.css', media: 'print' },
      { key: 'blueline://0123456789abcdef/sub/b.css', media: 'screen and (color)' },
      { key: 'blueline://0123456789abcdef/sub/c.css', media: null },
      { key: 'blueline://0123456789abcdef/sub/d.css', media: 'print' },
    ]);
  });
});

// ------------------------------------------------------------------------------------------- page size

describe('document page size by locale (6.9: Letter or A4)', () => {
  it('regionOfLocale reads BCP 47 and POSIX locales', () => {
    expect(regionOfLocale('en-US')).toBe('US');
    expect(regionOfLocale('es_MX.UTF-8')).toBe('MX');
    expect(regionOfLocale('zh-Hant-TW')).toBe('TW');
    expect(regionOfLocale('en-US@posix')).toBe('US');
    expect(regionOfLocale('es-419')).toBeNull();
    expect(regionOfLocale('de')).toBeNull();
    expect(regionOfLocale('C')).toBeNull();
    expect(regionOfLocale('')).toBeNull();
  });

  it('Letter for the Americas that use it and the Philippines, A4 elsewhere and when unknown', () => {
    for (const r of ['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'pr']) expect(pageSizeForRegion(r)).toBe('Letter');
    for (const r of ['GB', 'DE', 'FR', 'BR', 'AR', 'IN', 'JP', 'AU']) expect(pageSizeForRegion(r)).toBe('A4');
    expect(pageSizeForRegion(null)).toBe('A4');
    expect(LETTER_REGIONS.size).toBe(14);
  });

  it('paperRegion: an explicit locale, then LC_ALL/LC_PAPER on Linux, the OS region, the system locale, the UI locale', () => {
    expect(paperRegion({ locale: 'en-GB', countryCode: 'US' })).toBe('GB');
    expect(paperRegion({ env: { LC_PAPER: 'en_US.UTF-8' }, platform: 'linux', systemLocale: 'de-DE' })).toBe('US');
    expect(paperRegion({ env: { LC_ALL: 'fr_FR.UTF-8', LC_PAPER: 'en_US.UTF-8' }, platform: 'linux' })).toBe('FR');
    expect(paperRegion({ env: { LC_PAPER: 'en_US.UTF-8' }, platform: 'darwin', countryCode: 'DE' })).toBe('DE');
    expect(paperRegion({ countryCode: 'ca', systemLocale: 'fr-FR' })).toBe('CA');
    expect(paperRegion({ countryCode: '', systemLocale: 'es-MX', appLocale: 'es-419' })).toBe('MX');
    expect(paperRegion({ systemLocale: 'en', appLocale: 'en-GB' })).toBe('GB');
    expect(paperRegion({})).toBeNull();
  });

  it('documentPageSize: the injected locale wins over the machine’s', () => {
    expect(documentPageSize('en-US')).toBe('Letter');
    expect(documentPageSize('de-DE')).toBe('A4');
    expect(documentPageSize('es-MX')).toBe('Letter');
  });
});

// ------------------------------------------------------------------------------------------- the title

/** A PDF like Chromium's: classic xref table, an Info object whose Title is the page's URL. */
async function chromiumLike(title: PDFString | null, pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  const info = doc.context.obj({ Creator: PDFString.of('Chromium'), Producer: PDFString.of('Skia/PDF m152') });
  if (title) info.set(PDFName.of('Title'), title);
  doc.context.trailerInfo.Info = doc.context.register(info);
  return doc.save({ useObjectStreams: false });
}

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

describe('the PDF title (6.9: from <title>; never the URL)', () => {
  it('an incremental update blanks the URL and appends the new Info: every other byte stays', async () => {
    const url = 'blueline://0123456789abcdef/deck.html';
    const raw = await chromiumLike(PDFString.of(url));
    const out = await retitleIncrementally(raw, 'Q3 review');
    expect(out).not.toBeNull();
    const s = latin1(out!);
    expect(s.includes(url)).toBe(false);
    // Same length prefix, differing only where the old /Title entry was (now spaces).
    const before = latin1(raw);
    let diff = 0;
    for (let i = 0; i < raw.length; i++) if (s.charCodeAt(i) !== before.charCodeAt(i)) diff++;
    const entry = `/Title (${url})`;
    expect(diff).toBe([...entry].filter((c) => c !== ' ').length);
    const doc = await PDFDocument.load(out!);
    expect(doc.getTitle()).toBe('Q3 review');
    expect(doc.getCreator()).toBe('Chromium');
    expect(doc.getPageCount()).toBe(2);
    expect(s.endsWith('%%EOF\n')).toBe(true);
    expect(/\/Prev \d+/.test(s.slice(raw.length))).toBe(true);
  });

  it('characters that need escaping survive (UTF-16 hex), and a null title removes it', async () => {
    const t = 'Q&A: “Growth” <2027> (draft) \\ ½ — Ünïcödé 🎉 \'26';
    const raw = await chromiumLike(PDFString.of('blueline://x/(nested (parens)) \\) escaped'));
    const out = await setPdfTitle(raw, t);
    expect((await PDFDocument.load(out)).getTitle()).toBe(t);
    expect(latin1(out).includes('nested')).toBe(false);
    const none = await setPdfTitle(raw, null);
    expect((await PDFDocument.load(none)).getTitle()).toBeUndefined();
    expect(latin1(none).includes('blueline://')).toBe(false);
  });

  it('a PDF with no title at all gets one', async () => {
    const out = await setPdfTitle(await chromiumLike(null), 'Plain');
    expect((await PDFDocument.load(out)).getTitle()).toBe('Plain');
  });

  it('a PDF the incremental path cannot handle (a cross-reference stream) is rewritten by pdf-lib', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage();
    doc.setTitle('blueline://x/y.html');
    const raw = await doc.save({ useObjectStreams: true });
    expect(await retitleIncrementally(raw, 'New')).toBeNull();
    const out = await setPdfTitle(raw, 'New');
    const back = await PDFDocument.load(out);
    expect(back.getTitle()).toBe('New');
    expect(back.getPageCount()).toBe(1);
    expect(latin1(out).includes('blueline://')).toBe(false);
  });

  it('readXrefTable and titleEntryRange', () => {
    const s = 'junk xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<</Size 2>>\nstartxref\n5\n%%EOF';
    const x = readXrefTable(s, 5)!;
    expect(x.entries.get(1)).toEqual({ offset: 9, gen: 0, used: true });
    expect(x.entries.get(0)?.used).toBe(false);
    expect(x.trailer).toContain('/Size 2');
    expect(readXrefTable(s, 0)).toBeNull();
    const d = '<< /Producer (p) /Title (a (b) \\) c) /X 1 >>';
    const r = titleEntryRange(d, 0, d.length)!;
    expect(d.slice(r.start, r.end)).toBe('/Title (a (b) \\) c)');
    const h = '<</Title <FEFF0041>/X 1>>';
    const rh = titleEntryRange(h, 0, h.length)!;
    expect(h.slice(rh.start, rh.end)).toBe('/Title <FEFF0041>');
    expect(titleEntryRange('<</TitleX (a)>>', 0, 15)).toBeNull();
    expect(titleEntryRange('<</Title 12 0 R>>', 0, 17)).toBeNull();
  });

  it('pdfTitleOf: the rendered title, else the file’s, else none', () => {
    expect(pdfTitleOf('  A \n title ', 'B')).toBe('A title');
    expect(pdfTitleOf('', ' B ')).toBe('B');
    expect(pdfTitleOf(' ', '')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------- raster pages

describe('raster pages (6.9 Other decks: the slide’s aspect, lossless)', () => {
  it('bgraToRgb swaps channels and composites over white', () => {
    const bgra = new Uint8Array([10, 20, 30, 255, 0, 0, 255, 0, 0, 0, 0, 128]);
    expect(Array.from(bgraToRgb(bgra, 3))).toEqual([30, 20, 10, 255, 255, 255, 127, 127, 127]);
  });

  it('one page per capture, sized design px × 0.75, the image exact', async () => {
    const pdf = await RasterPdf.create({ w: 1600, h: 900 }, 'Deck “title”');
    const w = 4;
    const h = 2;
    const px = (b: number, g: number, r: number) => Array.from({ length: w * h }, () => [b, g, r, 255]).flat();
    await pdf.addPage(new Uint8Array(px(200, 120, 10)), w, h);
    await pdf.addPage(new Uint8Array(px(0, 0, 0)), w, h);
    await expect(pdf.addPage(new Uint8Array(3), w, h)).rejects.toThrow();
    const bytes = await pdf.save();
    expect(await pdfPageCount(bytes)).toBe(2);
    expect(pdf.pages).toBe(2);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe('Deck “title”');
    const page = doc.getPage(0);
    expect(page.getSize()).toEqual({ width: 1200, height: 675 });
    // The page's image: Flate-compressed RGB, decoded back to the capture's pixels.
    const xobjects = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const ref = xobjects.values()[0] as PDFRef;
    const img = doc.context.lookup(ref) as PDFRawStream;
    expect(img.dict.get(PDFName.of('Width'))?.toString()).toBe('4');
    expect(img.dict.get(PDFName.of('Filter'))?.toString()).toBe('/FlateDecode');
    const rgb = inflateSync(img.contents);
    expect(rgb.length).toBe(w * h * 3);
    expect(Array.from(rgb.subarray(0, 3))).toEqual([10, 120, 200]);
  });

  it('pages in slide order, whatever order the captures came in; a slide captured twice keeps its last capture (review finding 33)', async () => {
    const pdf = await RasterPdf.create({ w: 16, h: 9 }, null);
    const w = 2;
    const h = 1;
    const shot = (v: number) => new Uint8Array(Array.from({ length: w * h }, () => [v, v, v, 255]).flat());
    // The walk reached slides 0, 1, 3, 4 by keys and slide 2 by its hash, last.
    for (const slide of [0, 1, 3, 4]) await pdf.addPage(shot(slide * 10), w, h, slide);
    await pdf.addPage(shot(99), w, h, 2);
    await pdf.addPage(shot(20), w, h, 2);
    await expect(pdf.addPage(shot(1), w, h, -1)).rejects.toThrow(/slot/);
    expect(pdf.pages).toBe(5);
    const doc = await PDFDocument.load(await pdf.save());
    const firstByte = doc.getPages().map((page) => {
      const xo = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
      return inflateSync((doc.context.lookup(xo.values()[0] as PDFRef) as PDFRawStream).contents)[0];
    });
    expect(firstByte).toEqual([0, 10, 20, 30, 40]);
  });
});

// ------------------------------------------------------------------------------------------- output

describe('the output path', () => {
  it('defaults to <deck basename>.pdf next to the deck', () => {
    expect(defaultPdfPath('/a/b/deck.html')).toBe('/a/b/deck.pdf');
    expect(defaultPdfPath('/a/b/my.deck.HTM')).toBe('/a/b/my.deck.pdf');
    expect(defaultPdfPath('/a/b/.hidden')).toBe('/a/b/.hidden.pdf');
  });

  it('refuses the deck itself (by path, through a link, or a hard link), folders, relative and non-.pdf paths', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-pdfout-'));
    tmp.push(d);
    const deck = path.join(d, 'deck.html');
    fs.writeFileSync(deck, '<p>x</p>');
    const doc = { realpath: fs.realpathSync(deck) };
    expect(await refusePdfOut(path.join(d, 'deck.pdf'), doc)).toBeNull();
    expect(await refusePdfOut(deck, doc)).toMatch(/document itself/);
    expect(await refusePdfOut('deck.pdf', doc)).toMatch(/absolute/);
    expect(await refusePdfOut(path.join(d, 'deck.txt'), doc)).toMatch(/not a \.pdf/);
    fs.mkdirSync(path.join(d, 'folder.pdf'));
    expect(await refusePdfOut(path.join(d, 'folder.pdf'), doc)).toMatch(/folder/);
    fs.symlinkSync(deck, path.join(d, 'link.pdf'));
    expect(await refusePdfOut(path.join(d, 'link.pdf'), doc)).toMatch(/document itself/);
    fs.linkSync(deck, path.join(d, 'hard.pdf'));
    expect(await refusePdfOut(path.join(d, 'hard.pdf'), doc)).toMatch(/document itself/);
    expect(await refusePdfOut(path.join(d, 'missing', 'x.pdf'), doc)).toMatch(/does not exist/);
  });

  it('the PDF is marked before it is in place: a mark that fails keeps the PDF the user chose to replace (review finding 30)', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-pdfmark-'));
    tmp.push(d);
    const out = path.join(d, 'report.pdf');
    const old = Buffer.from('%PDF-1.4 the old report');
    fs.writeFileSync(out, old);
    const fresh = new TextEncoder().encode('%PDF-1.7 the new report');
    // The mark fails (a helper timeout, a volume that refuses the attribute): `out` keeps its bytes.
    await expect(writePdfFile(out, fresh, () => Promise.reject(new Error('helper timed out')), 'report.html')).rejects.toThrow(
      /could not keep report\.html's internet marker, so it was not saved \(helper timed out\)/,
    );
    expect(fs.readFileSync(out).equals(old)).toBe(true);
    // A new file stays absent.
    const neu = path.join(d, 'new.pdf');
    await expect(writePdfFile(neu, fresh, () => Promise.reject(new Error('no')), 'report.html')).rejects.toThrow(/internet marker/);
    expect(fs.existsSync(neu)).toBe(false);
    // The mark runs on the temp file, which already holds the new bytes, while `out` still holds the old ones.
    const seen: { temp: string; bytes: string; outThen: string }[] = [];
    await writePdfFile(out, fresh, async (temp) => void seen.push({ temp, bytes: fs.readFileSync(temp, 'utf8'), outThen: fs.readFileSync(out, 'utf8') }), 'report.html');
    expect(seen).toHaveLength(1);
    expect(path.dirname(seen[0].temp)).toBe(d);
    expect(seen[0].temp).not.toBe(out);
    expect(seen[0].bytes).toBe('%PDF-1.7 the new report');
    expect(seen[0].outThen).toBe('%PDF-1.4 the old report');
    expect(fs.readFileSync(out, 'utf8')).toBe('%PDF-1.7 the new report');
    expect(fs.statSync(out).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(d).filter((f) => f.startsWith('.bl-write-'))).toEqual([]);
  });

  it('saveAsPdf: a copyMarker that fails leaves a pre-existing out file with its bytes, and the error says why (review finding 30)', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-pdfsave-'));
    tmp.push(d);
    const deck = path.join(d, 'report.html');
    fs.writeFileSync(deck, '<h1>Report</h1>');
    const out = path.join(d, 'report.pdf');
    const old = Buffer.from('%PDF-1.4 a PDF the user chose to replace');
    fs.writeFileSync(out, old);
    const blank = await PDFDocument.create();
    blank.addPage([612, 792]);
    const printed = await blank.save();
    // A document printed by a stand-in render view (no Electron here).
    const view = {
      load: async () => undefined,
      waitStable: async () => ({ fontsReady: true, stillRunning: 0 }),
      waitScripted: async () => ({ waitedMs: 0, quiet: true, late: false }),
      overlayMounted: async () => false,
      documentTitle: async () => 'Report',
      printToPDF: async () => printed,
    };
    fakeRenderer.use = (_vp, fn) => fn(view);
    try {
      const version = 'a'.repeat(64);
      const doc = {
        docId: '0123456789abcdef',
        fileName: 'report.html',
        partition: 'persist:x',
        folderReal: d,
        realpath: fs.realpathSync(deck),
        fileKey: '0123456789abcdef',
        version,
        title: 'Report',
        marker: null,
        isProtected: () => true,
        networkOpen: () => false,
        renderPolicyTag: () => 'test-policy',
        reducedMotion: true,
      };
      const index = { version, kind: 'single' as const, navKind: 'none' as const, slides: [{ index: 0, title: 'Report', nav: { kind: 'none' as const, value: 0 }, text: ['Report'] }], designSize: { w: 1600, h: 900 }, complete: true };
      const marks: string[] = [];
      const failing = async (_from: string, to: string) => {
        marks.push(to);
        throw new Error('the helper timed out');
      };
      const host = { preload: '/x/preload-deck.cjs', userData: d, log: () => undefined };
      await expect(saveAsPdf(doc, out, { index, host, copyMarker: failing })).rejects.toThrow(/could not keep report\.html's internet marker, so it was not saved \(the helper timed out\)/);
      expect(fs.readFileSync(out).equals(old), 'the PDF that was there keeps its bytes').toBe(true);
      // The marker was asked for on the PDF's temp file, never on `out` itself.
      expect(marks).toHaveLength(1);
      expect(marks[0]).not.toBe(out);
      expect(path.dirname(marks[0])).toBe(d);
      expect(fs.readdirSync(d).filter((f) => f.startsWith('.bl-write-'))).toEqual([]);
      // With a mark that works the new PDF replaces it.
      const r = await saveAsPdf(doc, out, { index, host, copyMarker: async () => undefined });
      expect(r).toMatchObject({ out, pages: 1, mode: 'document', title: 'Report' });
      expect((await PDFDocument.load(fs.readFileSync(out))).getPageCount()).toBe(1);
    } finally {
      fakeRenderer.use = null;
    }
  });
});
