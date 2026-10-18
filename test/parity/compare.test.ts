// The exit gate's pixel comparison (SPEC 10 Phase 1 Render parity and PDF; harness/compare.ts).
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOLERANCE, HISTOGRAM_BINS, PDF_GATE, RENDER_GATE, addHistograms, comparePixels, deckTallies, diffImage, median, pct, sameBitmap, slideVerdict } from './harness/compare';

function bgra(width: number, height: number, fill: [number, number, number, number]): Uint8Array {
  const b = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) b.set(fill, p * 4);
  return b;
}

describe('comparePixels', () => {
  it('finds nothing in equal bitmaps', () => {
    const a = bgra(10, 10, [10, 20, 30, 255]);
    const s = comparePixels(a, a.slice(), 10, 10, { channels: 4 });
    expect(s).toMatchObject({ pixels: 100, exact: 0, over: 0, exactShare: 0, overShare: 0, maxDelta: 0, box: null, tolerance: DEFAULT_TOLERANCE });
    expect(s.histogram).toEqual(new Array(HISTOGRAM_BINS.length).fill(0));
  });

  it('counts a pixel within tolerance as exact-different only, and one beyond it as over', () => {
    const a = bgra(4, 2, [100, 100, 100, 255]);
    const b = a.slice();
    b[0] = 108; // pixel 0: Δ 8 = the tolerance, not over
    b[5 * 4 + 2] = 91; // pixel 5 (x 1, y 1): Δ 9, over
    const s = comparePixels(a, b, 4, 2, { channels: 4, tolerance: 8 });
    expect(s.exact).toBe(2);
    expect(s.over).toBe(1);
    expect(s.overShare).toBeCloseTo(1 / 8);
    expect(s.maxDelta).toBe(9);
    expect(s.box).toEqual({ x: 1, y: 1, w: 1, h: 1 });
    // Δ 8 falls in the 5–8 bin, Δ 9 in 9–16.
    expect(s.histogram[2]).toBe(1);
    expect(s.histogram[3]).toBe(1);
  });

  it('the default tolerance is 2 levels: rounding noise passes, a step of 3 is over', () => {
    expect(DEFAULT_TOLERANCE).toBe(2);
    const a = bgra(3, 1, [100, 100, 100, 255]);
    const b = a.slice();
    b[0] = 101; // Δ 1
    b[4 + 1] = 102; // Δ 2
    b[8 + 2] = 97; // Δ 3
    const s = comparePixels(a, b, 3, 1, { channels: 4 });
    expect(s).toMatchObject({ exact: 3, over: 1, maxDelta: 3, box: { x: 2, y: 0, w: 1, h: 1 } });
  });

  // Review finding 38: a change on Blueline's side that moves every pixel by a few levels (a colour-managed
  // path on one side) passed at the old tolerance of 8 with 0% over it (test/parity/fixtures/shift6.html, shift8.html).
  it.each([3, 6, 8])('a uniform shift of %i levels on every channel puts every pixel over the default tolerance', (shift) => {
    const w = 64;
    const h = 36;
    const a = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) a.set([(p * 7) % 200, (p * 3) % 200, (p * 5) % 200, 255], p * 4);
    const b = a.map((v, k) => (k % 4 === 3 ? v : v + shift));
    const s = comparePixels(a, b, w, h, { channels: 4 });
    expect(s.over).toBe(w * h);
    expect(s.overShare > RENDER_GATE).toBe(true);
  });

  it('takes the largest channel difference of a pixel, alpha included for 4 channels', () => {
    const a = bgra(1, 1, [0, 0, 0, 255]);
    const b = bgra(1, 1, [3, 0, 0, 200]);
    expect(comparePixels(a, b, 1, 1, { channels: 4 }).maxDelta).toBe(55);
    expect(comparePixels(a, b, 1, 1, { channels: 4, tolerance: 60 }).over).toBe(0);
  });

  it('compares RGB samples (3 channels)', () => {
    const a = new Uint8Array([0, 0, 0, 255, 255, 255]);
    const b = new Uint8Array([0, 0, 0, 255, 0, 255]);
    const s = comparePixels(a, b, 2, 1, { channels: 3 });
    expect(s).toMatchObject({ exact: 1, over: 1, maxDelta: 255, box: { x: 1, y: 0, w: 1, h: 1 } });
    expect(s.histogram[HISTOGRAM_BINS.length - 1]).toBe(1);
  });

  it('boxes every pixel over tolerance', () => {
    const a = bgra(10, 10, [0, 0, 0, 255]);
    const b = a.slice();
    for (const [x, y] of [
      [2, 3],
      [7, 1],
      [5, 8],
    ]) b[(y * 10 + x) * 4] = 200;
    expect(comparePixels(a, b, 10, 10, { channels: 4 }).box).toEqual({ x: 2, y: 1, w: 6, h: 8 });
  });

  it('fills the mask: 2 over tolerance, 1 within', () => {
    const a = bgra(3, 1, [50, 50, 50, 255]);
    const b = a.slice();
    b[4] = 52;
    b[8] = 250;
    const mask = new Uint8Array(3);
    comparePixels(a, b, 3, 1, { channels: 4, mask });
    expect([...mask]).toEqual([0, 1, 2]);
  });

  it('refuses short bitmaps and bad tolerances', () => {
    expect(() => comparePixels(new Uint8Array(10), new Uint8Array(16), 2, 2, { channels: 4 })).toThrow(RangeError);
    expect(() => comparePixels(new Uint8Array(16), new Uint8Array(16), 2, 2, { channels: 4, tolerance: 256 })).toThrow(RangeError);
    expect(() => comparePixels(new Uint8Array(16), new Uint8Array(16), 0, 2, { channels: 4 })).toThrow(RangeError);
  });

  it('a 3200×1800 slide with 0.5% of its pixels changed is exactly at the gate', () => {
    const w = 3200;
    const h = 1800;
    const a = bgra(w, h, [255, 255, 255, 255]);
    const b = a.slice();
    const n = (w * h * RENDER_GATE) | 0;
    for (let p = 0; p < n; p++) b[p * 4 + 1] = 0;
    const s = comparePixels(a, b, w, h, { channels: 4 });
    expect(s.over).toBe(n);
    expect(s.overShare <= RENDER_GATE).toBe(true);
    b[n * 4 + 1] = 0;
    expect(comparePixels(a, b, w, h, { channels: 4 }).overShare > RENDER_GATE).toBe(true);
  });
});

describe('slideVerdict and deckTallies', () => {
  const stats = (exact: number, overShare: number) => ({ exact, overShare });

  it('a slide passes when it was reached and is within the gate', () => {
    expect(slideVerdict({ navOk: true, stats: stats(10, RENDER_GATE), control: stats(0, 0) }, RENDER_GATE)).toEqual({ pass: true, nondeterministic: false });
    expect(slideVerdict({ navOk: true, stats: stats(10, RENDER_GATE + 1e-6), control: stats(0, 0) }, RENDER_GATE).pass).toBe(false);
    expect(slideVerdict({ navOk: false, stats: stats(0, 0), control: stats(0, 0) }, RENDER_GATE).pass).toBe(false);
    expect(slideVerdict({ navOk: true, stats: null, control: null }, RENDER_GATE).pass).toBe(false);
  });

  // Review finding 38 (decision D-10): a slide whose control render differs is listed, never silently passed,
  // and its verdict is the gate's: over the gate it fails, the control does not excuse it.
  it('a slide whose control differs at all is nondeterministic, and judged like any other', () => {
    expect(slideVerdict({ navOk: true, stats: stats(500, 0.16), control: stats(1, 0) }, RENDER_GATE)).toEqual({ pass: false, nondeterministic: true });
    expect(slideVerdict({ navOk: true, stats: stats(5, 0), control: stats(5, 0.16) }, RENDER_GATE)).toEqual({ pass: true, nondeterministic: true });
    // No control to compare: not called nondeterministic (the slide's notes say why).
    expect(slideVerdict({ navOk: true, stats: stats(0, 0), control: null }, RENDER_GATE)).toEqual({ pass: true, nondeterministic: false });
  });

  // Review finding 39: what a deck's result lists beside its verdict (the full gate records text and scroll
  // differences and does not judge on them).
  it('lists identical, nondeterministic, text and scroll differences in slide order', () => {
    const r = (slide: number, exact: number | null, more: Partial<{ nondeterministic: boolean; sameText: boolean; scrollY: { blueline: number; plain: number } }> = {}) => ({
      slide,
      stats: exact === null ? null : { exact },
      nondeterministic: false,
      sameText: true,
      scrollY: { blueline: 0, plain: 0 },
      ...more,
    });
    const t = deckTallies([r(3, 0), r(0, 0), r(2, 120, { nondeterministic: true, sameText: false }), r(1, null, { sameText: false }), r(4, 7, { scrollY: { blueline: 900, plain: 0 } })]);
    expect(t).toEqual({ compared: 4, identical: 2, nondeterministic: [2], textDiffers: [1, 2], scrollDiffers: [4] });
  });
});

describe('the rest', () => {
  it('sameBitmap compares bytes', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(sameBitmap(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(sameBitmap(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(sameBitmap(a, new Uint8Array([1, 2]))).toBe(false);
    expect(sameBitmap(null, a)).toBe(false);
  });

  it('diffImage: red over tolerance, amber within, washed-out grey elsewhere, opaque', () => {
    const base = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
    const out = diffImage(base, new Uint8Array([2, 1, 0]), 3, 1);
    expect([...out.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
    expect([...out.subarray(4, 8)]).toEqual([0, 170, 255, 255]);
    // Black washes out to 170: still lighter than any mark, darker than white.
    expect([...out.subarray(8, 12)]).toEqual([170, 170, 170, 255]);
  });

  it('gates are SPEC 10 Phase 1: 0.5% per slide, 1% per PDF page', () => {
    expect(RENDER_GATE).toBe(0.005);
    expect(PDF_GATE).toBe(0.01);
  });

  it('pct, median, addHistograms', () => {
    expect(pct(0.00123)).toBe('0.123%');
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    expect(addHistograms([1, 2], [3, 4])).toEqual([4, 6]);
  });
});
