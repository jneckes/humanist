// The exit-gate harness: an Electron main of its own (bundled by harness/bundle.mjs), started by
// scripts/parity.mjs and scripts/first-paint.mjs with --bl-parity-job=<job.json>. It measures SPEC 10 Phase 1's
// exit gate on this machine:
//
// Render parity (SPEC 10 Phase 1; 11 Render parity and PDF). For every slide of a deck, at the 6.9 design size
// and 2x, two renders in the same Electron:
//   (a) Blueline's: the render service exactly as the render products use it (render-service rendererFor and
//       slide-index visitSlides): the document opened by documents.ts loadDocument in its own trust state and
//       partition, with the session policy and the blueline:// handler a document window installs (9.1, 9.9),
//       the served stamped copy, the deck preload in render mode (no overlay: visitSlides checks once per walk,
//       right after the load, and render mode creates no UI that could mount one later), reduced motion (Josh's
//       decision 1: background renders);
//   (b) the plain render of the original file (plain-view.ts): file://, no preload, no protocol, a partition of
//       its own, the same viewport, scale, reduced motion, navigation and settle steps (6.7 step 3 and the
//       scripted settle, slide-index settleScripted).
// Every frame of both gets the same seeded Math.random before any page script (decision D-10: SEEDED_RANDOM_JS,
// installSeededRandom); Date, performance.now and crypto are left alone. A third render, the control, is a
// second plain render walked the same way: a slide whose control differs from the plain render is listed as
// nondeterministic (compare.ts slideVerdict). Both renders then get the freeze step (plain-view FREEZE_JS) and a
// stable-frame wait (two consecutive captures identical, up to 3 s), and the bitmaps (nativeImage.toBitmap) are
// compared pixel by pixel (compare.ts): the share that differs at all, and the share over the per-channel
// tolerance (2: rounding noise), which is the gate (0.5%). The visible-text signature and the scroll position
// of both are recorded and listed per deck where they differ; they are not part of the verdict.
//
// PDF (SPEC 10 Phase 1: "the right page count, and each page within 1% of its slide render"): saveAsPdf (pdf.ts)
// as Save as PDF runs it, in whatever mode it picks. Raster pages' images are read back from the PDF
// (pdf-pages.ts) and compared with Blueline's slide renders of the parity walk; printToPDF pages (print CSS,
// documents) are compared with the plain window's printToPDF of the original with the same options, after the
// same scripted settle: page count, every page's size, and (with pdftoppm) pixels (pdf-pages printedVerdict).
//
// Bench (scripts/first-paint.mjs): the main-process share of opening a document (read, hash, decode, map,
// served copy, protocol response), timed with the app's own functions.
//
// Nothing here is part of the app: no app file imports it, and it runs only from the scripts above.

import { app, nativeImage, session, type NativeImage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildMap } from '@blueline/core/mapper';
import { buildServedCopy } from '@blueline/core/served';
import { decodeDeck, encodeDeck } from '@blueline/core/text';
import type { SlideIndex } from '@blueline/core/ipc-render';
import { readRegularFile, sha256Hex } from '../../../packages/app/src/main/atomic-write';
import { loadDocument, type BlDocument } from '../../../packages/app/src/main/documents';
import { DEFAULT_ALLOWLIST, pickClosedLoopbackPort } from '../../../packages/app/src/main/network-policy';
import { bgraToRgb, documentPageSize, saveAsPdf } from '../../../packages/app/src/main/pdf';
import { deckUrl, handleDeckRequest, installDeckProtocol, registerPrivilegedSchemes } from '../../../packages/app/src/main/protocol';
import { RenderView, disposeRenderer, rendererFor, renderTargetFor, type RenderHost, type RenderTarget } from '../../../packages/app/src/main/render-service';
import { INDEX_VIEWPORT, SCRIPTED_SETTLE, buildSlideIndex, designViewport, replayKeys, settleScripted, visitSlides } from '../../../packages/app/src/main/slide-index';
import { installDeckSessionPolicy, type DeckSessionHandle } from '../../../packages/app/src/main/trust-hooks';
import { HISTOGRAM_BINS, addHistograms, comparePixels, deckTallies, diffImage, median, sameBitmap, slideVerdict, type PixelStats } from './compare';
import { redactor } from './decks';
import type { BenchJob, BenchResult, BenchRun, DeckParity, HarnessJob, ParityJob, ParityResult, PdfParity, SlideParity, SlideStats, TrustChoice } from './job';
import { PAGE_SIZE_TOLERANCE_PT, decodePageImage, findPdftoppm, pdfPages, printedVerdict, rasterisePage, type PdfPages } from './pdf-pages';
import { PlainView, SEEDED_RANDOM_JS, addInitScript, charsetOf, freezeAnimations, scrollYOf } from './plain-view';

// ------------------------------------------------------------------------------------------- startup

const jobArg = process.argv.find((a) => a.startsWith('--bl-parity-job='));
const job: HarnessJob | null = jobArg ? (JSON.parse(fs.readFileSync(jobArg.slice('--bl-parity-job='.length), 'utf8')) as HarnessJob) : null;
const redact = job && job.kind === 'parity' ? redactor(job.decks) : (t: string) => t;

function log(msg: string): void {
  process.stderr.write(`[parity] ${redact(msg)}\n`);
}

// Before ready, as the app does (index.ts): the privileged schemes (9.1 Registration), a private userData and
// session folder, and the sandbox for every renderer unless running as root with --no-sandbox.
registerPrivilegedSchemes();
if (job) {
  const ud = path.join(job.workDir, `userdata-${process.pid}`);
  fs.mkdirSync(ud, { recursive: true, mode: 0o700 });
  app.setPath('userData', ud);
  app.setPath('sessionData', path.join(ud, 'session'));
}
if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();
app.on('window-all-closed', () => undefined);

// The script that started this run may be killed outright: under xvfb-run this process is then re-parented,
// and the run stops rather than measuring for nobody.
const startPpid = process.ppid;
setInterval(() => {
  if (process.ppid !== startPpid) {
    log('the command that started the harness went away: stopping');
    app.exit(130);
  }
}, 1000).unref();

void app.whenReady().then(async () => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  let code = 0;
  try {
    if (!job) throw new Error('usage: electron parity-main.cjs --bl-parity-job=<job.json>');
    code = job.kind === 'parity' ? await runParity(job) : await runBench(job);
  } catch (e) {
    log(`failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    code = 1;
  }
  app.exit(code);
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The document's partition set up as a document window sets it up (pdf-command servePartition): 9.9 then 9.1. */
async function servePartition(doc: BlDocument): Promise<DeckSessionHandle> {
  const ses = session.fromPartition(doc.partition);
  const policy = installDeckSessionPolicy(ses, {
    trust: () => doc.trust(),
    networkAllowed: () => doc.networkAllowed(),
    strict: () => false,
    allowlist: () => DEFAULT_ALLOWLIST,
    blockPort: await pickClosedLoopbackPort(),
    sourcePath: () => doc.realpath,
  });
  try {
    await policy.ready;
  } catch (e) {
    policy.dispose();
    throw e;
  }
  installDeckProtocol(ses, (id) => (id === doc.docId ? doc : undefined));
  return policy;
}

// ------------------------------------------------------------------------------------------- captures

interface Shot {
  image: NativeImage;
  bitmap: Buffer;
  width: number;
  height: number;
  sizeOk: boolean;
  stable: boolean;
  tries: number;
}

/** Captures until two consecutive captures are identical, or `timeoutMs` passed (then the last one, unstable). */
async function stableShot(v: Pick<RenderView, 'capture'>, timeoutMs = 3000): Promise<Shot> {
  let cap = await v.capture();
  let bmp = cap.image.toBitmap();
  const end = Date.now() + timeoutMs;
  let tries = 1;
  while (Date.now() < end) {
    await sleep(120);
    const next = await v.capture();
    const nb = next.image.toBitmap();
    tries++;
    if (sameBitmap(bmp, nb)) return { image: next.image, bitmap: nb, width: next.width, height: next.height, sizeOk: next.sizeOk, stable: true, tries };
    cap = next;
    bmp = nb;
  }
  return { image: cap.image, bitmap: bmp, width: cap.width, height: cap.height, sizeOk: cap.sizeOk, stable: false, tries };
}

const seeded = new WeakSet<Electron.WebContents>();

/**
 * The seeded Math.random (plain-view SEEDED_RANDOM_JS) on every render view this run makes, however the render
 * pool makes it: the index walk's and the PDF's views, the parity walk's, and one the pool replaced or reopened
 * after its idle close (render-service ViewSlots). RenderView.load is wrapped, in this harness process only, to
 * register the script through the view's own debugger before the view's first load; it lasts across later
 * loads while the debugger stays attached, as reduced motion does. The app is unchanged: its own process never
 * runs this, and in the harness the deck preload, the served copy and the session are as the app makes them.
 */
function installSeededRandom(): void {
  const load = RenderView.prototype.load;
  RenderView.prototype.load = async function seededLoad(this: RenderView, ...args: Parameters<RenderView['load']>): Promise<void> {
    if (!seeded.has(this.wc)) {
      await addInitScript(this.wc, SEEDED_RANDOM_JS);
      seeded.add(this.wc);
    }
    return load.apply(this, args);
  };
}

/** What the result says about randomness, the control and the checks (decision D-10; finding 39), in words. */
function methodFacts(job: ParityJob, pdftoppm: boolean): Pick<ParityResult, 'determinism' | 'method'> {
  const seededRandom = job.seedRandom !== false;
  return {
    determinism: {
      seededRandom,
      randomness: seededRandom
        ? 'Math.random is a seeded mulberry32 (seed 0x2f6b1d35), the same in every frame of every render (Blueline\'s render views, the plain render, its control, the plain print), installed before any page script by Page.addScriptToEvaluateOnNewDocument through each window\'s own debugger; Date, performance.now and crypto.getRandomValues are left alone (no committed fixture needs them fixed)'
        : 'DIAGNOSIS (--unseeded): Math.random is the page\'s own in every render; Date, performance.now and crypto.getRandomValues are left alone',
      control:
        'a second plain render of the same file per slide, navigated, settled, frozen and captured like the plain render; a slide whose control differs from the plain render at all is listed as nondeterministic and judged like any other slide (over the gate it fails, within it it passes, listed)',
    },
    method: {
      overlay:
        'checked once per walk, by visitSlides (slide-index.ts), right after the document loads and before the first slide: a render view that shows the overlay is refused; in render mode the deck preload creates no UI (preload/deck.ts), so nothing mounts the overlay after that check',
      sameSlide:
        'decks: the plain render reaches each slide by the means Blueline\'s walk used (Reveal.slide, the same keys, the hash) and confirms it with the render agent\'s 9.4 detection, and a slide it cannot reach fails; documents: both renders scroll the section\'s heading to the top, and nothing more is confirmed; for both, the visible-text signatures and the scroll positions of the two renders are recorded per slide and listed per deck where they differ (textDiffers, scrollDiffers), not part of the verdict',
      tolerance: `a pixel counts as different when one channel differs by more than ${job.tolerance} of 255; a slide passes with at most ${job.gate * 100}% of its pixels so; the slides identical to the byte are counted beside it`,
      pdf: `raster pages: page count against the slide count, each page's image against Blueline's render of its slide (at most ${job.pdfGate * 100}% of pixels over the tolerance); pages Chromium prints (print CSS, documents): page count and every page's size (within ${PAGE_SIZE_TOLERANCE_PT} pt) against Chromium's own print of the original file, and ${pdftoppm ? 'each page rasterised by pdftoppm and compared with the plain print\'s page' : 'no pixels (pdftoppm not available)'}`,
    },
  };
}

function slim(s: PixelStats): SlideStats {
  return { exact: s.exact, over: s.over, exactShare: s.exactShare, overShare: s.overShare, maxDelta: s.maxDelta, histogram: s.histogram, box: s.box };
}

function safeName(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function writePng(file: string, image: NativeImage): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, image.toPNG());
}

/** Writes the diff picture (red: over tolerance; amber: within) of two same-size bitmaps. */
function writeDiff(file: string, a: Uint8Array, b: Uint8Array, width: number, height: number, channels: 3 | 4, tolerance: number): void {
  const mask = new Uint8Array(width * height);
  comparePixels(a, b, width, height, { channels, tolerance, mask });
  let base: Uint8Array = a;
  if (channels === 3) {
    // diffImage reads BGRA: widen RGB.
    const bgra = Buffer.alloc(width * height * 4);
    for (let p = 0; p < width * height; p++) {
      bgra[p * 4] = a[p * 3 + 2];
      bgra[p * 4 + 1] = a[p * 3 + 1];
      bgra[p * 4 + 2] = a[p * 3];
      bgra[p * 4 + 3] = 255;
    }
    base = bgra;
  }
  const img = nativeImage.createFromBitmap(diffImage(base, mask, width, height), { width, height });
  writePng(file, img);
}

// ------------------------------------------------------------------------------------------- PDF

interface PdfState {
  result: PdfParity;
  pages: PdfPages;
  /** slide index → page index (raster: the slides the PDF walk showed, in order). */
  pageOf: Map<number, number>;
  bytes: Uint8Array;
}

/** Saves the PDF as Save as PDF does, and reads its pages back. Marker copying is not part of the measurement. */
async function makePdf(job: ParityJob, deckLabel: string, trust: TrustChoice, target: RenderTarget, index: SlideIndex, host: RenderHost): Promise<PdfState> {
  const file = path.join(job.workDir, 'pdf', `${safeName(deckLabel)}-${trust}.pdf`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  const t0 = Date.now();
  const r = await saveAsPdf(target, file, { host, index, copyMarker: async () => undefined });
  const ms = Date.now() - t0;
  const bytes = new Uint8Array(fs.readFileSync(file));
  const pages = await pdfPages(bytes);
  const shown = index.slides.map((s) => s.index).filter((i) => !r.missed.includes(i));
  const pageOf = new Map<number, number>();
  if (r.mode === 'raster') shown.forEach((slide, page) => pageOf.set(slide, page));
  else for (let i = 0; i < Math.min(pages.pageCount, index.slides.length); i++) pageOf.set(i, i);
  const result: PdfParity = {
    mode: r.mode,
    pages: pages.pageCount,
    expectedPages: index.slides.length,
    plainPages: null,
    missed: r.missed,
    ms,
    pageCountOk: false,
    sizes: { blueline: pages.sizes, plain: null },
    sizesOk: null,
    sizeMismatches: [],
    pageStats: [],
    compared: '',
    pass: false,
    file: path.relative(job.workDir, file),
  };
  return { result, pages, pageOf, bytes };
}

/** pdftoppm, unless the job turned it off (--no-pdftoppm: compare as a machine without poppler does). */
function pdftoppmFor(job: ParityJob): string | null {
  return job.pdftoppm === false ? null : findPdftoppm();
}

/**
 * printToPDF decks and documents: the plain window prints the original file with Blueline's options, after the
 * same scripted settle; the page counts and every page's size are compared, and with pdftoppm each page of both
 * PDFs is rasterised at the same size (the page in CSS px at 2x) and compared (pdf-pages printedVerdict).
 */
async function comparePrinted(job: ParityJob, deck: { label: string; file: string }, trust: TrustChoice, state: PdfState): Promise<void> {
  const r = state.result;
  if (r.mode === 'raster') throw new Error('comparePrinted: a raster PDF');
  const mode = r.mode;
  const plain = new PlainView(deck.file, { ...INDEX_VIEWPORT }, `parity-print-${Date.now()}-${Math.random().toString(16).slice(2)}`, '', replayKeys(null), log, {
    seedRandom: job.seedRandom !== false,
  });
  let plainFile: string;
  let plainPdf: PdfPages;
  try {
    // pdf.ts printedPdf: the deck loaded at 1600×900, settled (6.7 step 3 and what scripts reveal, decision
    // D-5: the full wait, as Blueline gives a print-CSS deck; never shorter than the adaptive wait it gives a
    // document), printed.
    await plain.loadPlain();
    await settleScripted(plain.probe, null, log, SCRIPTED_SETTLE);
    const opts: Electron.PrintToPDFOptions = mode === 'document' ? { printBackground: true, pageSize: documentPageSize(null) } : { preferCSSPageSize: true, printBackground: true };
    const bytes = await plain.printToPDF(opts);
    plainFile = path.join(job.workDir, 'pdf', `${safeName(deck.label)}-${trust}-plain.pdf`);
    fs.writeFileSync(plainFile, bytes);
    plainPdf = await pdfPages(bytes);
  } finally {
    plain.close();
  }
  r.plainPages = plainPdf.pageCount;
  r.sizes.plain = plainPdf.sizes;
  if (mode === 'document') r.expectedPages = r.plainPages;
  const judge = (pageStats: PdfParity['pageStats'] | null) => {
    const v = printedVerdict({ mode, pages: r.pages, expectedPages: r.expectedPages, plainPages: plainPdf.pageCount, sizes: { blueline: state.pages.sizes, plain: plainPdf.sizes }, pageStats });
    r.pageCountOk = v.pageCountOk;
    r.sizesOk = v.sizesOk;
    r.sizeMismatches = v.sizeMismatches;
    r.compared = v.compared;
    r.pass = v.pass;
    for (const m of v.sizeMismatches) log(`${deck.label}: PDF page ${m.page + 1} is ${m.blueline.w} × ${m.blueline.h} pt, the plain print's ${m.plain.w} × ${m.plain.h} pt`);
  };
  if (!pdftoppmFor(job)) {
    judge(null);
    return;
  }
  const blFile = path.join(job.workDir, state.result.file);
  const tmp = path.join(job.workDir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  let saved = 0;
  for (let k = 0; k < Math.min(r.pages, r.plainPages); k++) {
    const size = state.pages.sizes[k];
    // A page of w pt is w / 0.75 CSS px; at 2x, w × 8/3 device pixels.
    const w = Math.max(1, Math.round((size.w * 8) / 3));
    const h = Math.max(1, Math.round((size.h * 8) / 3));
    const a = await rasterisePage(blFile, k + 1, w, h, tmp);
    const b = await rasterisePage(plainFile, k + 1, w, h, tmp);
    const s = comparePixels(a.rgb, b.rgb, w, h, { channels: 3, tolerance: job.tolerance });
    const pass = s.overShare <= job.pdfGate;
    r.pageStats.push({ page: k, against: 'plain-print', stats: slim(s), pass });
    if (!pass && saved < job.maxSaved) {
      saved++;
      writeDiff(path.join(job.workDir, 'diff', safeName(deck.label), `${trust}-pdf-page-${k + 1}-diff.png`), a.rgb, b.rgb, w, h, 3, job.tolerance);
    }
  }
  judge(r.pageStats);
}

// ------------------------------------------------------------------------------------------- one deck

let plainSeq = 0;

function emptyTallies(): Pick<DeckParity, 'compared' | 'identical' | 'nondeterministic' | 'textDiffers' | 'scrollDiffers'> {
  return { compared: 0, identical: 0, nondeterministic: [], textDiffers: [], scrollDiffers: [] };
}

/**
 * Brings a plain window (the plain render, or its control) to slide `i` and settles it as visitSlides settled
 * Blueline's render before handing it the slide: 6.7 step 3, what the slide's scripts reveal (the full scripted
 * settle, never shorter than Blueline's adaptive one), step 3 again, running animations paused. Then the dwell:
 * it stays on the slide at least `dwellMs` from its arrival before anything is frozen or captured. Blueline's
 * render arrived first (the plain render is navigated once it has), so without the dwell a reveal timed by
 * script (setTimeout, a typewriter) would be further along in Blueline's capture than in the plain one.
 */
async function plainAt(pv: PlainView, i: number, index: SlideIndex, dwellMs: number): Promise<{ ok: boolean; how: string; arrived: number }> {
  const nav = await pv.goTo(i, index);
  const arrived = Date.now();
  await settleScripted(pv.probe, null, (m) => log(`plain ${m}`), SCRIPTED_SETTLE);
  await pv.probe.pauseAnimations();
  // (A timer may fire a millisecond early on the wall clock: loop until the dwell has really passed.)
  while (Date.now() < arrived + dwellMs) await sleep(arrived + dwellMs - Date.now());
  return { ...nav, arrived };
}

async function parityDeck(job: ParityJob, deck: ParityJob['decks'][number], trustAsked: TrustChoice, host: RenderHost, probeSrc: string, total: number[]): Promise<DeckParity> {
  const t0 = Date.now();
  const res: DeckParity = {
    label: deck.label,
    trustAsked,
    trust: trustAsked,
    kind: '?',
    navKind: '?',
    slides: 0,
    designSize: { w: 0, h: 0 },
    indexComplete: false,
    indexMs: 0,
    charset: { blueline: '', plain: '' },
    missed: [],
    ...emptyTallies(),
    failures: 0,
    worstOver: 0,
    worstExact: 0,
    worstSlide: null,
    pass: false,
    results: [],
    ms: 0,
    errors: [],
  };
  const doc = await loadDocument(deck.file, { protectedRequested: trustAsked === 'protected' });
  res.trust = doc.trust();
  let policy: DeckSessionHandle | null = null;
  let plain: PlainView | null = null;
  let plain2: PlainView | null = null;
  try {
    policy = await servePartition(doc);
    const target = renderTargetFor(doc, { deckNav: deck.deckNav ?? null });
    const ti = Date.now();
    const index = await buildSlideIndex(target, { host, force: true });
    res.indexMs = Date.now() - ti;
    res.kind = index.kind;
    res.navKind = index.navKind;
    res.slides = index.slides.length;
    res.designSize = { ...index.designSize };
    res.indexComplete = index.complete;
    log(`${deck.label} (${res.trust}): ${index.kind}, ${index.slides.length} slides, design ${index.designSize.w}×${index.designSize.h}, index ${res.indexMs} ms`);

    let pdf: PdfState | null = null;
    if (job.pdf) {
      try {
        pdf = await makePdf(job, deck.label, res.trust, target, index, host);
        log(`${deck.label}: PDF ${pdf.result.mode}, ${pdf.result.pages} pages in ${pdf.result.ms} ms`);
        if (pdf.result.mode !== 'raster') await comparePrinted(job, deck, res.trust, pdf);
        else pdf.result.pageCountOk = pdf.result.pages === index.slides.length;
      } catch (e) {
        res.pdf = { error: e instanceof Error ? e.message : String(e), pass: false };
        log(`${deck.label}: PDF failed: ${res.pdf.error}`);
      }
    }

    const vp = designViewport(index);
    const keys = replayKeys(target.deckNav);
    const seedRandom = job.seedRandom !== false;
    plain = new PlainView(deck.file, vp, `parity-plain-${process.pid}-${++plainSeq}`, probeSrc, keys, log, { seedRandom });
    await plain.load();
    res.charset.plain = await charsetOf(plain.wc);
    // The control (decision D-10): a second plain render, walked the same way, for the deck's own variance
    // between two loads with the same seeded Math.random.
    plain2 = new PlainView(deck.file, vp, `parity-plain-${process.pid}-${++plainSeq}`, probeSrc, keys, log, { seedRandom });
    await plain2.load();
    const pv2 = plain2;
    const pv = plain;
    let saved = 0;
    let controlSaved = 0;
    let pdfSaved = 0;
    const screenStats: { page: number; stats: SlideStats }[] = [];
    const tmp = path.join(job.workDir, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const walk = await rendererFor(target, host).use(vp, async (view) =>
      visitSlides(
        view,
        target,
        index,
        async (i) => {
          const r: SlideParity = {
            slide: i,
            plainNav: '',
            sameText: false,
            dwell: { blueline: 0, plain: 0 },
            stable: { blueline: false, plain: false },
            frozen: { blueline: 0, plain: 0 },
            scrollY: { blueline: 0, plain: 0 },
            stats: null,
            pass: false,
            control: null,
            nondeterministic: false,
            notes: [],
          };
          res.results.push(r);
          if (!res.charset.blueline) res.charset.blueline = await charsetOf(view.wc);
          // Blueline's render arrived and settled when visitSlides called here; the plain render arrives below.
          // Blueline's dwell is the longer of the two by the plain render's navigation time.
          const arrivedB = Date.now();
          try {
            const nav = await plainAt(pv, i, index, job.dwellMs);
            r.plainNav = nav.how;
            if (!nav.ok) r.notes.push('the plain render could not be brought to this slide');
            r.dwell = { blueline: Date.now() - arrivedB, plain: Date.now() - nav.arrived };
            try {
              r.frozen.blueline = await freezeAnimations(view.wc);
              r.frozen.plain = await freezeAnimations(pv.wc);
              const [sb, sp] = await Promise.all([view.visibleTextSignature(), pv.visibleTextSignature()]);
              r.sameText = sb === sp && sb !== '';
              r.scrollY = { blueline: await scrollYOf(view.wc), plain: await scrollYOf(pv.wc) };
              const a = await stableShot(view);
              const b = await stableShot(pv.probe);
              r.stable = { blueline: a.stable, plain: b.stable };
              if (!a.sizeOk || !b.sizeOk || a.width !== b.width || a.height !== b.height) {
                r.notes.push(`capture sizes differ: ${a.width}×${a.height} and ${b.width}×${b.height}`);
              } else {
                const s = comparePixels(a.bitmap, b.bitmap, a.width, a.height, { channels: 4, tolerance: job.tolerance });
                r.stats = slim(s);
                addHistograms(total, s.histogram);
              }
              // The control: the second plain render brought to the same slide the same way, against the first.
              const base = path.join('diff', safeName(deck.label), `${res.trust}-slide-${String(i + 1).padStart(2, '0')}`);
              try {
                const n2 = await plainAt(pv2, i, index, job.dwellMs);
                try {
                  await freezeAnimations(pv2.wc);
                  const c = await stableShot(pv2.probe);
                  if (!n2.ok) r.notes.push(`the control render could not be brought to this slide (${n2.how})`);
                  else if (!c.sizeOk || c.width !== b.width || c.height !== b.height) r.notes.push(`control capture is ${c.width}×${c.height}, the plain one ${b.width}×${b.height}`);
                  else {
                    r.control = slim(comparePixels(b.bitmap, c.bitmap, b.width, b.height, { channels: 4, tolerance: job.tolerance }));
                    // What differed between two plain loads, for the diagnosis (the plain render is saved below).
                    if (r.control.exact > 0 && (controlSaved < job.maxSaved || job.saveAll)) {
                      controlSaved++;
                      writeDiff(path.join(job.workDir, `${base}-control-diff.png`), b.bitmap, c.bitmap, b.width, b.height, 4, job.tolerance);
                      writePng(path.join(job.workDir, `${base}-control.png`), c.image);
                      r.savedControl = { diff: `${base}-control-diff.png`, control: `${base}-control.png` };
                    }
                  }
                } finally {
                  await pv2.probe.resumeAnimations();
                }
              } catch (e) {
                r.notes.push(`control: ${e instanceof Error ? e.message : String(e)}`);
              }
              const verdict = slideVerdict({ navOk: nav.ok, stats: r.stats, control: r.control }, job.gate);
              r.pass = verdict.pass;
              r.nondeterministic = verdict.nondeterministic;
              if (r.stats && ((!r.pass && saved < job.maxSaved) || job.saveAll || r.savedControl)) {
                if (!r.pass) saved++;
                writeDiff(path.join(job.workDir, `${base}-diff.png`), a.bitmap, b.bitmap, a.width, a.height, 4, job.tolerance);
                writePng(path.join(job.workDir, `${base}-blueline.png`), a.image);
                writePng(path.join(job.workDir, `${base}-plain.png`), b.image);
                r.saved = { diff: `${base}-diff.png`, blueline: `${base}-blueline.png`, plain: `${base}-plain.png` };
              }
              // The PDF page of this slide, against both renders.
              const page = pdf?.pageOf.get(i);
              if (pdf && page !== undefined) {
                try {
                  if (pdf.result.mode === 'raster') {
                    const img = pdf.pages.images[page];
                    if (!img) throw new Error('the page has no single image');
                    if (img.width !== a.width || img.height !== a.height) throw new Error(`page image is ${img.width}×${img.height}, the render ${a.width}×${a.height}`);
                    const rgb = decodePageImage(img);
                    const ra = bgraToRgb(a.bitmap, a.width * a.height);
                    const rb = bgraToRgb(b.bitmap, b.width * b.height);
                    const vb = comparePixels(rgb, ra, a.width, a.height, { channels: 3, tolerance: job.tolerance });
                    const vpn = comparePixels(rgb, rb, a.width, a.height, { channels: 3, tolerance: job.tolerance });
                    const pass = vb.overShare <= job.pdfGate;
                    r.pdf = { page, vsBlueline: slim(vb), vsPlain: slim(vpn), pass };
                    pdf.result.pageStats.push({ page, against: 'slide-render', stats: slim(vb), pass });
                    if (!pass && pdfSaved < job.maxSaved) {
                      pdfSaved++;
                      writeDiff(path.join(job.workDir, 'diff', safeName(deck.label), `${res.trust}-pdf-page-${page + 1}-diff.png`), rgb, ra, a.width, a.height, 3, job.tolerance);
                    }
                  } else if (pdf.result.mode === 'print-css' && pdftoppmFor(job)) {
                    // Information only: the printed page against the slide's screen render.
                    const pr = await rasterisePage(path.join(job.workDir, pdf.result.file), page + 1, a.width, a.height, tmp);
                    screenStats.push({ page, stats: slim(comparePixels(pr.rgb, bgraToRgb(a.bitmap, a.width * a.height), a.width, a.height, { channels: 3, tolerance: job.tolerance })) });
                  }
                } catch (e) {
                  if (pdf.result.mode === 'raster') {
                    r.pdf = { page, error: e instanceof Error ? e.message : String(e), pass: false };
                    pdf.result.pageStats.push({ page, against: 'slide-render', stats: { exact: 0, over: 0, exactShare: 1, overShare: 1, maxDelta: 255, histogram: [], box: null }, pass: false });
                  } else r.notes.push(`print page ${page + 1}: ${e instanceof Error ? e.message : String(e)}`);
                }
              }
            } finally {
              await pv.probe.resumeAnimations();
            }
          } catch (e) {
            r.notes.push(`error: ${e instanceof Error ? e.message : String(e)}`);
          }
          const s = r.stats;
          const c = r.control;
          log(
            `${deck.label} slide ${i + 1}/${index.slides.length}: ${s ? `${(s.overShare * 100).toFixed(3)}% over tol, ${(s.exactShare * 100).toFixed(3)}% exact-diff, max Δ ${s.maxDelta}` : 'not compared'}` +
              `${r.plainNav ? ` [${r.plainNav}]` : ''}${r.sameText ? '' : ' (text differs)'}${r.scrollY.blueline !== r.scrollY.plain ? ` (scroll ${r.scrollY.blueline} and ${r.scrollY.plain})` : ''}` +
              `${c ? ` control ${(c.exactShare * 100).toFixed(3)}% exact-diff${r.nondeterministic ? ' NONDETERMINISTIC' : ''}` : ' control not compared'}` +
              `${r.pdf ? ` pdf ${'error' in r.pdf ? r.pdf.error : `${(r.pdf.vsBlueline.overShare * 100).toFixed(3)}%`}` : ''}${r.pass ? '' : ' FAIL'}`,
          );
        },
        { log },
      ),
    );
    res.missed = walk.missed;
    if (pdf) {
      if (pdf.result.mode === 'raster') {
        pdf.result.compared = "page count against the slide count; each page's image XObject decoded from the PDF and compared with Blueline's render of its slide in the parity walk (the gate) and, for information, with the plain render";
        pdf.result.pageStats.sort((x, y) => x.page - y.page);
        pdf.result.pass = pdf.result.pageCountOk && pdf.result.pageStats.length === pdf.result.pages && pdf.result.pageStats.every((p) => p.pass);
      } else if (screenStats.length) pdf.result.screenStats = screenStats;
      res.pdf = pdf.result;
    }
  } catch (e) {
    res.errors.push(e instanceof Error ? e.message : String(e));
    log(`${deck.label}: ${res.errors[res.errors.length - 1]}`);
  } finally {
    disposeRenderer(doc.docId);
    policy?.dispose();
    plain?.close();
    plain2?.close();
    doc.release();
  }
  res.results.sort((a, b) => a.slide - b.slide);
  Object.assign(res, deckTallies(res.results));
  res.failures = res.results.filter((r) => !r.pass).length + res.missed.length;
  for (const r of res.results) {
    if (!r.stats) continue;
    if (res.worstSlide === null || r.stats.overShare > res.worstOver) {
      res.worstOver = r.stats.overShare;
      res.worstSlide = r.slide;
    }
    res.worstExact = Math.max(res.worstExact, r.stats.exactShare);
  }
  res.pass = res.errors.length === 0 && res.slides > 0 && res.missed.length === 0 && res.compared === res.slides && res.results.every((r) => r.pass);
  res.ms = Date.now() - t0;
  if (res.charset.blueline && res.charset.plain && res.charset.blueline !== res.charset.plain) log(`${deck.label}: decoded as ${res.charset.blueline} by Blueline, ${res.charset.plain} by the plain render`);
  const list = (xs: number[]) => xs.map((x) => x + 1).join(', ');
  log(
    `${deck.label} (${res.trust}): ${res.pass ? 'pass' : 'FAIL'}; ${res.identical} of ${res.compared} slides identical to the byte` +
      `${res.nondeterministic.length ? `; nondeterministic (control differs): slides ${list(res.nondeterministic)}` : ''}` +
      `${res.textDiffers.length ? `; visible text differs (recorded): slides ${list(res.textDiffers)}` : ''}` +
      `${res.scrollDiffers.length ? `; scroll position differs (recorded): slides ${list(res.scrollDiffers)}` : ''}`,
  );
  return res;
}

async function withDeckTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_r, reject) => (timer = setTimeout(() => reject(new Error(`${what}: gave up after ${Math.round(ms / 1000)} s`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

async function runParity(job: ParityJob): Promise<number> {
  const probeSrc = fs.readFileSync(job.probeFile, 'utf8');
  const host: RenderHost = { preload: job.preload, userData: app.getPath('userData'), log, devTools: false };
  if (job.seedRandom !== false) installSeededRandom();
  const pdftoppm = pdftoppmFor(job) !== null;
  const result: ParityResult = {
    kind: 'parity',
    started: new Date().toISOString(),
    finished: null,
    env: {
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      sandbox: !app.commandLine.hasSwitch('no-sandbox'),
      display: process.env.DISPLAY ?? null,
      proxyEnv: Object.keys(process.env).some((k) => /^(https?|all)_proxy$/i.test(k)),
    },
    tolerance: job.tolerance,
    gate: job.gate,
    pdfGate: job.pdfGate,
    dwellMs: job.dwellMs,
    pdftoppm,
    ...methodFacts(job, pdftoppm),
    diagnosis: { unseeded: job.seedRandom === false, noPdftoppm: job.pdftoppm === false },
    decks: [],
    histogram: new Array<number>(HISTOGRAM_BINS.length).fill(0),
  };
  const save = () => fs.writeFileSync(job.out, JSON.stringify(result, null, 1) + '\n');
  log(`randomness: ${result.determinism.randomness}`);
  log(`control: ${result.determinism.control}`);
  log(`overlay: ${result.method.overlay}`);
  for (const deck of job.decks) {
    for (const trust of job.trust) {
      try {
        result.decks.push(await withDeckTimeout(parityDeck(job, deck, trust, host, probeSrc, result.histogram), job.deckTimeoutMs, deck.label));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`${deck.label} (${trust}): ${msg}`);
        result.decks.push({
          label: deck.label,
          trustAsked: trust,
          trust,
          kind: '?',
          navKind: '?',
          slides: 0,
          designSize: { w: 0, h: 0 },
          indexComplete: false,
          indexMs: 0,
          charset: { blueline: '', plain: '' },
          missed: [],
          ...emptyTallies(),
          failures: 0,
          worstOver: 0,
          worstExact: 0,
          worstSlide: null,
          pass: false,
          results: [],
          ms: job.deckTimeoutMs,
          errors: [msg],
        });
      }
      save();
    }
  }
  result.finished = new Date().toISOString();
  save();
  return 0;
}

// ------------------------------------------------------------------------------------------- bench

/** The main-process share of an open (scripts/first-paint.mjs breakdown), timed with the app's own functions. */
async function runBench(job: BenchJob): Promise<number> {
  const now = () => performance.now();
  const runs: BenchRun[] = [];
  const real = fs.realpathSync(job.file);
  let bytesLen = 0;
  for (let k = 0; k < job.runs + 1; k++) {
    const t0 = now();
    const bytes = await readRegularFile(real);
    const t1 = now();
    const version = sha256Hex(bytes);
    const t2 = now();
    const decoded = decodeDeck(bytes);
    const t3 = now();
    const map = buildMap(decoded.src, { version, utf8: decoded.utf8 });
    const t4 = now();
    const copy = buildServedCopy(decoded.src, map, { protected: false });
    const t5 = now();
    const body = encodeDeck(copy);
    const t6 = now();
    bytesLen = bytes.length;
    void body;
    // End to end: loadDocument (read, hash, decode, map, trust), then the blueline:// handler's response for
    // the document (the served copy is built on that first request).
    const t7 = now();
    const doc = await loadDocument(job.file, { protectedRequested: false });
    const t8 = now();
    const resp = await handleDeckRequest({ url: deckUrl(doc.docId, doc.fileName), method: 'GET', headers: new Headers() }, (id) => (id === doc.docId ? doc : undefined));
    await resp.arrayBuffer();
    const t9 = now();
    doc.release();
    // The first run warms the JIT; it is not counted.
    if (k > 0) runs.push({ readMs: t1 - t0, hashMs: t2 - t1, decodeMs: t3 - t2, mapMs: t4 - t3, servedMs: t5 - t4, encodeMs: t6 - t5, loadDocumentMs: t8 - t7, protocolMs: t9 - t8 });
  }
  const keys = Object.keys(runs[0]) as (keyof BenchRun)[];
  const med = Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r[k]))])) as unknown as BenchRun;
  const out: BenchResult = { kind: 'bench', bytes: bytesLen, runs, median: med };
  fs.writeFileSync(job.out, JSON.stringify(out, null, 1) + '\n');
  return 0;
}
