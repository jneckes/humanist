// 9.1 rate limits against what a person does (the second hardening round). Every deck message counts against one
// budget per document and view kind, all channels together (ipc-guard.ts DECK_SENDER_RATE: 9.1's 1,000 messages a
// second, a second's worth of burst), before its channel's own bucket. This measures the busiest second of the fastest
// use a person makes of each feature, faster than a person: typing in a note card, drawing strokes, stepping through
// slides, typing in an edit field, panning with the wheel, and the background renders that fill a long deck's
// thumbnails. Main counts what its router admits (__blTest.ipcAdmitted) and is sampled every 10 ms in main itself; no
// message may be dropped for its rate, and the busiest second must stay under a quarter of the budget. The numbers
// are noted on each test (annotations "rates") and recorded in SECURITY.md (Rate limits).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EDIT_BUILD, FIXTURES, Scratch, copyInto, launchApp, loopAround, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

/** DECK_SENDER_RATE.perSecond (ipc-guard.ts): 9.1's example figure. */
const BUDGET = 1000;
/** What a person's busiest second may take of it here. */
const CEILING = BUDGET / 4;

type Kind = 'deck' | 'render';

interface Rate {
  /** Messages admitted while sampling. */
  total: number;
  /** The most admitted in any one second (10 ms samples). */
  peak: number;
  /** How long the sampling ran, in ms. */
  ms: number;
}

/** Starts sampling, in main every 10 ms, what the router admitted from the document's deck and render views. */
async function startSampling(app: BlApp, docId: string): Promise<void> {
  await app.electronApp.evaluate((_e, id) => {
    const g = globalThis as unknown as Record<string, unknown> & { __blTest: { ipcAdmitted(d: string, k: string): number } };
    const samples: [number, number, number][] = [];
    const tick = () => samples.push([performance.now(), g.__blTest.ipcAdmitted(id, 'deck'), g.__blTest.ipcAdmitted(id, 'render')]);
    tick();
    g.__blRates = { samples, timer: setInterval(tick, 10) };
  }, docId);
}

/** Stops sampling; the totals and the busiest second of each view kind. */
async function stopSampling(app: BlApp): Promise<Record<Kind, Rate>> {
  const samples = await app.electronApp.evaluate(() => {
    const g = globalThis as unknown as Record<string, unknown> & { __blRates: { samples: [number, number, number][]; timer: ReturnType<typeof setInterval> } };
    clearInterval(g.__blRates.timer);
    return g.__blRates.samples;
  });
  const rate = (col: 1 | 2): Rate => {
    // A kind's count starts again when its last view closes (render views come and go): a fall is a new count.
    const t: number[] = [];
    const cum: number[] = [];
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const c = samples[i][col];
      const prev = i === 0 ? c : samples[i - 1][col];
      sum += i === 0 ? 0 : c >= prev ? c - prev : c;
      t.push(samples[i][0]);
      cum.push(sum);
    }
    let peak = 0;
    for (let j = 0, i = 0; j < t.length; j++) {
      while (t[j] - t[i] > 1000) i++;
      // The sample before the window's first holds the count at its start (messages between the two are counted in).
      peak = Math.max(peak, cum[j] - cum[Math.max(0, i - 1)]);
    }
    return { total: sum, peak, ms: Math.round(t[t.length - 1] - t[0]) };
  };
  return { deck: rate(1), render: rate(2) };
}

function rateDrops(app: BlApp): string[] {
  return app.logs.filter((l) => /ipc drop \S+ rate/.test(l));
}

function note(what: string, r: Record<Kind, Rate>): void {
  test.info().annotations.push({ type: 'rates', description: `${what}: ${JSON.stringify(r)}` });
  console.log(`[rates] ${what}: ${JSON.stringify(r)}`);
}

/** One key press as raw input (keyDown, char, keyUp; Electron names the space bar's key 'Space'). */
function keyEvents(ch: string): Record<string, unknown>[] {
  const key = ch === ' ' ? 'Space' : ch;
  return [
    { type: 'keyDown', keyCode: key },
    { type: 'char', keyCode: ch },
    { type: 'keyUp', keyCode: key },
  ];
}

const TYPED = 'the quick brown fox jumps over the lazy dog and then it does it all again faster than anyone types';

async function typeFast(deck: DeckView, text: string): Promise<void> {
  await deck.focus();
  // 2 ms between events: about 6 ms a character, some 150 characters a second (a fast typist makes 10 to 15).
  await deck.input(
    [...text].flatMap((ch) => keyEvents(ch)),
    2,
  );
}

/** A generated index deck: `n` slides moved by ArrowRight and ArrowLeft. */
function indexDeck(n: number): string {
  const slides = Array.from({ length: n }, (_, i) => `<section class="slide${i === 0 ? ' on' : ''}"><h2>Part ${i + 1}</h2><p>Body of part ${i + 1}</p></section>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Long deck</title><style>
html,body{margin:0;height:100%;overflow:hidden;font:40px system-ui}
.slide{position:absolute;inset:0;display:none;padding:80px}.slide.on{display:block}
</style></head><body>
${slides}
<script>
var s=[].slice.call(document.querySelectorAll('.slide')),i=0;
function show(k){i=Math.max(0,Math.min(s.length-1,k));s.forEach(function(e,j){e.classList.toggle('on',j===i)})}
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'){e.preventDefault();show(i+1)}else if(e.key==='ArrowLeft'){e.preventDefault();show(i-1)}});
</script></body></html>`;
}

function notesOf(sessionFile: string): { text: string; marks: unknown[] }[] {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { notes?: { text: string; marks: unknown[] }[] };
    return Array.isArray(raw.notes) ? raw.notes : [];
  } catch {
    return [];
  }
}

test('Review: ten strokes drawn back to back and a card typed into at ~150 characters a second stay far below the budget', async () => {
  const dir = scratch.dir('rates-review');
  const file = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('single.html');
    const sessionFile = (await app.win(deck.docId)).sessionFile;
    await deck.chord('2');
    await expect.poll(async () => (await app.win(deck.docId)).appMode).toBe('review');
    await deck.key('1');
    await sleep(150);
    await startSampling(app, deck.docId);
    // Ten small loops down the left edge of the view, clear of the card the first opens (a stroke on the card would
    // take the keyboard from it); each is drawn as fast as the input goes (37 points, 8 ms apart: about 0.3 s).
    for (let k = 0; k < 10; k++) await deck.drag(loopAround({ x: 20, y: 90 + k * 70, w: 50, h: 36 }, 6));
    // The card takes the keyboard back once the last stroke has joined its note.
    await sleep(400);
    await typeFast(deck, TYPED);
    await sleep(800);
    const r = await stopSampling(app);
    note('strokes and card typing', r);
    // The positive control: the strokes and the text reached main.
    const reached = await expect
      .poll(() => notesOf(sessionFile).some((n) => n.text.includes(TYPED)), { timeout: 10_000 })
      .toBe(true)
      .then(
        () => true,
        () => false,
      );
    expect(reached, `the card's text reached main; notes: ${JSON.stringify(notesOf(sessionFile).map((n) => [n.text, n.marks.length]))}`).toBe(true);
    expect(notesOf(sessionFile).reduce((a, n) => a + n.marks.length, 0)).toBe(10);
    expect(rateDrops(app)).toEqual([]);
    expect(r.deck.total).toBeGreaterThan(0);
    expect(r.deck.peak).toBeLessThan(CEILING);
  } finally {
    await app.close();
  }
});

test('a 24-slide index deck: its thumbnails\' background renders, then 23 slide steps 30 ms apart, stay far below the budget', async () => {
  const dir = scratch.dir('rates-slides');
  const file = path.join(dir, 'long.html');
  fs.writeFileSync(file, indexDeck(24));
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('long.html');
    await startSampling(app, deck.docId);
    const shell = await app.shellPage(deck.docId);
    await expect.poll(async () => shell.locator('#slide-list .thumb img').count(), { timeout: 110_000 }).toBe(24);
    const renders = await stopSampling(app);
    note('thumbnail renders of 24 slides', renders);
    expect(renders.render.total).toBeGreaterThan(0);
    expect(renders.render.peak).toBeLessThan(CEILING);
    expect(renders.deck.peak).toBeLessThan(CEILING);

    await startSampling(app, deck.docId);
    await deck.focus();
    for (let k = 0; k < 23; k++) {
      await deck.input(
        [
          { type: 'keyDown', keyCode: 'Right' },
          { type: 'keyUp', keyCode: 'Right' },
        ],
        15,
      );
    }
    await expect.poll(async () => ((await app.win(deck.docId)) as unknown as { state: { slide: { current: number } } }).state.slide.current).toBe(23);
    await sleep(500);
    const steps = await stopSampling(app);
    note('23 slide steps', steps);
    expect(rateDrops(app)).toEqual([]);
    expect(steps.deck.total).toBeGreaterThan(0);
    expect(steps.deck.peak).toBeLessThan(CEILING);
  } finally {
    await app.close();
  }
});

test('the wheel over a deck view larger than the window, at 250 events a second, stays far below the budget', async () => {
  const dir = scratch.dir('rates-wheel');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    await app.run('zoom-actual', deck.docId);
    await expect.poll(async () => ((await app.win(deck.docId)) as unknown as { zoomFactor: number }).zoomFactor).toBe(1);
    await expect.poll(() => deck.eval<[number, number]>('[innerWidth, innerHeight]')).toEqual([1600, 900]);
    await deck.focus();
    await startSampling(app, deck.docId);
    // Two seconds of a trackpad pan, down then up: 500 wheel events, 4 ms apart.
    const wheel = (dy: number) => ({ type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: dy, canScroll: true });
    await deck.input([...Array.from({ length: 250 }, () => wheel(-4)), ...Array.from({ length: 250 }, () => wheel(4))], 4);
    await sleep(500);
    const r = await stopSampling(app);
    note('wheel pan', r);
    expect(rateDrops(app)).toEqual([]);
    expect(r.deck.total).toBeGreaterThan(0);
    expect(r.deck.peak).toBeLessThan(CEILING);
  } finally {
    await app.close();
  }
});

test('@edit typing in an edit field at ~150 characters a second, then Enter, stays far below the budget', async () => {
  test.skip(!EDIT_BUILD, 'needs the Edit build');
  const dir = scratch.dir('rates-edit');
  const file = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  scratch.own(dir);
  const original = fs.readFileSync(file, 'utf8');
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('single.html');
    await deck.chord('3');
    await expect.poll(async () => (await app.win(deck.docId)).appMode).toBe('edit');
    await startSampling(app, deck.docId);
    // A real click on the heading's text until the overlay made it the field (its map arrives after first paint).
    const end = Date.now() + 20_000;
    let open = false;
    while (!open && Date.now() < end) {
      await deck.clickText('h1');
      open = await deck.eval<boolean>(`(function(){var e=document.querySelector('h1');return !!e && e.isContentEditable && document.activeElement === e;})()`);
      if (!open) await sleep(200);
    }
    expect(open, 'the heading became the edit field').toBe(true);
    await deck.key('End', ['control']);
    await typeFast(deck, ` ${TYPED}`);
    await deck.key('Enter');
    await expect.poll(() => fs.readFileSync(file, 'utf8') !== original, { timeout: 15_000 }).toBe(true);
    await sleep(500);
    const r = await stopSampling(app);
    note('edit field typing and commit', r);
    expect(fs.readFileSync(file, 'utf8')).toContain(TYPED);
    expect(rateDrops(app)).toEqual([]);
    expect(r.deck.total).toBeGreaterThan(0);
    expect(r.deck.peak).toBeLessThan(CEILING);
  } finally {
    await app.close();
  }
});
