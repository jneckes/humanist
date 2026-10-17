// Render parity and PDF on committed fixtures (SPEC 10 Phase 1 exit gate; 11: "Render parity and PDF. As in the
// Phase 1 exit gate, run nightly on the committed fixtures"). Runs scripts/parity.mjs once, as a person would,
// on three fixtures that cover the three ways the render service shows a slide (generic keys, reveal.js, a
// scrolling document) and two PDF modes (raster, document), plus:
// - a negative control whose first slide differs between any two loads: the harness must fail that slide and
//   pass its other two, or it is not looking;
// - the delayed-build repro (docs/PHASE1-RESULTS.md, PDF): a raster PDF page must show what a script reveals
//   400 ms after the slide arrives (visitSlides waits for it: RenderView.waitScripted, slide-index.ts
//   SCRIPTED_SETTLE). It was an expected failure until that wait was added.
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ParityResult } from './harness/job';

const ROOT = path.resolve(__dirname, '../..');
const DECKS = ['decks/generic-index.html', 'decks/reveal-hash/index.html', 'decks/report.html'];
const CONTROL = 'test/parity/fixtures/nondeterministic.html';
const DELAYED = 'test/parity/fixtures/delayed-build.html';

test.describe.serial('exit gate on committed fixtures', () => {
  let dir = '';
  let res: ParityResult;
  let log = '';
  let status: number | null = null;

  test.beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-parity-'));
    const out = path.join(dir, 'parity.json');
    const r = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/parity.mjs'), '--decks', [...DECKS, CONTROL, DELAYED].join(','), '--pdf', '--trust', 'protected', '--out', out, '--work', path.join(dir, 'work')],
      { cwd: ROOT, encoding: 'utf8', timeout: 540_000, env: process.env },
    );
    log = `${r.stdout}\n${r.stderr}`;
    status = r.status;
    res = JSON.parse(fs.readFileSync(out, 'utf8')) as ParityResult;
  });

  test.afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('Blueline renders every slide as plain Electron does, and its PDFs match (3 committed fixtures)', () => {
    // 1: a gate failed (the control, the delayed build's PDF); 0 would mean the control passed, 2 a harness error.
    expect(status, log).toBe(1);
    expect(res.env.electron).toBe('44.7.2');
    expect(res.env.proxyEnv).toBe(false);
    expect(res.tolerance).toBe(8);
    expect(res.gate).toBe(0.005);
    expect(res.dwellMs).toBe(2000);

    for (const label of DECKS) {
      const d = res.decks.find((x) => x.label === label)!;
      expect(d, label).toBeTruthy();
      expect(d.errors, label).toEqual([]);
      expect(d.slides, label).toBeGreaterThan(0);
      expect(d.indexComplete, label).toBe(true);
      expect(d.missed, label).toEqual([]);
      expect(d.compared, label).toBe(d.slides);
      expect(d.charset.blueline, label).toBe(d.charset.plain);
      for (const s of d.results) {
        const at = `${label} slide ${s.slide + 1}`;
        // The plain render reached the same slide and shows the same text, both frames were stable.
        expect(s.notes, at).toEqual([]);
        expect(s.sameText, at).toBe(true);
        expect(s.stable, at).toEqual({ blueline: true, plain: true });
        expect(s.scrollY.blueline, at).toBe(s.scrollY.plain);
        expect(s.dwell.plain, at).toBeGreaterThanOrEqual(res.dwellMs);
        expect(s.dwell.blueline, at).toBeGreaterThanOrEqual(s.dwell.plain);
        expect(s.stats!.overShare, at).toBeLessThanOrEqual(res.gate);
      }
      expect(d.pass, label).toBe(true);
      const pdf = d.pdf!;
      expect(pdf && !('error' in pdf), `${label}: ${JSON.stringify(pdf)}`).toBe(true);
      if (pdf && !('error' in pdf)) {
        expect(pdf.pageCountOk, label).toBe(true);
        expect(pdf.pass, `${label}: ${pdf.compared}`).toBe(true);
        expect(pdf.mode, label).toBe(d.kind === 'scroll' || d.kind === 'single' ? 'document' : 'raster');
        if (pdf.mode === 'raster') expect(pdf.pages, label).toBe(d.slides);
        else expect(pdf.pages, label).toBe(pdf.plainPages);
      }
    }

    // The control: slide 1 differs (the random box, 16% of the slide), slides 2 and 3 match exactly.
    const c = res.decks.find((x) => x.label === CONTROL)!;
    expect(c.kind).toBe('generic');
    expect(c.pass).toBe(false);
    expect(c.results.map((s) => s.pass)).toEqual([false, true, true]);
    expect(c.results[0].stats!.overShare).toBeGreaterThan(0.1);
    expect(c.results[1].stats!.exact).toBe(0);
    expect(c.results[2].stats!.exact).toBe(0);
    expect(c.results[0].saved?.diff).toBeTruthy();
    expect(fs.existsSync(path.join(dir, 'work', c.results[0].saved!.diff))).toBe(true);

    // The delayed build renders identically in both (both dwell past its 400 ms reveal).
    const db = res.decks.find((x) => x.label === DELAYED)!;
    expect(db.pass).toBe(true);
  });

  test('a raster PDF page shows what a script reveals 400 ms after the slide arrives', () => {
    const db = res.decks.find((x) => x.label === DELAYED)!;
    const pdf = db.pdf!;
    expect('error' in pdf).toBe(false);
    if (!('error' in pdf)) {
      expect(pdf.pages).toBe(3);
      expect(pdf.pageStats.map((p) => p.stats.overShare <= res.pdfGate)).toEqual([true, true, true]);
    }
  });
});
