// Slide detection and slide references in the real app (9.4; section 8 SlideRef; 6.7 Index replay).
//
// - Finding 29: a generic deck whose hidden slides each hold 3 or more `section` cards. The cards of a hidden
//   slide match the slide selectors with nothing visible, and used to be taken for the slides
//   (fixtures/slides/cards.html, through the real `blueline map`).
// - Finding 10/14: the deck view's SlideState reaches main with its per-slide ids, hashes and reveal indices
//   and its deckNav keys, so a note's SlideRef carries the element id and reveal's [h, v], and session.json
//   learns deckNav as soon as a key moved the deck forward.
//
// Decks are copied to temp folders first. Run with `npm run test:e2e` (global setup starts Xvfb on Linux).

import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, loopAround, resolveRunAs, sleep } from '../helpers/app';
import type { Session } from '../../packages/core/src/types';

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'packages/cli/dist/blueline.cjs');

test.describe.configure({ mode: 'serial' });
test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run through `npm run test:e2e` (its global setup starts Xvfb)');

const tmpDirs: string[] = [];
test.afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface MapJson {
  coverage: { total: number; slides?: { count: number; reached: number } };
  report: {
    slides: { kind: string; navKind: string; count: number; reached: number };
    perSlide: { title: string; reached: boolean; total: number }[];
    totals: { total: number };
  };
}

/** `blueline map <copy> --report --json` on a copy of a fixtures/slides deck. */
function mapCopy(name: string): { code: number | null; json: MapJson | null; stderr: string } {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-slides-e2e-'));
  tmpDirs.push(d);
  const deck = path.join(d, name);
  fs.copyFileSync(path.join(FIXTURES, 'slides', name), deck);
  const r = spawnSync(process.execPath, [CLI, 'map', deck, '--report', '--json'], { encoding: 'utf8', env: process.env, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  let json: MapJson | null = null;
  try {
    json = JSON.parse(r.stdout) as MapJson;
  } catch {
    json = null;
  }
  return { code: r.status, json, stderr: r.stderr };
}

for (const name of ['cards.html', 'cards-control.html']) {
  test(`${name}: generic, the 3 .slide divs are the slides, all reached, 15 nodes (finding 29)`, async () => {
    test.setTimeout(300_000);
    const r = mapCopy(name);
    expect(r.json, `map --json gave no JSON (exit ${r.code}):\n${r.stderr.slice(-3000)}`).not.toBeNull();
    const j = r.json!;
    expect(j.report.slides.kind).toBe('generic');
    expect(j.report.slides.count, 'the slides are the three .slide divs, not the cards of a hidden slide').toBe(3);
    expect(j.report.perSlide.map((s) => s.title)).toEqual(['Slide 1 heading', 'Slide 2 heading', 'Slide 3 heading']);
    expect(j.report.slides.reached, 'every slide is reached: the current slide follows the deck').toBe(3);
    expect(j.report.perSlide.every((s) => s.reached)).toBe(true);
    // 3 × (an h2 and 4 h3): every visible text node of the deck is counted.
    expect(j.report.totals.total).toBe(15);
    expect(j.coverage.total).toBe(15);
  });
}

/** Polls a session.json until `pred` holds; returns the last session read. */
async function sessionWhen(file: string, pred: (s: Session) => boolean, timeout = 10_000): Promise<Session | null> {
  const end = Date.now() + timeout;
  let s: Session | null = null;
  while (Date.now() < end) {
    try {
      s = JSON.parse(fs.readFileSync(file, 'utf8')) as Session;
      if (pred(s)) return s;
    } catch {
      // not written yet, or mid-write
    }
    await sleep(150);
  }
  return s;
}

test('reveal-hash: a note on Bet one (Reveal [2, 1]) is stored with its id and nav value [2, 1] (finding 10/14)', async () => {
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('reveal');
  fs.cpSync(path.join(FIXTURES, 'decks/reveal-hash'), dir, { recursive: true });
  s.own(dir);
  const app = await launchApp({ files: [path.join(dir, 'index.html')], scratch: s });
  try {
    const deck = await app.waitForDeck('index.html');
    await deck.waitFor('window.Reveal && Reveal.isReady && Reveal.isReady()');
    await deck.eval('Reveal.slide(2, 1)');
    // main follows the deck view's slide reports.
    const end = Date.now() + 10_000;
    while (Date.now() < end && (await app.win(deck.docId)).state.slide?.current !== 3) await sleep(150);
    const w = await app.win(deck.docId);
    expect(w.state.slide?.current, 'main should see slide 3 (Bet one) as current').toBe(3);
    expect(await deck.eval<string>('JSON.stringify(Reveal.getIndices())')).toBe(JSON.stringify({ h: 2, v: 1 }));

    // Review, pen, one stroke: a note on the current slide.
    await deck.chord('2');
    await sleep(250);
    await deck.key('1');
    await sleep(150);
    await deck.drag(loopAround({ x: 300, y: 300, w: 200, h: 120 }, 12));
    const sess = await sessionWhen(w.sessionFile, (x) => Array.isArray(x.notes) && x.notes.length >= 1);
    expect(sess?.notes?.[0]?.slide, 'section 8 SlideRef: element id, and reveal nav [h, v]').toEqual({
      index: 3,
      id: 'bet-one',
      title: 'Bet one: self-serve',
      nav: { kind: 'reveal', value: [2, 1] },
    });
  } finally {
    await app.close();
    s.cleanup();
  }
});

test('generic-index: after one ArrowRight in Read, session.json has deckNav (6.7 Index replay, finding 10/14)', async () => {
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('generic');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  s.own(dir);
  const app = await launchApp({ files: [file], scratch: s });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    await sleep(800);
    const w = await app.win(deck.docId);
    expect(w.appMode).toBe('read');
    expect(w.state.slide?.current).toBe(0);
    expect(fs.existsSync(w.sessionFile), 'nothing written before the deck moved').toBe(false);
    await deck.key('ArrowRight');
    const end = Date.now() + 5_000;
    while (Date.now() < end && (await app.win(deck.docId)).state.slide?.current !== 1) await sleep(100);
    expect((await app.win(deck.docId)).state.slide?.current, 'ArrowRight moved the deck').toBe(1);
    // Only forward was seen: back defaults to its counterpart.
    const sess = await sessionWhen(w.sessionFile, (x) => !!x.deckNav);
    expect(sess?.deckNav).toEqual({ forward: 'ArrowRight', back: 'ArrowLeft' });
  } finally {
    await app.close();
    s.cleanup();
  }
});
