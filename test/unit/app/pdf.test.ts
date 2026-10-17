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

import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import {
  LETTER_REGIONS,
  RasterPdf,
  bgraToRgb,
  decidePdfMode,
  defaultPdfPath,
  documentPageSize,
  mediaSelectsPrint,
  pageSizeForRegion,
  paperRegion,
  pdfPageCount,
  pdfTitleOf,
  printCssOf,
  readXrefTable,
  refusePdfOut,
  regionOfLocale,
  retitleIncrementally,
  scanPrintCss,
  setPdfTitle,
  stripCssComments,
  titleEntryRange,
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

  it('decidePdfMode: documents print as documents; decks by their print CSS, else raster', () => {
    const none = { pageRule: false, printBreaks: false, printRules: false };
    const page = { ...none, pageRule: true };
    const breaks = { ...none, printBreaks: true, printRules: true };
    expect(decidePdfMode('scroll', page, null, 3)).toBe('document');
    expect(decidePdfMode('single', none, null, 1)).toBe('document');
    expect(decidePdfMode('generic', page, null, 3)).toBe('print-css');
    expect(decidePdfMode('reveal', page, 5, 3)).toBe('print-css');
    expect(decidePdfMode('generic', breaks, 4, 4)).toBe('print-css');
    expect(decidePdfMode('generic', breaks, 2, 4)).toBe('raster');
    expect(decidePdfMode('generic', breaks, null, 4)).toBe('raster');
    expect(decidePdfMode('generic', none, 4, 4)).toBe('raster');
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
});
