// What scripts/parity.mjs and scripts/first-paint.mjs hand the harness's Electron main (harness/main.ts), and
// what it writes back. JSON both ways; the harness reads the job from the file named by --bl-parity-job and
// rewrites the result file after every deck, so an interrupted run keeps what it measured.

import type { PixelStats } from './compare';
import type { PageSize, SizeMismatch } from './pdf-pages';

export type TrustChoice = 'protected' | 'trusted';

export interface JobDeck {
  label: string;
  file: string;
  local: boolean;
  deckNav?: { forward: string; back: string };
}

export interface ParityJob {
  kind: 'parity';
  decks: JobDeck[];
  trust: TrustChoice[];
  /** Per-channel tolerance of the gate (0..255). */
  tolerance: number;
  /** Render parity gate: the largest share of pixels over tolerance a slide may have (0.005). */
  gate: number;
  /** PDF gate: the largest share a PDF page may have (0.01). */
  pdfGate: number;
  /** Also make the PDF (saveAsPdf) and compare its pages (raster pages with the walk's slide renders). */
  pdf: boolean;
  /** dist/preload-deck.cjs */
  preload: string;
  /** The bundled plain-window probe (harness/plain-probe.ts as an IIFE). */
  probeFile: string;
  /** Where PDFs, diff images and failing renders go. */
  workDir: string;
  /** The result file. */
  out: string;
  /** Most failing slides per deck whose renders are saved as PNG. */
  maxSaved: number;
  /** Save both renders of every slide, passing or not (to look at what was compared). */
  saveAll?: boolean;
  /**
   * The same seeded Math.random in every frame of every render the run makes (Blueline's render views, which
   * the index, the PDF and the parity walk use; the plain render, its control and the plain print), before any
   * page script, so a deck that draws random content draws the same in both (decision D-10). On unless false:
   * `--unseeded` turns it off for a diagnosis run (a deck's own Math.random variance), never for the gate.
   */
  seedRandom?: boolean;
  /**
   * False: compare printed pages as a machine without pdftoppm does (`--no-pdftoppm`; a Mac without poppler):
   * page counts and sizes only. Default: pdftoppm when the machine has it.
   */
  pdftoppm?: boolean;
  /**
   * How long both renders stay on a slide, at least, before the freeze and the capture (ms). Both renders
   * then show what a script reveals within that time (setTimeout builds, typewriters), whichever arrived first.
   */
  dwellMs: number;
  /** A deck that takes longer is abandoned (ms). */
  deckTimeoutMs: number;
}

export interface BenchJob {
  kind: 'bench';
  file: string;
  runs: number;
  out: string;
  workDir: string;
}

export type HarnessJob = ParityJob | BenchJob;

/** PixelStats without the size fields, as stored per slide. */
export type SlideStats = Pick<PixelStats, 'exact' | 'over' | 'exactShare' | 'overShare' | 'maxDelta' | 'histogram' | 'box'>;

export interface SlideParity {
  slide: number;
  /** How the plain render reached the slide ('reveal', 'keys', 'hash', 'heading', 'top'), or why it could not. */
  plainNav: string;
  /** Both renders show the same text (RenderView.visibleTextSignature in both). */
  sameText: boolean;
  /** How long each render had been on the slide when the freeze step ran (ms; job.dwellMs at least). */
  dwell: { blueline: number; plain: number };
  /** Two consecutive captures were identical, per side (6.7 step 3 plus the harness's stable-frame wait). */
  stable: { blueline: boolean; plain: boolean };
  /** Animations the freeze step finished (finite) or stopped at time 0 (infinite), per side. */
  frozen: { blueline: number; plain: number };
  scrollY: { blueline: number; plain: number };
  stats: SlideStats | null;
  /** Reached, and within the gate (compare.ts slideVerdict). */
  pass: boolean;
  /**
   * The control: the plain render against a second plain render of the same file, walked, settled, frozen and
   * captured the same way (the deck's own variance between two loads). Null when it could not be compared.
   */
  control: SlideStats | null;
  /** The control differs at all: listed per deck, the verdict unchanged (compare.ts slideVerdict). */
  nondeterministic: boolean;
  /** Diff image and both renders, when saved (paths relative to workDir). */
  saved?: { diff: string; blueline: string; plain: string };
  /** A nondeterministic slide's control render and its diff against the plain render, when saved. */
  savedControl?: { diff: string; control: string };
  /** PDF raster page against this slide's renders. */
  pdf?: { page: number; vsBlueline: SlideStats; vsPlain: SlideStats; pass: boolean } | { page: number; error: string; pass: false };
  notes: string[];
}

export interface PdfParity {
  mode: 'print-css' | 'raster' | 'document';
  pages: number;
  /** The page count the deck should give: slides (raster, print CSS) or the plain print of the original (document). */
  expectedPages: number;
  /** The plain window's printToPDF of the original file, with the same options (print CSS and documents). */
  plainPages: number | null;
  missed: number[];
  ms: number;
  pageCountOk: boolean;
  /** Each page's size in points: Blueline's PDF, and the plain print's (printToPDF pages; null for raster). */
  sizes: { blueline: PageSize[]; plain: PageSize[] | null };
  /** printToPDF pages: every page the size of the plain print's page (pdf-pages printedVerdict); null for raster. */
  sizesOk: boolean | null;
  sizeMismatches: SizeMismatch[];
  /** Per page: share over tolerance against its slide render (raster) or the plain print (printToPDF). */
  pageStats: { page: number; against: 'slide-render' | 'plain-print'; stats: SlideStats; pass: boolean }[];
  /** For printToPDF pages: against the slide's screen render (information; print CSS may lay out differently). */
  screenStats?: { page: number; stats: SlideStats }[];
  /** What was compared, in words: exactly the checks the verdict made (e.g. pixels not compared: no pdftoppm). */
  compared: string;
  pass: boolean;
  file: string;
}

export interface DeckParity {
  label: string;
  /** The trust state asked for, and the one the document opened in (a marker makes it Protected). */
  trustAsked: TrustChoice;
  trust: TrustChoice;
  kind: string;
  navKind: string;
  slides: number;
  designSize: { w: number; h: number };
  indexComplete: boolean;
  indexMs: number;
  /**
   * document.characterSet of both renders. Blueline serves a file that passes the UTF-8 check as
   * `charset=utf-8` (9.1 Charset); Chromium's file:// load of an undeclared file detects UTF-8 only from the
   * first 256 KiB and otherwise decodes it as windows-1252.
   */
  charset: { blueline: string; plain: string };
  /** Slides Blueline's walk could not show (6.7 navOk false): no comparison possible. */
  missed: number[];
  compared: number;
  /** Compared slides identical to the byte (no differing pixel at all): the exact count beside the tolerance. */
  identical: number;
  /** Slides whose control render differed (SlideParity.nondeterministic), judged like every other slide. */
  nondeterministic: number[];
  /** Slides whose visible-text signatures differ, and whose scroll positions differ: recorded, not the verdict. */
  textDiffers: number[];
  scrollDiffers: number[];
  failures: number;
  worstOver: number;
  worstExact: number;
  worstSlide: number | null;
  /**
   * Every slide compared, every slide reached (the walk's 9.4 detection on both sides), none over the gate,
   * no error. The overlay is checked by visitSlides once per walk, after the load (ParityResult.method).
   */
  pass: boolean;
  results: SlideParity[];
  pdf?: PdfParity | { error: string; pass: false };
  ms: number;
  errors: string[];
}

export interface ParityResult {
  kind: 'parity';
  started: string;
  finished: string | null;
  env: { electron: string; chrome: string; node: string; platform: string; arch: string; sandbox: boolean; display: string | null; proxyEnv: boolean };
  tolerance: number;
  gate: number;
  pdfGate: number;
  dwellMs: number;
  /** Printed pages were rasterised and compared (pdftoppm found, and not turned off by --no-pdftoppm). */
  pdftoppm: boolean;
  /** What both renders were given so that only Blueline can make them differ (decision D-10). */
  determinism: {
    /** Every frame of every render had the same seeded Math.random before any page script. */
    seededRandom: boolean;
    /** In words: the seed, where it is installed, and what is left alone (Date, performance.now, crypto). */
    randomness: string;
    /** In words: the control render and how its result is used. */
    control: string;
  };
  /** What the checks verify, in words, for docs/PHASE1-RESULTS.md's Method (finding 39). */
  method: { overlay: string; sameSlide: string; tolerance: string; pdf: string };
  /** Diagnosis options the run used (none for a gate run). */
  diagnosis: { unseeded: boolean; noPdftoppm: boolean };
  decks: DeckParity[];
  /** Over every compared slide: differing pixels by their largest channel difference (compare.ts HISTOGRAM_BINS). */
  histogram: number[];
}

export interface BenchRun {
  readMs: number;
  hashMs: number;
  decodeMs: number;
  mapMs: number;
  servedMs: number;
  encodeMs: number;
  /** loadDocument end to end (read, hash, decode, map, trust), then the protocol handler's response (served copy). */
  loadDocumentMs: number;
  protocolMs: number;
}

export interface BenchResult {
  kind: 'bench';
  bytes: number;
  runs: BenchRun[];
  median: BenchRun;
}
