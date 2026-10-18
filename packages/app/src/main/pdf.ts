// Save as PDF (6.9, Cmd+Shift+E; `blueline pdf`), as 6.9 lists it:
//
// - Decks with print CSS (an @page rule, or a @media print that lays out each slide as a page):
//   printToPDF({ preferCSSPageSize: true, printBackground: true }), when that print is the deck as slide
//   pages: one page per slide, each the slide's aspect within 1% (decision D-6). Otherwise the deck is
//   rendered slide by slide, as the next point says.
// - Other decks: the background render walks every slide at the design size and 2x and composes one PDF page
//   per slide with pdf-lib, in slide order; the page has the slide's aspect ratio (design size px × 0.75 pt)
//   and the image is lossless. Text is not selectable in v1 (a hidden text layer is Later).
// - Documents: printToPDF({ printBackground: true, pageSize }), Letter or A4 from the locale.
// - Before any printToPDF, the scripted settle that visitSlides uses for a still image (once per document:
//   fonts, frames, finite animations, then what scripts reveal; decision D-5), so a chart a script animates or
//   a section a timer fills is printed as the reader sees it.
// - Always: notes are never included (the served copy has no notes block, and render views have no overlay:
//   checked before every render), and the PDF's title comes from <title>.
//
// Print CSS is read from every style sheet the served document uses, linked same-folder sheets included
// (they come from the -files origin, cross-origin to the page, so the render view's debugger reads them),
// each with its media list: `<link media>`, `<style media>`, and an `@import url(x) <media>` statement for
// the sheet it imports (a sheet whose media never include print is not print CSS).
// "A @media print that lays out each slide as a page" is a print-media rule that forces page breaks, checked
// by printing. reveal.js's own print sheet (`html:not(.print-pdf)` rules in reveal.css) lays slides out as a
// text handout, not as slide pages, and does not count.
//
// printToPDF names a document without a <title> after its URL (blueline://<docId>/<file>), so the title is
// always set again: the old value is blanked in place and a new Info dictionary is appended as an incremental
// update, so every other byte of Chromium's PDF stays as it was (pdf-lib parses; a PDF it cannot update that
// way is rewritten by pdf-lib instead). Derived files keep the document's marker (9.9). Output is atomic.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { deflate as deflateCb } from 'node:zlib';
import { app } from 'electron';
import type { PDFDocument, PDFRef } from 'pdf-lib';
import type { PdfMode, PdfResult, SlideIndex, SlideIndexKind } from '@blueline/core/ipc-render';
import { atomicWriteFile } from './atomic-write';
import { markDerivedFile } from './markers';
import { RenderError, rendererFor, renderHost, throwIfCancelled, untilQuiet, type RenderHost, type RenderTarget, type RenderView } from './render-service';
import { INDEX_VIEWPORT, buildSlideIndex, collapse, designViewport, isDeck, settleMemoryFor, settleScripted, visitSlides } from './slide-index';

const deflate = promisify(deflateCb);

type PdfLib = typeof import('pdf-lib');
let pdfLibLoad: Promise<PdfLib> | null = null;

/**
 * pdf-lib, loaded on first use. Only Save as PDF, Print and `blueline pdf` need it, and initialising it when
 * main starts cost about 28 ms of a cold start before first paint (docs/PHASE1-RESULTS.md, First paint).
 */
function pdfLib(): Promise<PdfLib> {
  pdfLibLoad ??= import('pdf-lib');
  return pdfLibLoad;
}

/** 6.9 "design size px × 0.75": CSS px are 1/96 in, PDF points 1/72 in. */
export const PT_PER_PX = 0.75;
/** Raster pages are captured at the design size and 2x (6.9). */
export const RASTER_SCALE = 2;

// ------------------------------------------------------------------------------------------- print CSS

export interface PrintCssScan {
  /** An @page rule anywhere (6.9: "an @page rule"). */
  pageRule: boolean;
  /** A print-media rule forcing a page break (break-before/after, page-break-before/after) outside reveal.js's handout sheet. */
  printBreaks: boolean;
  /** Any print-media rule at all. */
  printRules: boolean;
}

const BREAK_DECL = /(?:^|[;{\s])(?:page-break-(?:before|after)|break-(?:before|after))\s*:\s*(?:always|page|left|right|recto|verso)\b/i;
/** reveal.js's paper handout sheet (css/print/paper.scss) scopes every rule to `html:not(.print-pdf)`. */
const REVEAL_PAPER = /^\s*html:not\(\s*\.print-pdf\s*\)/i;

/** True when a media query list selects print: a query of media type `print` (optionally `only`), never `not print`. */
export function mediaSelectsPrint(list: string): boolean {
  for (const q of splitTopLevel(list, ',')) {
    const m = /^\s*(only\s+|not\s+)?([a-z-]+)\b/i.exec(q);
    if (m && m[2].toLowerCase() === 'print' && !(m[1] ?? '').trim().toLowerCase().startsWith('not')) return true;
  }
  return false;
}

/** Splits on `sep` outside parentheses, brackets and strings. */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** Comments become spaces (strings are kept), so offsets stay put and nothing inside a comment counts. */
export function stripCssComments(css: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < css.length) out += css[++i];
      else if (c === quote || c === '\n') quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop - 1;
    } else out += c;
  }
  return out;
}

/** The index of the `}` that closes the block opened at `open` (a `{`), skipping strings; css.length if none. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote || c === '\n') quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return css.length;
}

/** Scans one sheet's rules between [from, to); `print` says the region already applies to print media only. */
function scanRules(css: string, from: number, to: number, print: boolean, out: PrintCssScan, depth: number): void {
  let i = from;
  while (i < to) {
    const open = css.indexOf('{', i);
    const semi = css.indexOf(';', i);
    // A statement at-rule (@import, @charset, @layer a, b;) before the next block.
    if (semi >= 0 && semi < to && (open < 0 || semi < open)) {
      const stmt = css.slice(i, semi).trim();
      if (/^@page\b/i.test(stmt)) out.pageRule = true;
      i = semi + 1;
      continue;
    }
    if (open < 0 || open >= to) return;
    const prelude = css.slice(i, open).trim();
    const close = Math.min(blockEnd(css, open), to);
    if (prelude.startsWith('@')) {
      const name = /^@([a-z-]+)/i.exec(prelude)?.[1].toLowerCase() ?? '';
      if (name === 'page') out.pageRule = true;
      else if (depth < 16 && (name === 'media' || name === 'supports' || name === 'layer' || name === 'container' || name === 'document' || name === 'scope' || name === 'starting-style')) {
        const inner = name === 'media' ? print || mediaSelectsPrint(prelude.slice(6)) : print;
        if (inner && !print) out.printRules = true;
        scanRules(css, open + 1, close, inner, out, depth + 1);
      }
    } else if (print) {
      out.printRules = true;
      const body = css.slice(open + 1, close);
      if (BREAK_DECL.test(body)) {
        const selectors = splitTopLevel(prelude, ',');
        if (!selectors.every((s) => REVEAL_PAPER.test(s))) out.printBreaks = true;
      }
      // Nested style rules (CSS nesting) may hold @page-free at-rules; they are print too.
      if (depth < 16 && body.includes('{')) scanRules(css, open + 1, close, true, out, depth + 1);
    } else if (depth < 16 && css.slice(open + 1, close).includes('@')) {
      // CSS nesting: `.slide { @media print { … } }`.
      scanRules(css, open + 1, close, false, out, depth + 1);
    }
    i = close + 1;
  }
}

/**
 * True when a media query list can apply to print media: a query of type print or all (a query with no type
 * is `all`), or `not` with another type (`not screen`). An empty list is `all`.
 */
export function mediaAppliesToPrint(list: string): boolean {
  if (!list.trim()) return true;
  for (const q of splitTopLevel(list, ',')) {
    const t = q.trim();
    if (!t) continue;
    const m = /^(only\s+|not\s+)?([a-z-]+)\b/i.exec(t);
    // `(min-width: 0)`, `(orientation: landscape) and (…)`: no media type, so `all`.
    if (!m) return true;
    const type = m[2].toLowerCase();
    const not = (m[1] ?? '').trim().toLowerCase() === 'not';
    if (not ? type !== 'print' && type !== 'all' : type === 'print' || type === 'all') return true;
  }
  return false;
}

/** The sheet a URL names, with the document's host and its `-files` host taken as one (9.1 Serving). */
function sheetKey(url: string, base?: string): string | null {
  try {
    const u = base ? new URL(url, base) : new URL(url);
    return `${u.protocol}//${u.host.replace(/-files$/, '')}${u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * The `@import` statements of a sheet: the sheet each one imports (by sheetKey, resolved against the importing
 * sheet's URL) and its media list (null when the statement has none). CSS.getMediaQueries reports an @import's
 * list with the importing sheet's id, never the imported one's (review finding 13), so it is read from the
 * statement. A no-media import is kept too: the sheet it pulls in inherits the importing sheet's media scope,
 * so a print sheet imported with no media list is still print CSS (finding 13 re-verification).
 */
export function importMediaOf(css: string, sheetUrl: string): { key: string; media: string | null }[] {
  const out: { key: string; media: string | null }[] = [];
  const re = /@import\s+((?:url\(\s*(?:"[^"]*"|'[^']*'|[^)\s]*)\s*\)|"[^"]*"|'[^']*'))([^;{}]*);/gi;
  for (let m = re.exec(css); m && out.length < 1000; m = re.exec(css)) {
    const ref = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)$/i.exec(m[1]);
    const raw = ref ? (ref[1] ?? ref[2] ?? ref[3] ?? '') : m[1].slice(1, -1);
    // `layer`, `layer(name)` and `supports(…)` come before the media list.
    const media = m[2]
      .replace(/^\s*layer(\([^)]*\))?/i, '')
      .replace(/^\s*supports\((?:[^()]|\([^()]*\))*\)/i, '')
      .trim();
    const key = sheetKey(raw, sheetUrl || undefined);
    if (key) out.push({ key, media: media || null });
  }
  return out;
}

/** A sheet's effective print scope: whether it can apply to print, and whether it applies to print only. */
interface PrintScope {
  applies: boolean;
  /** Print only, so an unconditional page-break rule in it is a print break. */
  selects: boolean;
}

/**
 * Reads print CSS out of the document's style sheets (RenderView.styleSheets). A sheet's media scope is its own
 * (`<link media>`, `<style media>`) when it has one, else the scope it inherits through the `@import` chain that
 * pulled it in, narrowed by any media list on those `@import` statements (review finding 13): a print sheet
 * imported — at any depth, with or without a media list on the import — is read as print CSS, and a sheet whose
 * scope never includes print (a `media="screen"` link, or imported only with `screen`) is not read at all.
 */
export function scanPrintCss(sheets: readonly { text: string; media: string | null; url?: string }[]): PrintCssScan {
  const out: PrintCssScan = { pageRule: false, printBreaks: false, printRules: false };
  const texts = sheets.map((s) => stripCssComments(s.text));
  // Map each sheet's key (its own URL) to its index, and the imports each sheet makes (to a child index).
  const indexByKey = new Map<string, number>();
  sheets.forEach((s, i) => {
    const k = s.url ? sheetKey(s.url) : null;
    if (k && !indexByKey.has(k)) indexByKey.set(k, i);
  });
  const imports: { child: number; media: string | null }[][] = sheets.map((s, i) => {
    const list: { child: number; media: string | null }[] = [];
    for (const im of importMediaOf(texts[i], s.url ?? '')) {
      const ci = indexByKey.get(im.key);
      if (ci !== undefined && ci !== i) list.push({ child: ci, media: im.media });
    }
    return list;
  });
  const isChild = new Set<number>(imports.flatMap((l) => l.map((e) => e.child)));
  // A sheet not imported by any other is a root: its scope is its own media (none ⇒ every medium, so print).
  const scope: (PrintScope | undefined)[] = sheets.map((s, i) => {
    if (isChild.has(i)) return undefined;
    const m = s.media;
    return { applies: m === null || mediaAppliesToPrint(m), selects: m !== null && mediaSelectsPrint(m) };
  });
  // Propagate each print-applicable sheet's scope down its imports until nothing changes (handles chains).
  for (let pass = 0; pass < sheets.length * 4; pass++) {
    let changed = false;
    for (let i = 0; i < sheets.length; i++) {
      const ps = scope[i];
      if (!ps || !ps.applies) continue;
      for (const e of imports[i]) {
        const mApplies = e.media === null ? true : mediaAppliesToPrint(e.media);
        const mSelects = e.media === null ? false : mediaSelectsPrint(e.media);
        const childApplies = ps.applies && mApplies;
        const childSelects = childApplies && (ps.selects || mSelects);
        const cur = scope[e.child];
        const applies = (cur?.applies ?? false) || childApplies;
        const selects = (cur?.selects ?? false) || childSelects;
        if (!cur || cur.applies !== applies || cur.selects !== selects) {
          scope[e.child] = { applies, selects };
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  sheets.forEach((s, i) => {
    const sc = scope[i];
    if (!sc || !sc.applies) return;
    if (sc.selects) out.printRules = true;
    scanRules(texts[i], 0, texts[i].length, sc.selects, out, 0);
  });
  return out;
}

/** A printed page's aspect may differ from the slide's by this much and still count as the slide's page. */
export const PAGE_ASPECT_TOLERANCE = 0.01;

/** What Chromium's print of the deck gave: its page sizes (pt), and the slide's design size (px). */
export interface PrintedCheck {
  pageSizes: readonly { w: number; h: number }[];
  design: { w: number; h: number };
}

/** True when every page has the slide's aspect within 1% (decision D-6). */
export function pagesHaveSlideAspect(check: PrintedCheck): boolean {
  const want = check.design.w / check.design.h;
  if (!Number.isFinite(want) || want <= 0 || check.pageSizes.length === 0) return false;
  return check.pageSizes.every((p) => p.w > 0 && p.h > 0 && Math.abs(p.w / p.h / want - 1) <= PAGE_ASPECT_TOLERANCE);
}

/**
 * 6.9's mode: documents print as documents. A deck prints its own print CSS (an @page rule, or print-media
 * page breaks) only when Chromium's print of it is the deck as slide pages: one page per slide
 * (`printedPages`, from a printToPDF of the deck) and every page the slide's aspect within 1% (`check`).
 * Any other deck is rendered slide by slide (decision D-6, review findings 9 and 35): an @page rule alone
 * (`@page { margin: 0 }`) lays out no slide as a page, and printed only what the screen showed, slide 1, or
 * reveal.js's text handout; an @media print layout on the default paper gave Letter pages of a 16:9 slide.
 */
export function decidePdfMode(kind: SlideIndexKind, scan: PrintCssScan, printedPages: number | null, slides: number, check?: PrintedCheck | null): PdfMode {
  if (!isDeck(kind)) return 'document';
  if (!scan.pageRule && !scan.printBreaks) return 'raster';
  if (printedPages === null || printedPages !== slides) return 'raster';
  if (!check || check.pageSizes.length !== printedPages || !pagesHaveSlideAspect(check)) return 'raster';
  return 'print-css';
}

// ------------------------------------------------------------------------------------------- page size

/**
 * Regions that use US Letter (CLDR supplemental paperSize: BZ CA CL CO CR GT MX NI PA PH PR SV US VE);
 * everywhere else uses A4.
 */
export const LETTER_REGIONS: ReadonlySet<string> = new Set(['BZ', 'CA', 'CL', 'CO', 'CR', 'GT', 'MX', 'NI', 'PA', 'PH', 'PR', 'SV', 'US', 'VE']);

/** The two-letter region of a BCP 47 or POSIX locale ('en-US', 'es_MX.UTF-8', 'zh-Hant-TW', 'en-US@posix'), or null. */
export function regionOfLocale(locale: string | null | undefined): string | null {
  if (typeof locale !== 'string') return null;
  const base = locale.split(/[.@]/)[0];
  if (!base || base === 'C' || base === 'POSIX') return null;
  const parts = base.split(/[-_]/);
  for (let i = 1; i < parts.length; i++) {
    if (/^[A-Za-z]{2}$/.test(parts[i])) return parts[i].toUpperCase();
  }
  return null;
}

export function pageSizeForRegion(region: string | null): 'Letter' | 'A4' {
  return region !== null && LETTER_REGIONS.has(region.toUpperCase()) ? 'Letter' : 'A4';
}

export interface LocaleSources {
  /** An explicit locale (tests, a setting), which wins. */
  locale?: string | null;
  /** app.getLocaleCountryCode(): the OS region (macOS, Windows; '' on Linux). */
  countryCode?: string | null;
  /** app.getSystemLocale(). */
  systemLocale?: string | null;
  /** app.getLocale(): the UI language, which may carry a region. */
  appLocale?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * The region the paper size follows: an explicit locale; on Linux LC_ALL or LC_PAPER (POSIX: the paper
 * category); the OS region; the system locale's region; the UI locale's region. Null when none names one.
 */
export function paperRegion(src: LocaleSources): string | null {
  const explicit = regionOfLocale(src.locale ?? null);
  if (explicit) return explicit;
  if ((src.platform ?? process.platform) === 'linux' && src.env) {
    const lc = src.env.LC_ALL || src.env.LC_PAPER;
    const r = regionOfLocale(lc);
    if (r) return r;
  }
  const cc = src.countryCode && /^[A-Za-z]{2}$/.test(src.countryCode) ? src.countryCode.toUpperCase() : null;
  return cc ?? regionOfLocale(src.systemLocale ?? null) ?? regionOfLocale(src.appLocale ?? null);
}

/** The document page size of this machine's locale (6.9 Documents: Letter or A4). */
export function documentPageSize(locale?: string | null): 'Letter' | 'A4' {
  let countryCode = '';
  let systemLocale = '';
  let appLocale = '';
  try {
    countryCode = app.getLocaleCountryCode();
    systemLocale = app.getSystemLocale();
    appLocale = app.getLocale();
  } catch {
    // Before ready (tests): the explicit locale and the environment decide.
  }
  return pageSizeForRegion(paperRegion({ locale, countryCode, systemLocale, appLocale, env: process.env, platform: process.platform }));
}

// ------------------------------------------------------------------------------------------- the title

/** A classic cross-reference table at `at`: object number → {offset, generation}, and the trailer text after it. */
export function readXrefTable(s: string, at: number): { entries: Map<number, { offset: number; gen: number; used: boolean }>; trailer: string } | null {
  if (s.slice(at, at + 4) !== 'xref') return null;
  const entries = new Map<number, { offset: number; gen: number; used: boolean }>();
  const head = /\s*(\d+)\s+(\d+)[ \t]*\r?\n/y;
  const entry = /(\d{10}) (\d{5}) ([nf])[ \r\n]{2}/y;
  let pos = at + 4;
  for (let sections = 0; sections < 100_000; sections++) {
    head.lastIndex = pos;
    const h = head.exec(s);
    if (!h) break;
    pos = head.lastIndex;
    const first = Number(h[1]);
    const count = Number(h[2]);
    if (count > 10_000_000) return null;
    for (let k = 0; k < count; k++) {
      entry.lastIndex = pos;
      const e = entry.exec(s);
      if (!e) return null;
      pos = entry.lastIndex;
      entries.set(first + k, { offset: Number(e[1]), gen: Number(e[2]), used: e[3] === 'n' });
    }
  }
  const t = /\s*trailer\s*<</y;
  t.lastIndex = pos;
  if (!t.exec(s)) return null;
  const end = s.indexOf('startxref', t.lastIndex);
  return { entries, trailer: s.slice(pos, end < 0 ? s.length : end) };
}

/** The [start, end) of the `/Title <value>` entry inside the dictionary text at [from, to), or null. */
export function titleEntryRange(s: string, from: number, to: number): { start: number; end: number } | null {
  const re = /\/Title(?=[\s(<[\]/>])/g;
  re.lastIndex = from;
  const m = re.exec(s);
  if (!m || m.index >= to) return null;
  let i = m.index + m[0].length;
  while (i < to && /\s/.test(s[i])) i++;
  if (s[i] === '(') {
    let depth = 0;
    for (; i < to; i++) {
      const c = s[i];
      if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return { start: m.index, end: i + 1 };
    }
    return null;
  }
  if (s[i] === '<' && s[i + 1] !== '<') {
    const close = s.indexOf('>', i);
    return close >= 0 && close < to ? { start: m.index, end: close + 1 } : null;
  }
  return null;
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/**
 * Sets the PDF's title (null: no title) as an incremental update of Chromium's PDF: the old /Title is
 * blanked in place (it may be the document's URL, which names its docId), and a new revision of the Info
 * dictionary is appended with a cross-reference section for it. Every other byte stays as printToPDF wrote
 * it. Returns null when the file is not one this can update (no classic xref table, encryption).
 */
export async function retitleIncrementally(bytes: Uint8Array, title: string | null): Promise<Uint8Array | null> {
  const s = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const tail = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(s.slice(-1024));
  if (!tail) return null;
  const prev = Number(tail[1]);
  const { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef } = await pdfLib();
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const { Root, Info, Encrypt, ID } = doc.context.trailerInfo;
  if (Encrypt || !(Root instanceof PDFRef) || !(Info instanceof PDFRef)) return null;
  const info = doc.context.lookup(Info);
  if (!(info instanceof PDFDict)) return null;
  // Where the Info object starts: the newest xref section that lists it (following /Prev).
  let at: number | null = prev;
  let place: { offset: number; gen: number } | null = null;
  let size = 0;
  for (let hops = 0; at !== null && hops < 32 && !place; hops++) {
    const x = readXrefTable(s, at);
    if (!x) return null;
    const sz = /\/Size\s+(\d+)/.exec(x.trailer);
    if (sz && hops === 0) size = Number(sz[1]);
    const e = x.entries.get(Info.objectNumber);
    if (e && e.used && e.gen === Info.generationNumber) place = e;
    const p = /\/Prev\s+(\d+)/.exec(x.trailer);
    at = p ? Number(p[1]) : null;
  }
  if (!place) return null;
  const head = `${Info.objectNumber} ${Info.generationNumber} obj`;
  if (s.slice(place.offset, place.offset + head.length) !== head) return null;
  const endobj = s.indexOf('endobj', place.offset);
  if (endobj < 0) return null;

  const out = Buffer.from(bytes);
  const old = titleEntryRange(s, place.offset + head.length, endobj);
  if (old) out.fill(0x20, old.start, old.end);

  const fresh = doc.context.obj({});
  for (const [k, v] of info.entries()) if (k !== PDFName.of('Title')) fresh.set(k, v);
  if (title) fresh.set(PDFName.of('Title'), PDFHexString.fromText(title));
  const num = Info.objectNumber;
  const gen = Info.generationNumber;
  let add = '\n';
  const objOffset = bytes.length + add.length;
  add += `${num} ${gen} obj\n${fresh.toString()}\nendobj\n`;
  const xrefOffset = bytes.length + add.length;
  add += `xref\n${num} 1\n${pad(objOffset, 10)} ${pad(gen, 5)} n \n`;
  add += `trailer\n<<\n/Size ${Math.max(size, doc.context.largestObjectNumber + 1)}\n/Root ${Root.toString()}\n/Info ${num} ${gen} R\n`;
  if (ID) add += `/ID ${ID.toString()}\n`;
  add += `/Prev ${prev}\n>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const result = new Uint8Array(Buffer.concat([out, Buffer.from(add, 'latin1')]));

  // Read it back: same pages, the new title.
  const check = await PDFDocument.load(result, { updateMetadata: false });
  if (check.getPageCount() !== doc.getPageCount() || (check.getTitle() ?? null) !== (title || null)) return null;
  return result;
}

/** Sets the PDF's title: incrementally when possible (see retitleIncrementally), else rewritten by pdf-lib. */
export async function setPdfTitle(bytes: Uint8Array, title: string | null): Promise<Uint8Array> {
  try {
    const inc = await retitleIncrementally(bytes, title);
    if (inc) return inc;
  } catch {
    // fall through to the rewrite
  }
  const { PDFDict, PDFDocument, PDFName } = await pdfLib();
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (title) doc.setTitle(title);
  else {
    const info = doc.context.trailerInfo.Info;
    const dict = info ? doc.context.lookup(info) : undefined;
    if (dict instanceof PDFDict) dict.delete(PDFName.of('Title'));
  }
  return doc.save({ useObjectStreams: false });
}

/** The document's title for the PDF: the rendered <title>, else the one read from the file, else none. */
export function pdfTitleOf(rendered: string, fromFile: string): string | null {
  const t = collapse(rendered) || collapse(fromFile);
  return t ? t.slice(0, 1000) : null;
}

/** Page count of a PDF. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const { PDFDocument } = await pdfLib();
  return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
}

/** Each page's size in points (its MediaBox, as pdf-lib reads it). */
export async function pdfPageSizes(bytes: Uint8Array): Promise<{ w: number; h: number }[]> {
  const { PDFDocument } = await pdfLib();
  return (await PDFDocument.load(bytes, { updateMetadata: false })).getPages().map((p) => {
    const { width, height } = p.getSize();
    return { w: width, h: height };
  });
}

/**
 * Decides a deck's mode from Chromium's print of it (decision D-6), and says why when it is not print-css.
 * `raw` is printToPDF({ preferCSSPageSize: true, printBackground: true }) of the deck as loaded and settled.
 */
export async function printedMode(kind: SlideIndexKind, scan: PrintCssScan, raw: Uint8Array, index: Pick<SlideIndex, 'slides' | 'designSize'>): Promise<{ mode: PdfMode; pages: number; why: string }> {
  const sizes = await pdfPageSizes(raw);
  const slides = index.slides.length;
  const mode = decidePdfMode(kind, scan, sizes.length, slides, { pageSizes: sizes, design: index.designSize });
  let why = '';
  if (mode !== 'print-css') {
    if (sizes.length !== slides) why = `print CSS gave ${sizes.length} pages for ${slides} slides`;
    else {
      const p = sizes.find((s) => !pagesHaveSlideAspect({ pageSizes: [s], design: index.designSize })) ?? sizes[0];
      why = `print CSS gave pages of ${Math.round(p.w)} × ${Math.round(p.h)} pt for a ${index.designSize.w} × ${index.designSize.h} slide`;
    }
  }
  return { mode, pages: sizes.length, why };
}

// ------------------------------------------------------------------------------------------- raster pages

/** BGRA (nativeImage.toBitmap on little-endian machines) to RGB, composited over white where not opaque. */
export function bgraToRgb(bgra: Uint8Array, pixels: number): Uint8Array {
  const rgb = new Uint8Array(pixels * 3);
  for (let p = 0, q = 0; p < pixels; p++, q += 4) {
    const a = bgra[q + 3];
    const o = p * 3;
    if (a === 255) {
      rgb[o] = bgra[q + 2];
      rgb[o + 1] = bgra[q + 1];
      rgb[o + 2] = bgra[q];
    } else {
      const w = 255 - a;
      rgb[o] = Math.round((bgra[q + 2] * a) / 255 + w);
      rgb[o + 1] = Math.round((bgra[q + 1] * a) / 255 + w);
      rgb[o + 2] = Math.round((bgra[q] * a) / 255 + w);
    }
  }
  return rgb;
}

/**
 * Builds the raster PDF page by page: each slide's capture is a lossless Flate-compressed RGB image drawn
 * over the whole page, the page sized to the design size in points. Pages are compressed as they arrive, so
 * a long deck never holds its raw bitmaps. Each capture may name its slide (`slot`): the pages are then laid
 * out in slide order when the PDF is saved, whatever order the walk reached them in (6.9 "one PDF page per
 * slide"; a slide the keys skip is shown by its hash after the others, review finding 33). A slot given twice
 * keeps its last capture.
 */
export class RasterPdf {
  private readonly doc: PDFDocument;
  /** Registered page images by slot. */
  private readonly images = new Map<number, PDFRef>();
  private nextSlot = 0;
  private laidOut = false;

  private constructor(
    doc: PDFDocument,
    private readonly lib: PdfLib,
    private readonly design: { w: number; h: number },
  ) {
    this.doc = doc;
  }

  /** How many pages the PDF has. */
  get pages(): number {
    return this.images.size;
  }

  static async create(design: { w: number; h: number }, title: string | null): Promise<RasterPdf> {
    const lib = await pdfLib();
    const doc = await lib.PDFDocument.create();
    doc.setCreator('Blueline');
    doc.setProducer('Blueline (pdf-lib)');
    if (title) doc.setTitle(title, { showInWindowTitleBar: true });
    return new RasterPdf(doc, lib, design);
  }

  /**
   * Adds one page from a capture's BGRA bitmap of `width` × `height` pixels, as slide `slot` (default: after
   * every page added so far).
   */
  async addPage(bgra: Uint8Array, width: number, height: number, slot?: number): Promise<void> {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || bgra.length < width * height * 4) {
      throw new RenderError('a raster page has no pixels');
    }
    if (slot !== undefined && (!Number.isInteger(slot) || slot < 0)) throw new RenderError('invalid page slot');
    const at = slot ?? this.nextSlot;
    this.nextSlot = Math.max(this.nextSlot, at + 1);
    const rgb = bgraToRgb(bgra, width * height);
    const data = await deflate(rgb, { level: 6 });
    const ctx = this.doc.context;
    const image = ctx.register(
      ctx.stream(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
      }),
    );
    const replaced = this.images.get(at);
    if (replaced) ctx.delete(replaced);
    this.images.set(at, image);
  }

  /** The PDF, one page per slot in slide order. */
  async save(): Promise<Uint8Array> {
    if (this.laidOut) throw new RenderError('the raster PDF was saved already');
    this.laidOut = true;
    const w = this.design.w * PT_PER_PX;
    const h = this.design.h * PT_PER_PX;
    const { concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } = this.lib;
    for (const slot of [...this.images.keys()].sort((a, b) => a - b)) {
      const page = this.doc.addPage([w, h]);
      const name = page.node.newXObject('Slide', this.images.get(slot)!);
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, 0, 0), drawObject(name), popGraphicsState());
    }
    return this.doc.save({ useObjectStreams: false });
  }
}

// ------------------------------------------------------------------------------------------- output

/** The default output: `<deck basename>.pdf` next to the deck (6.1 `blueline pdf deck.html [-o deck.pdf]`). */
export function defaultPdfPath(deckPath: string): string {
  const dir = path.dirname(deckPath);
  const base = path.basename(deckPath);
  const dot = base.lastIndexOf('.');
  return path.join(dir, `${dot > 0 ? base.slice(0, dot) : base}.pdf`);
}

/**
 * Refuses an output that is not an absolute `.pdf` path, is a folder, or is the document itself (by path,
 * realpath, or the same file under another name). Returns the reason, or null.
 */
export async function refusePdfOut(out: string, doc: { realpath: string; path?: string }): Promise<string | null> {
  if (typeof out !== 'string' || !path.isAbsolute(out) || out.includes('\0')) return 'The PDF must be written to an absolute path';
  if (path.resolve(out) === path.resolve(doc.realpath) || (doc.path && path.resolve(out) === path.resolve(doc.path))) return 'The PDF would overwrite the document itself';
  if (!/\.pdf$/i.test(out)) return `${path.basename(out)} is not a .pdf file name`;
  try {
    const st = await fs.promises.stat(out);
    if (st.isDirectory()) return `${path.basename(out)} is a folder`;
    const real = await fs.promises.realpath(out);
    if (real === doc.realpath) return 'The PDF would overwrite the document itself';
    const ds = await fs.promises.stat(doc.realpath);
    if (st.dev === ds.dev && st.ino === ds.ino) return 'The PDF would overwrite the document itself';
  } catch (e) {
    if ((e as { code?: unknown }).code !== 'ENOENT') return `${path.basename(out)} cannot be written`;
  }
  try {
    if (!(await fs.promises.stat(path.dirname(out))).isDirectory()) return 'The folder for the PDF does not exist';
  } catch {
    return 'The folder for the PDF does not exist';
  }
  return null;
}

// ------------------------------------------------------------------------------------------- the pipeline

export interface MadePdf {
  bytes: Uint8Array;
  pages: number;
  mode: PdfMode;
  title: string | null;
  /** Slides navigation could not show (raster), 0-based. */
  missed: number[];
}

export interface PdfOptions {
  signal?: AbortSignal | null;
  host?: RenderHost;
  /** The locale the document page size follows (default: this machine's; 6.9 Documents). */
  locale?: string | null;
  /** The slide index, when the caller has it already. */
  index?: SlideIndex;
}

/**
 * The print CSS of the document loaded in `view`. When its style sheets cannot be read (the debugger is taken,
 * devtools open on a development build), the deck is treated as having none and is rendered slide by slide.
 */
export async function printCssOf(view: Pick<RenderView, 'styleSheets'>, log: (m: string) => void): Promise<PrintCssScan> {
  try {
    const { sheets, truncated } = await view.styleSheets();
    if (truncated) log('pdf: the style sheets were cut at 16 M characters; print CSS was read from the first ones');
    return scanPrintCss(sheets);
  } catch (e) {
    log(`pdf: the style sheets could not be read (${e instanceof Error ? e.message : String(e)}); no print CSS assumed`);
    return { pageRule: false, printBreaks: false, printRules: false };
  }
}

/** Checks a render view has no overlay (6.7: render mode has no UI) before anything is printed from it. */
async function assertNoOverlay(view: RenderView): Promise<void> {
  if (await view.overlayMounted()) throw new RenderError('a render view showed the overlay; nothing is printed from it (6.9: notes are never included)');
}

/**
 * The print-CSS or document print, when it applies: the deck or document loaded in a render view at
 * 1600×900 and printed there. Returns null for a deck that is to be rendered slide by slide.
 */
async function printedPdf(doc: RenderTarget, index: SlideIndex, opts: PdfOptions, host: RenderHost): Promise<MadePdf | null> {
  const signal = opts.signal ?? null;
  return rendererFor(doc, host).use(
    INDEX_VIEWPORT,
    async (view) => {
      throwIfCancelled(signal);
      await view.load(doc);
      await view.waitStable();
      await assertNoOverlay(view);
      if (!isDeck(index.kind)) {
        // What the document's scripts draw or fill in after load (a chart animated by requestAnimationFrame,
        // a section a timer fills) is printed as the reader sees it: the scripted settle, once (decision D-5),
        // as adaptive as the index walk's of the same version (slide-index SettleMemory).
        await settleScripted(view, signal, host.log, { memory: settleMemoryFor(doc.fileKey, doc.version), slot: null });
        await assertNoOverlay(view);
        const title = pdfTitleOf(await view.documentTitle(), doc.title);
        const pageSize = documentPageSize(opts.locale);
        const raw = await view.printToPDF({ printBackground: true, pageSize });
        throwIfCancelled(signal);
        return { bytes: await setPdfTitle(raw, title), pages: await pdfPageCount(raw), mode: 'document', title, missed: [] };
      }
      const scan = await printCssOf(view, host.log);
      if (!scan.pageRule && !scan.printBreaks) return null;
      await settleScripted(view, signal, host.log);
      await assertNoOverlay(view);
      const title = pdfTitleOf(await view.documentTitle(), doc.title);
      const raw = await view.printToPDF({ preferCSSPageSize: true, printBackground: true });
      throwIfCancelled(signal);
      const decided = await printedMode(index.kind, scan, raw, index);
      if (decided.mode !== 'print-css') {
        host.log(`pdf: ${doc.fileName}: ${decided.why}; rendering the slides instead`);
        return null;
      }
      return { bytes: await setPdfTitle(raw, title), pages: decided.pages, mode: 'print-css', title, missed: [] };
    },
    signal,
  );
}

/** The raster PDF: every slide at the design size and 2x, one page each (6.9 Other decks). */
async function rasterPdf(doc: RenderTarget, index: SlideIndex, opts: PdfOptions, host: RenderHost): Promise<MadePdf> {
  const signal = opts.signal ?? null;
  return rendererFor(doc, host).use(
    designViewport(index, RASTER_SCALE),
    async (view) => {
      let title: string | null = null;
      let pdf: RasterPdf | null = null;
      const result = await visitSlides(
        view,
        doc,
        index,
        async (slide) => {
          if (!pdf) {
            title = pdfTitleOf(await view.documentTitle(), doc.title);
            pdf = await RasterPdf.create(index.designSize, title);
          }
          const cap = await view.capture();
          if (cap.empty) throw new RenderError('a slide captured empty');
          const size = cap.image.getSize();
          const bmp = cap.image.toBitmap();
          // In slide order, whatever order the walk reached the slides in (review finding 33).
          await pdf.addPage(new Uint8Array(bmp.buffer, bmp.byteOffset, bmp.byteLength), size.width, size.height, slide);
        },
        { signal, log: host.log },
      );
      throwIfCancelled(signal);
      const made = pdf as RasterPdf | null;
      if (!made) throw new RenderError(`${doc.fileName}: no slide could be shown`);
      return { bytes: await made.save(), pages: made.pages, mode: 'raster', title, missed: result.missed };
    },
    signal,
  );
}

/** Makes the PDF's bytes (6.9 Save as PDF), without writing them. */
export async function makePdf(doc: RenderTarget, opts: PdfOptions = {}): Promise<MadePdf> {
  const host = opts.host ?? renderHost();
  const index = opts.index ?? (await buildSlideIndex(doc, { signal: opts.signal, host }));
  if (index.version !== doc.version) throw new RenderError('the slide index is of another version');
  await untilQuiet(doc.fileKey, opts.signal);
  return (await printedPdf(doc, index, opts, host)) ?? (await rasterPdf(doc, index, opts, host));
}

export interface SaveAsPdfOptions extends PdfOptions {
  /**
   * 9.9 Derived files keep the marker: copies the document's internet marker onto the PDF (`to` is the PDF's
   * temp file, before it is renamed into place). Default: markers.markDerivedFile (the trust-native item's), a
   * no-op on Linux; a Windows volume without streams keeps no marker (allowStreamlessVolume, finding 29).
   */
  copyMarker?: (from: string, to: string) => Promise<void>;
}

/**
 * Writes the PDF's bytes to `out` atomically, marked before it is in place (9.9 Derived files keep the
 * marker): `mark` runs on the temp file, so a mark that fails leaves `out` as it was, a PDF the user chose to
 * replace included (review finding 30), and nothing unmarked is ever at `out`.
 */
export async function writePdfFile(out: string, bytes: Uint8Array, mark: (temp: string) => Promise<void>, fileName: string): Promise<void> {
  let markFailed: unknown = null;
  try {
    await atomicWriteFile(out, bytes, {
      newFileMode: 0o644,
      prepareTemp: async (temp) => {
        try {
          await mark(temp);
        } catch (e) {
          markFailed = e;
          throw e;
        }
      },
    });
  } catch (e) {
    // A derived file that would lose the document's marker is not saved (9.9; when unsure, refuse).
    if (markFailed !== null) throw new RenderError(`The PDF could not keep ${fileName}'s internet marker, so it was not saved (${e instanceof Error ? e.message : String(e)})`);
    throw e;
  }
}

/**
 * 6.9 Save as PDF: makes the PDF and writes it to `out` atomically, with the document's marker (9.9).
 * Refuses an `out` that is not a .pdf path or is the document itself.
 */
export async function saveAsPdf(doc: RenderTarget, out: string, opts: SaveAsPdfOptions = {}): Promise<PdfResult> {
  const refused = await refusePdfOut(out, { realpath: doc.realpath });
  if (refused) throw new RenderError(refused);
  const made = await makePdf(doc, opts);
  throwIfCancelled(opts.signal);
  // Checked again right before the write: what sits at `out` may have changed while the PDF was made (a link
  // to the document put there).
  const late = await refusePdfOut(out, { realpath: doc.realpath });
  if (late) throw new RenderError(late);
  const copyMarker =
    opts.copyMarker ??
    ((from: string, to: string) => markDerivedFile(to, { realpath: from, marker: doc.marker, protectedView: doc.isProtected() }, { allowStreamlessVolume: true }));
  await writePdfFile(out, made.bytes, (temp) => copyMarker(doc.realpath, temp), doc.fileName);
  return { out, pages: made.pages, mode: made.mode, title: made.title, missed: made.missed };
}
