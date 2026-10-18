// Render parity and PDF on committed fixtures (SPEC 10 Phase 1 exit gate; 11: "Render parity and PDF. As in the
// Phase 1 exit gate, run nightly on the committed fixtures"). Runs scripts/parity.mjs as a person would, on three
// fixtures that cover the three ways the render service shows a slide (generic keys, reveal.js, a scrolling
// document) and two PDF modes (raster, document), plus:
// - a negative control whose first slide differs between any two loads (crypto.getRandomValues, which the
//   harness does not seed): the harness must fail that slide, list it as nondeterministic (its control render
//   differs too), and pass the other two, or it is not looking;
// - the seeded Math.random (decision D-10): a deck that draws with Math.random renders identically in Blueline's
//   render, the plain render and the control, and in its PDF;
// - the delayed-build repro (docs/PHASE1-RESULTS.md, PDF): a raster PDF page must show what a script reveals
//   400 ms after the slide arrives (visitSlides waits for it: RenderView.waitScripted, slide-index.ts
//   SCRIPTED_SETTLE). It was an expected failure until that wait was added;
// - negative controls of the gate itself (review findings 37 to 39): every colour of Blueline's render shifted by
//   6 and by 8 levels (the tolerance of 2 must fail them; 8 passed them), a slide whose visible text differs
//   (recorded and listed, not judged), and a print-CSS deck whose plain print has pages of another size (the PDF
//   check must fail on the sizes, with pdftoppm and without it).
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DeckParity, ParityResult, PdfParity } from './harness/job';

const ROOT = path.resolve(__dirname, '../..');
const DECKS = ['decks/generic-index.html', 'decks/reveal-hash/index.html', 'decks/report.html'];
const CONTROL = 'test/parity/fixtures/nondeterministic.html';
const DELAYED = 'test/parity/fixtures/delayed-build.html';
const SEEDED = 'test/parity/fixtures/seeded-random.html';
const SHIFTS: [string, number][] = [
  ['test/parity/fixtures/shift6.html', 6],
  ['test/parity/fixtures/shift8.html', 8],
];
const TEXT = 'test/parity/fixtures/text-differs.html';
const PAGE_SIZE = 'test/parity/fixtures/page-size-diverge.html';

/** A parity.mjs run of up to 25 minutes (the committed fixtures with their control renders take about 8). */
const RUN_MS = 1_500_000;

interface Run {
  res: ParityResult;
  log: string;
  status: number | null;
}

function runParity(dir: string, name: string, decks: string[], extra: string[]): Run {
  const out = path.join(dir, `${name}.json`);
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/parity.mjs'), '--decks', decks.join(','), '--trust', 'protected', ...extra, '--out', out, '--work', path.join(dir, `work-${name}`)],
    { cwd: ROOT, encoding: 'utf8', timeout: RUN_MS, env: process.env },
  );
  const log = `${r.stdout}\n${r.stderr}`;
  if (!fs.existsSync(out)) throw new Error(`parity.mjs wrote no result (status ${r.status}):\n${log}`);
  return { res: JSON.parse(fs.readFileSync(out, 'utf8')) as ParityResult, log, status: r.status };
}

function deckOf(res: ParityResult, label: string): DeckParity {
  const d = res.decks.find((x) => x.label === label);
  if (!d) throw new Error(`${label} is not in the result`);
  return d;
}

function pdfOf(d: DeckParity): PdfParity {
  const pdf = d.pdf;
  if (!pdf || 'error' in pdf) throw new Error(`${d.label}: ${JSON.stringify(pdf)}`);
  return pdf;
}

test.describe.serial('exit gate on committed fixtures', () => {
  let dir = '';
  let run: Run;

  test.beforeAll(() => {
    test.setTimeout(RUN_MS + 60_000);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-parity-'));
    run = runParity(dir, 'gate', [...DECKS, CONTROL, DELAYED, SEEDED], ['--pdf']);
  });

  test.afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Blueline renders every slide as plain Electron does, and its PDFs match (3 committed fixtures)', () => {
    const { res, log, status } = run;
    // 1: a gate failed (the control); 0 would mean the control passed, 2 a harness error.
    expect(status, log).toBe(1);
    expect(res.env.electron).toBe('44.7.2');
    expect(res.env.proxyEnv).toBe(false);
    expect(res.tolerance).toBe(2);
    expect(res.gate).toBe(0.005);
    expect(res.dwellMs).toBe(2000);

    for (const label of DECKS) {
      const d = deckOf(res, label);
      expect(d.errors, label).toEqual([]);
      expect(d.slides, label).toBeGreaterThan(0);
      expect(d.indexComplete, label).toBe(true);
      expect(d.missed, label).toEqual([]);
      expect(d.compared, label).toBe(d.slides);
      expect(d.charset.blueline, label).toBe(d.charset.plain);
      // Asserted here for these fixtures only; the full gate records and lists them (finding 39).
      expect(d.textDiffers, label).toEqual([]);
      expect(d.scrollDiffers, label).toEqual([]);
      // reveal.js's controls tutorial bounces the right arrow (bottom right corner) on every slide a programmatic
      // walk shows; in 2 of about 25 runs here the control render's arrow was caught in another place than the
      // plain render's (a few hundred pixels): the control lists that slide as nondeterministic, as it should,
      // and the slide is judged on Blueline's render against the plain one as usual. The other two never vary.
      if (label !== 'decks/reveal-hash/index.html') expect(d.nondeterministic, label).toEqual([]);
      expect(d.identical, label).toBeLessThanOrEqual(d.compared);
      for (const s of d.results) {
        const at = `${label} slide ${s.slide + 1}`;
        // The plain render reached the same slide and shows the same text, both frames were stable, and the
        // control render matched the plain render.
        expect(s.notes, at).toEqual([]);
        expect(s.sameText, at).toBe(true);
        expect(s.stable, at).toEqual({ blueline: true, plain: true });
        expect(s.scrollY.blueline, at).toBe(s.scrollY.plain);
        expect(s.dwell.plain, at).toBeGreaterThanOrEqual(res.dwellMs);
        expect(s.dwell.blueline, at).toBeGreaterThanOrEqual(s.dwell.plain);
        expect(s.stats!.overShare, at).toBeLessThanOrEqual(res.gate);
        // The control render was compared on every slide, and a slide is nondeterministic exactly when it differs.
        expect(s.control, at).not.toBeNull();
        expect(s.nondeterministic, at).toBe(s.control!.exact > 0);
        expect(s.control!.overShare, at).toBeLessThanOrEqual(res.gate);
      }
      expect(d.pass, label).toBe(true);
      const pdf = pdfOf(d);
      expect(pdf.pageCountOk, label).toBe(true);
      expect(pdf.pass, `${label}: ${pdf.compared}`).toBe(true);
      expect(pdf.mode, label).toBe(d.kind === 'scroll' || d.kind === 'single' ? 'document' : 'raster');
      if (pdf.mode === 'raster') expect(pdf.pages, label).toBe(d.slides);
      else {
        expect(pdf.pages, label).toBe(pdf.plainPages);
        expect(pdf.sizesOk, label).toBe(true);
      }
    }

    // The control: slide 1 differs (the random box, 16% of the slide) and its control render differs too, so it
    // fails and is listed as nondeterministic; slides 2 and 3 match exactly.
    const c = deckOf(res, CONTROL);
    expect(c.kind).toBe('generic');
    expect(c.pass).toBe(false);
    expect(c.results.map((s) => s.pass)).toEqual([false, true, true]);
    expect(c.results[0].stats!.overShare).toBeGreaterThan(0.1);
    expect(c.results[0].nondeterministic).toBe(true);
    expect(c.nondeterministic).toEqual([0]);
    expect(c.results[1].stats!.exact).toBe(0);
    expect(c.results[2].stats!.exact).toBe(0);
    expect(c.identical).toBe(2);
    expect(c.results[0].saved?.diff).toBeTruthy();
    expect(fs.existsSync(path.join(dir, 'work-gate', c.results[0].saved!.diff))).toBe(true);
    expect(log).toMatch(/Nondeterministic slides \(the control render differed; judged like every other slide\): 1: test\/parity\/fixtures\/nondeterministic\.html \(protected\): slides 1\./);

    // The delayed build renders identically in both (both dwell past its 400 ms reveal).
    expect(deckOf(res, DELAYED).pass).toBe(true);
  });

  test('a raster PDF page shows what a script reveals 400 ms after the slide arrives', () => {
    const pdf = pdfOf(deckOf(run.res, DELAYED));
    expect(pdf.pages).toBe(3);
    expect(pdf.pageStats.map((p) => p.stats.overShare <= run.res.pdfGate)).toEqual([true, true, true]);
  });

  // Review finding 38 (decision D-10): without the seed, slide 1 of this deck differed by 19.7% and its PDF page
  // by 25.5% (every load draws its own colours and dots).
  test('every render gets the same seeded Math.random: a deck that draws with it renders identically', () => {
    const { res } = run;
    expect(res.determinism.seededRandom).toBe(true);
    expect(res.determinism.randomness).toMatch(/seeded/);
    expect(res.determinism.randomness).toMatch(/Date, performance\.now and crypto\.getRandomValues are left alone/);
    expect(res.diagnosis).toEqual({ unseeded: false, noPdftoppm: false });
    const d = deckOf(res, SEEDED);
    expect(d.pass).toBe(true);
    expect(d.identical).toBe(3);
    expect(d.nondeterministic).toEqual([]);
    for (const s of d.results) {
      expect(s.stats!.exact, `slide ${s.slide + 1}`).toBe(0);
      expect(s.control!.exact, `slide ${s.slide + 1}`).toBe(0);
    }
    // The PDF is a separate walk of other render views: seeded the same way.
    const pdf = pdfOf(d);
    expect(pdf.pass).toBe(true);
    expect(pdf.pageStats.map((p) => p.stats.exact)).toEqual([0, 0, 0]);
  });

  // Review finding 39: the result says what the overlay and same-slide checks verify.
  test('the result states what the checks verify', () => {
    const { res, log } = run;
    expect(res.method.overlay).toMatch(/once per walk/);
    expect(res.method.sameSlide).toMatch(/not part of the verdict/);
    expect(res.method.tolerance).toMatch(/more than 2 of 255/);
    expect(res.method.pdf).toMatch(/every page's size/);
    expect(res.determinism.control).toMatch(/judged like any other slide/);
    expect(log).toMatch(/slide comparisons identical to the byte/);
  });
});

test.describe.serial('the gate fails what it must (negative controls)', () => {
  let dir = '';
  let screens: Run;
  let printed: Run;
  let noPdftoppm: Run;

  test.beforeAll(() => {
    test.setTimeout(3 * RUN_MS);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-parity-neg-'));
    screens = runParity(dir, 'screens', [...SHIFTS.map(([f]) => f), TEXT], []);
    printed = runParity(dir, 'printed', [PAGE_SIZE], ['--pdf']);
    noPdftoppm = runParity(dir, 'no-pdftoppm', [PAGE_SIZE], ['--pdf', '--no-pdftoppm']);
  });

  test.afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // Review finding 38: these passed at the old tolerance of 8 (+6: 0.000% over it, max Δ 7; +8: 0.097%).
  test('every colour of Blueline\'s render shifted by 6 or by 8 levels fails every slide', () => {
    const { res, log, status } = screens;
    expect(status, log).toBe(1);
    expect(res.tolerance).toBe(2);
    for (const [label, shift] of SHIFTS) {
      const d = deckOf(res, label);
      expect(d.errors, label).toEqual([]);
      expect(d.compared, label).toBe(3);
      expect(d.pass, label).toBe(false);
      expect(d.identical, label).toBe(0);
      expect(d.nondeterministic, label).toEqual([]);
      for (const s of d.results) {
        const at = `${label} slide ${s.slide + 1}`;
        expect(s.pass, at).toBe(false);
        expect(s.stats!.overShare, at).toBeGreaterThan(0.99);
        expect(s.stats!.maxDelta, at).toBeGreaterThanOrEqual(shift);
        expect(s.control!.exact, at).toBe(0);
      }
    }
  });

  // Review finding 39: a slide whose visible text differs is listed, and is judged on its pixels only.
  test('a slide whose visible text differs is recorded and listed, not judged', () => {
    const d = deckOf(screens.res, TEXT);
    expect(d.results.map((s) => s.sameText)).toEqual([true, false, true]);
    expect(d.textDiffers).toEqual([1]);
    expect(d.scrollDiffers).toEqual([]);
    expect(d.results[1].stats!.exact).toBeGreaterThan(0);
    expect(d.pass).toBe(true);
    expect(screens.log).toMatch(/Visible text differs \(recorded, not the verdict\): 1: test\/parity\/fixtures\/text-differs\.html \(protected\): slides 2\./);
  });

  // Review finding 37: the printed pages are compared by size against Chromium's own print of the file.
  for (const [name, which] of [
    ['with pdftoppm when the machine has it', () => printed],
    ['without pdftoppm (--no-pdftoppm, as on a Mac without poppler)', () => noPdftoppm],
  ] as const) {
    test(`a print-CSS PDF whose pages are not the size of the plain print's fails, ${name}`, () => {
      const { res, log, status } = which();
      expect(status, log).toBe(1);
      const d = deckOf(res, PAGE_SIZE);
      // The screens are the same: only the print differs.
      expect(d.pass, log).toBe(true);
      const pdf = pdfOf(d);
      expect(pdf.mode).toBe('print-css');
      expect(pdf.pages).toBe(3);
      expect(pdf.plainPages).toBe(3);
      expect(pdf.pageCountOk).toBe(true);
      expect(pdf.sizesOk).toBe(false);
      expect(pdf.pass).toBe(false);
      expect(pdf.sizeMismatches.map((m) => m.page)).toEqual([0, 1, 2]);
      for (const m of pdf.sizeMismatches) {
        expect(m.blueline.w).toBeCloseTo(960, 0);
        expect(m.blueline.h).toBeCloseTo(540, 0);
        expect(m.plain.w).toBeCloseTo(1200, 0);
        expect(m.plain.h).toBeCloseTo(675, 0);
      }
      expect(pdf.compared).toMatch(/every page's size against the plain print's page/);
      if (res.pdftoppm) expect(pdf.compared).toMatch(/rasterised by pdftoppm/);
      else {
        expect(pdf.compared).toMatch(/pixels not compared/);
        expect(pdf.pageStats).toEqual([]);
      }
    });
  }

  test('--no-pdftoppm compares as a machine without poppler does, and says so', () => {
    expect(noPdftoppm.res.pdftoppm).toBe(false);
    expect(noPdftoppm.res.diagnosis.noPdftoppm).toBe(true);
    expect(noPdftoppm.log).toMatch(/pdftoppm not available: printed pages compared by count and size only/);
  });
});
