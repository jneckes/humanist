// The exit-gate harness: an Electron main of its own (bundled by harness/bundle.mjs), started by
// scripts/parity.mjs and scripts/first-paint.mjs with --bl-parity-job=<job.json>. It measures SPEC 10 Phase 1's
// exit gate on this machine:
//
// Render parity (SPEC 10 Phase 1; 11 Render parity and PDF). For every slide of a deck, at the 6.9 design size
// and 2x, two renders in the same Electron:
//   (a) Blueline's: the render service exactly as the render products use it (render-service rendererFor and
//       slide-index visitSlides): the document opened by documents.ts loadDocument in its own trust state and
//       partition, with the session policy and the blueline:// handler a document window installs (9.1, 9.9),
//       the served stamped copy, the deck preload in render mode (no overlay: checked before every render),
//       reduced motion (Josh's decision 1: background renders);
//   (b) the plain render of the original file (plain-view.ts): file://, no preload, no protocol, a partition of
//       its own, the same viewport, scale, reduced motion, navigation and settle steps.
// Both then get the freeze step (plain-view FREEZE_JS) and a stable-frame wait (two consecutive captures
// identical, up to 3 s), and the bitmaps (nativeImage.toBitmap) are compared pixel by pixel (compare.ts): the
// share that differs at all, and the share over the per-channel tolerance, which is the gate (0.5%).
//
// PDF (SPEC 10 Phase 1: "the right page count, and each page within 1% of its slide render"): saveAsPdf (pdf.ts)
// as Save as PDF runs it. Raster pages' images are read back from the PDF (pdf-pages.ts) and compared with the
// slide renders of the same walk; printToPDF pages (print CSS, documents) are compared with the plain window's
// printToPDF of the original with the same options, page count and (with pdftoppm) pixels.
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
import { disposeRenderer, rendererFor, renderTargetFor, type RenderHost, type RenderView, type RenderTarget } from '../../../packages/app/src/main/render-service';
import { INDEX_VIEWPORT, buildSlideIndex, designViewport, replayKeys, visitSlides } from '../../../packages/app/src/main/slide-index';
import { installDeckSessionPolicy, type DeckSessionHandle } from '../../../packages/app/src/main/trust-hooks';
import { HISTOGRAM_BINS, addHistograms, comparePixels, diffImage, median, sameBitmap, type PixelStats } from './compare';
import { redactor } from './decks';
import type { BenchJob, BenchResult, BenchRun, DeckParity, HarnessJob, ParityJob, ParityResult, PdfParity, SlideParity, SlideStats, TrustChoice } from './job';
import { decodePageImage, findPdftoppm, pdfPages, rasterisePage, type PdfPages } from './pdf-pages';
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

const seeded = new WeakSet<RenderView>();

/** --seed-random: the seeded Math.random on a render view of the pool, once (it lasts across its loads). */
async function seedView(view: RenderView): Promise<void> {
  if (seeded.has(view)) return;
  await addInitScript(view.wc, SEEDED_RANDOM_JS);
  seeded.add(view);
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
    pageStats: [],
    compared: '',
    pass: false,
    file: path.relative(job.workDir, file),
  };
  return { result, pages, pageOf, bytes };
}

/**
 * printToPDF decks and documents: the plain window prints the original file with Blueline's options, and each
 * page of both PDFs is rasterised by pdftoppm at the same size (the page in CSS px at 2x) and compared.
 */
async function comparePrinted(job: ParityJob, deck: { label: string; file: string }, trust: TrustChoice, state: PdfState): Promise<void> {
  const r = state.result;
  const plain = new PlainView(deck.file, { ...INDEX_VIEWPORT }, `parity-print-${Date.now()}-${Math.random().toString(16).slice(2)}`, '', replayKeys(null), log, {
    seedRandom: job.seedRandom === true,
  });
  let plainFile: string;
  try {
    // pdf.ts printedPdf: the deck loaded at 1600×900, settled, printed.
    await plain.loadPlain();
    const opts: Electron.PrintToPDFOptions = r.mode === 'document' ? { printBackground: true, pageSize: documentPageSize(null) } : { preferCSSPageSize: true, printBackground: true };
    const bytes = await plain.printToPDF(opts);
    plainFile = path.join(job.workDir, 'pdf', `${safeName(deck.label)}-${trust}-plain.pdf`);
    fs.writeFileSync(plainFile, bytes);
    r.plainPages = (await pdfPages(bytes)).pageCount;
  } finally {
    plain.close();
  }
  if (r.mode === 'document') r.expectedPages = r.plainPages;
  r.pageCountOk = r.pages === r.expectedPages && r.pages === r.plainPages;
  if (!findPdftoppm()) {
    r.compared = 'page count and page sizes only: pdftoppm is not installed, so printed pages were not rasterised';
    r.pass = r.pageCountOk;
    return;
  }
  const blFile = path.join(job.workDir, state.result.file);
  const tmp = path.join(job.workDir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  let saved = 0;
  for (let k = 0; k < Math.min(r.pages, r.plainPages ?? 0); k++) {
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
  r.compared = `page count against ${r.mode === 'document' ? 'the plain print of the original' : 'the slide count and the plain print of the original'}; every page rasterised by pdftoppm at 2x and compared with the plain print's page`;
  r.pass = r.pageCountOk && r.pageStats.length === r.pages && r.pageStats.every((p) => p.pass);
}

// ------------------------------------------------------------------------------------------- one deck

let plainSeq = 0;

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
    compared: 0,
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
    // --seed-random: the pool's 1600×900 view (the index walk, printed PDFs) gets the seeded Math.random first.
    if (job.seedRandom) await rendererFor(target, host).use(INDEX_VIEWPORT, seedView);
    const ti = Date.now();
    const index = await buildSlideIndex(target, { host, force: true });
    res.indexMs = Date.now() - ti;
    res.kind = index.kind;
    res.navKind = index.navKind;
    res.slides = index.slides.length;
    res.designSize = { ...index.designSize };
    res.indexComplete = index.complete;
    log(`${deck.label} (${res.trust}): ${index.kind}, ${index.slides.length} slides, design ${index.designSize.w}×${index.designSize.h}, index ${res.indexMs} ms`);

    // ... and the design-size view (raster PDF pages, the parity walk).
    if (job.seedRandom) await rendererFor(target, host).use(designViewport(index), seedView);
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
    plain = new PlainView(deck.file, vp, `parity-plain-${process.pid}-${++plainSeq}`, probeSrc, keys, log, {
      seedRandom: job.seedRandom === true,
    });
    await plain.load();
    res.charset.plain = await charsetOf(plain.wc);
    // --self-check: a second plain render, walked the same way, for the deck's own variance between loads.
    if (job.selfCheck) {
      plain2 = new PlainView(deck.file, vp, `parity-plain-${process.pid}-${++plainSeq}`, probeSrc, keys, log, { seedRandom: job.seedRandom === true });
      await plain2.load();
    }
    const pv2 = plain2;
    const pv = plain;
    let saved = 0;
    let pdfSaved = 0;
    const screenStats: { page: number; stats: SlideStats }[] = [];
    const tmp = path.join(job.workDir, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const walk = await rendererFor(target, host).use(vp, async (view) => {
      // The view may be new (an idle view is closed after 20 s): seeded again before visitSlides loads it.
      if (job.seedRandom) await seedView(view);
      return visitSlides(
        view,
        target,
        index,
        async (i) => {
          const r: SlideParity = { slide: i, plainNav: '', sameText: false, dwell: { blueline: 0, plain: 0 }, stable: { blueline: false, plain: false }, frozen: { blueline: 0, plain: 0 }, scrollY: { blueline: 0, plain: 0 }, stats: null, pass: false, notes: [] };
          res.results.push(r);
          if (!res.charset.blueline) res.charset.blueline = await charsetOf(view.wc);
          // Blueline's render arrived and settled when visitSlides called here; the plain render arrives below.
          const arrivedB = Date.now();
          try {
            const nav = await pv.goTo(i, index);
            r.plainNav = nav.how;
            if (!nav.ok) r.notes.push('the plain render could not be brought to this slide');
            // 6.7 step 3 for the plain render, as visitSlides did for Blueline's before calling here.
            await pv.probe.waitStable();
            await pv.probe.pauseAnimations();
            // The dwell: both renders stay on the slide at least job.dwellMs before the freeze and the capture.
            // Blueline's arrived first (the plain render is navigated from here), so without it a reveal timed
            // by script (setTimeout, a typewriter) would be further along in Blueline's capture than in the
            // plain one. Blueline's dwell is the longer of the two by the plain render's navigation time.
            const arrivedP = Date.now();
            // (A timer may fire a millisecond early on the wall clock: loop until the dwell has really passed.)
            while (Date.now() < arrivedP + job.dwellMs) await sleep(arrivedP + job.dwellMs - Date.now());
            r.dwell = { blueline: Date.now() - arrivedB, plain: Date.now() - arrivedP };
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
                r.pass = nav.ok && s.overShare <= job.gate;
                if ((!r.pass && saved < job.maxSaved) || job.saveAll) {
                  if (!r.pass) saved++;
                  const base = path.join('diff', safeName(deck.label), `${res.trust}-slide-${String(i + 1).padStart(2, '0')}`);
                  writeDiff(path.join(job.workDir, `${base}-diff.png`), a.bitmap, b.bitmap, a.width, a.height, 4, job.tolerance);
                  writePng(path.join(job.workDir, `${base}-blueline.png`), a.image);
                  writePng(path.join(job.workDir, `${base}-plain.png`), b.image);
                  r.saved = { diff: `${base}-diff.png`, blueline: `${base}-blueline.png`, plain: `${base}-plain.png` };
                }
              }
              if (pv2) {
                const n2 = await pv2.goTo(i, index);
                await pv2.probe.waitStable();
                await pv2.probe.pauseAnimations();
                const arrived2 = Date.now();
                while (Date.now() < arrived2 + job.dwellMs) await sleep(arrived2 + job.dwellMs - Date.now());
                try {
                  await freezeAnimations(pv2.wc);
                  const c = await stableShot(pv2.probe);
                  r.self = n2.ok && c.width === b.width && c.height === b.height ? slim(comparePixels(b.bitmap, c.bitmap, b.width, b.height, { channels: 4, tolerance: job.tolerance })) : null;
                } finally {
                  await pv2.probe.resumeAnimations();
                }
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
                  } else if (pdf.result.mode === 'print-css' && findPdftoppm()) {
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
          log(`${deck.label} slide ${i + 1}/${index.slides.length}: ${s ? `${(s.overShare * 100).toFixed(3)}% over tol, ${(s.exactShare * 100).toFixed(3)}% exact-diff, max Δ ${s.maxDelta}` : 'not compared'}${r.plainNav ? ` [${r.plainNav}]` : ''}${r.sameText ? '' : ' (text differs)'}${r.self ? ` self ${(r.self.overShare * 100).toFixed(3)}%` : ''}${r.pdf ? ` pdf ${'error' in r.pdf ? r.pdf.error : `${(r.pdf.vsBlueline.overShare * 100).toFixed(3)}%`}` : ''}`);
        },
        { log },
      );
    });
    res.missed = walk.missed;
    if (pdf) {
      if (pdf.result.mode === 'raster') {
        pdf.result.compared = "page count against the slide count; each page's image XObject decoded from the PDF and compared with Blueline's render of its slide (and, for information, the plain render)";
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
  res.compared = res.results.filter((r) => r.stats).length;
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
    pdftoppm: findPdftoppm() !== null,
    diagnosis: { seedRandom: job.seedRandom === true, selfCheck: job.selfCheck === true },
    decks: [],
    histogram: new Array<number>(HISTOGRAM_BINS.length).fill(0),
  };
  const save = () => fs.writeFileSync(job.out, JSON.stringify(result, null, 1) + '\n');
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
          compared: 0,
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
