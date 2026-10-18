// Pixel comparison for the Phase 1 exit gate (SPEC 10 Phase 1, Render parity and PDF; 11 Render parity and
// PDF). Pure functions over raw bitmaps, so the unit tests run them without Electron:
//
// - comparePixels: how many pixels differ at all (exact) and by more than a per-channel tolerance, plus a
//   histogram of the largest channel difference of every differing pixel (the evidence for the tolerance
//   docs/PHASE1-RESULTS.md states), the largest difference, and the box around the pixels over tolerance.
// - diffImage: the diff picture written next to a failing slide: red where a pixel is over tolerance, amber
//   where it differs within tolerance, the first render in light grey everywhere else.
// - slideVerdict and deckTallies: how a slide is judged, and what a deck's result lists beside the verdict
//   (identical slides, nondeterministic ones, slides whose text or scroll position differ).
//
// Bitmaps are nativeImage.toBitmap() output (BGRA on Linux and macOS x64/arm64, 4 bytes a pixel) or the RGB
// samples of a PDF image XObject (3 bytes a pixel). Both sides of one comparison share a layout.

/**
 * The gate's per-pixel rule: a pixel differs when some channel differs by more than this (0..255). 2 is
 * rounding noise (a colour-space conversion or a blend rounded the other way), nothing a person could see: on a
 * flat area a step of 3 to 4 levels is about one just-noticeable difference (CIEDE2000 ≈ 1). Two renders of the
 * same page by the same Chromium are byte-identical here, so the tolerance hides nothing that was measured; a
 * change that moves every pixel of Blueline's render by 3 levels or more fails (test/parity/fixtures/shift6.html,
 * shift8.html: a tolerance of 8 passed both). The share of pixels that differ at all is reported beside it.
 */
export const DEFAULT_TOLERANCE = 2;
/** SPEC 10 Phase 1: at most 0.5% of pixels different on every slide. */
export const RENDER_GATE = 0.005;
/** SPEC 10 Phase 1: each PDF page within 1% of its slide render. */
export const PDF_GATE = 0.01;

/** Upper bounds of the histogram bins of a differing pixel's largest channel difference. */
export const HISTOGRAM_BINS: readonly number[] = Object.freeze([2, 4, 8, 16, 32, 64, 128, 255]);

export interface PixelStats {
  width: number;
  height: number;
  pixels: number;
  tolerance: number;
  /** Pixels where any channel differs at all. */
  exact: number;
  /** Pixels where some channel differs by more than `tolerance` (the gate's count). */
  over: number;
  /** exact / pixels and over / pixels. */
  exactShare: number;
  overShare: number;
  /** The largest channel difference anywhere (0 when the bitmaps are equal). */
  maxDelta: number;
  /** Differing pixels by their largest channel difference, binned by HISTOGRAM_BINS (1–2, 3–4, 5–8, …). */
  histogram: number[];
  /** The box (bitmap pixels) around the pixels over tolerance, or null when there are none. */
  box: { x: number; y: number; w: number; h: number } | null;
}

export interface CompareOptions {
  /** Bytes a pixel: 4 (BGRA or RGBA, alpha compared too) or 3 (RGB). */
  channels: 3 | 4;
  tolerance?: number;
  /** When given (width × height bytes), set to 2 where a pixel is over tolerance, 1 where it differs within it. */
  mask?: Uint8Array;
}

function binOf(delta: number): number {
  for (let i = 0; i < HISTOGRAM_BINS.length; i++) if (delta <= HISTOGRAM_BINS[i]) return i;
  return HISTOGRAM_BINS.length - 1;
}

/** Compares two bitmaps of the same size and layout. Throws when their sizes do not match the dimensions. */
export function comparePixels(a: Uint8Array, b: Uint8Array, width: number, height: number, opts: CompareOptions): PixelStats {
  const ch = opts.channels;
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError('bad bitmap size');
  if (!Number.isInteger(tol) || tol < 0 || tol > 255) throw new RangeError('tolerance must be an integer 0..255');
  const pixels = width * height;
  if (a.length < pixels * ch || b.length < pixels * ch) throw new RangeError(`bitmaps hold fewer than ${pixels} pixels`);
  if (opts.mask && opts.mask.length < pixels) throw new RangeError('mask too small');
  const histogram = new Array<number>(HISTOGRAM_BINS.length).fill(0);
  let exact = 0;
  let over = 0;
  let maxDelta = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let p = 0, o = 0; p < pixels; p++, o += ch) {
    // Fast path: most pixels are equal.
    if (a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2] && (ch === 3 || a[o + 3] === b[o + 3])) continue;
    let d = 0;
    for (let k = 0; k < ch; k++) {
      const v = a[o + k] > b[o + k] ? a[o + k] - b[o + k] : b[o + k] - a[o + k];
      if (v > d) d = v;
    }
    exact++;
    histogram[binOf(d)]++;
    if (d > maxDelta) maxDelta = d;
    if (d > tol) {
      over++;
      const x = p % width;
      const y = (p - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (opts.mask) opts.mask[p] = 2;
    } else if (opts.mask) opts.mask[p] = 1;
  }
  return {
    width,
    height,
    pixels,
    tolerance: tol,
    exact,
    over,
    exactShare: exact / pixels,
    overShare: over / pixels,
    maxDelta,
    histogram,
    box: x1 >= 0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null,
  };
}

/** True when two bitmaps hold the same bytes (a stable frame: two consecutive captures identical). */
export function sameBitmap(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

/**
 * The diff picture as a BGRA bitmap (nativeImage.createFromBitmap): red where `mask` is 2 (over tolerance),
 * amber where it is 1 (differs within tolerance), and `base` (BGRA) washed out to light grey elsewhere, so
 * the slide's layout stays readable around the marks.
 */
export function diffImage(base: Uint8Array, mask: Uint8Array, width: number, height: number): Buffer {
  const pixels = width * height;
  const out = Buffer.alloc(pixels * 4);
  for (let p = 0, o = 0; p < pixels; p++, o += 4) {
    const m = mask[p];
    if (m === 2) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 255;
    } else if (m === 1) {
      out[o] = 0;
      out[o + 1] = 170;
      out[o + 2] = 255;
    } else {
      const lum = (base[o] * 29 + base[o + 1] * 150 + base[o + 2] * 77) >> 8;
      const g = 170 + ((lum * 85) >> 8);
      out[o] = g;
      out[o + 1] = g;
      out[o + 2] = g;
    }
    out[o + 3] = 255;
  }
  return out;
}

/** The share as a percentage with 3 decimals ("0.012%"), for tables. */
export function pct(share: number): string {
  return `${(share * 100).toFixed(3)}%`;
}

/** Sums histograms (several slides, several decks). */
export function addHistograms(into: number[], h: readonly number[]): number[] {
  for (let i = 0; i < h.length; i++) into[i] = (into[i] ?? 0) + h[i];
  return into;
}

/**
 * One slide's verdict (SPEC 10 Phase 1: "at most 0.5% of pixels different"). It passes when the plain render
 * reached the slide and the share of pixels over tolerance is within the gate. It is nondeterministic when
 * the control render (a second plain render of the same file, walked and settled the same way) differs from
 * the plain render at all: the deck draws differently on two loads with the same seeded Math.random (a clock,
 * crypto.getRandomValues, a race). The verdict does not change for it: a nondeterministic slide over the gate
 * fails, and one within it passes and is listed as nondeterministic beside the verdict, never silently.
 */
export function slideVerdict(
  r: { navOk: boolean; stats: Pick<PixelStats, 'overShare'> | null; control: Pick<PixelStats, 'exact'> | null },
  gate: number,
): { pass: boolean; nondeterministic: boolean } {
  return { pass: r.navOk && r.stats !== null && r.stats.overShare <= gate, nondeterministic: r.control !== null && r.control.exact > 0 };
}

/** What a deck's result lists beside its verdict, each list in slide order (0-based slides). */
export interface DeckTallies {
  /** Slides compared (both captures the same size). */
  compared: number;
  /** Compared slides with no differing pixel at all: the exact count reported next to the tolerance. */
  identical: number;
  /** Slides whose control render differed from the plain render (slideVerdict). */
  nondeterministic: number[];
  /** Slides whose visible-text signatures differ between the two renders (recorded, not part of the verdict). */
  textDiffers: number[];
  /** Slides whose scroll positions differ between the two renders (recorded, not part of the verdict). */
  scrollDiffers: number[];
}

export function deckTallies(
  results: readonly {
    slide: number;
    stats: Pick<PixelStats, 'exact'> | null;
    nondeterministic: boolean;
    sameText: boolean;
    scrollY: { blueline: number; plain: number };
  }[],
): DeckTallies {
  const rs = [...results].sort((a, b) => a.slide - b.slide);
  return {
    compared: rs.filter((r) => r.stats).length,
    identical: rs.filter((r) => r.stats && r.stats.exact === 0).length,
    nondeterministic: rs.filter((r) => r.nondeterministic).map((r) => r.slide),
    textDiffers: rs.filter((r) => !r.sameText).map((r) => r.slide),
    scrollDiffers: rs.filter((r) => r.scrollY.blueline !== r.scrollY.plain).map((r) => r.slide),
  };
}

/** Median of a list of numbers (NaN when empty). */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
