// Two external saves in quick succession keep an index deck's slide (review finding 20; 6.6 Reload: "Before
// reloading, it saves the view state … After reloading, it restores that state"; 9.2 Watcher). An index deck's
// slide comes back after a reload through main's own key presses, about 120 ms a slide; a second save that lands
// while those presses run must not save the half-restored slide. The gaps are longer than the watcher's settle
// (150 + 50 ms), so on an idle machine each save is its own reload, and shorter than the restore (the review lost
// the slide at every gap of 300-700 ms at slide 4 of 6, and at 1.5 s and 2.5 s at slide 20 of 24).
//
// The oracle is the outcome, not one reload per save: the page ends on the version on disk, on its slide. A save
// that lands before the watcher has settled the one before it (main busy for ~200 ms on a loaded machine: the
// first check reads the second save, or its two reads disagree and it looks again, 9.2 Watcher step 2) is shown by
// the same reload, and that is correct (6.6 reloads "with the new version"; the hardening round's full run once saw
// 1 reload for 2 saves 400 ms apart). The held-main test makes that case on purpose. A save is never missed: the
// watcher reads again whenever its reads disagree or the path changed after them, and its stat poll runs every second.
// The late-deck test makes the case the second hardening round's stress run found: the second reload starts before the
// first reloaded page has shown its slides (a page's first reports say a single page), and the slide must still come
// back. A failing test attaches main's log.
import { expect, test } from '@playwright/test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

/** The app of the running test: its main log is attached when the test fails (a flake under load is read from it). */
let running: BlApp | null = null;
test.afterEach(async ({}, info) => {
  const app = running;
  running = null;
  if (app && info.status !== info.expectedStatus) await info.attach('main log', { body: app.logs.slice(-600).join('\n'), contentType: 'text/plain' });
});

async function launch(file: string): Promise<BlApp> {
  running = await launchApp({ files: [file], scratch });
  return running;
}

interface Win {
  handshakes: number;
  reloads: number;
  /** The version the deck view shows or is loading, and whether a reload waits or runs (window.ts reloadView). */
  reloadView: { showing: string; phase: 'idle' | 'deferred' | 'reloading' };
  /** The document's version: the sha256 of the bytes main took. */
  version: string;
  state: { slide: { current: number; count: number } | null };
  view: { restoring?: boolean };
}

async function w(app: BlApp, docId: string): Promise<Win> {
  return (await app.win(docId)) as unknown as Win;
}

/** An editor's save: a temp file renamed over the deck (a new inode). */
function renameReplace(file: string, text: string, s: Scratch): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.swp`);
  fs.writeFileSync(tmp, text);
  s.own(tmp);
  fs.renameSync(tmp, file);
}

/** A generated index deck: `n` slides moved by ArrowRight and ArrowLeft only, no hash. */
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

/**
 * An index deck that builds its six slides 1.5 s after its script runs (a deck drawn from its data): until then a
 * page of it shows no slide, and its reports say a single page.
 */
function lateDeck(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Late deck</title><style>
html,body{margin:0;height:100%;overflow:hidden;font:40px system-ui}
.slide{position:absolute;inset:0;display:none;padding:80px}.slide.on{display:block}
</style></head><body><main id="deck"></main>
<script>
var s=[],i=0;
function show(k){i=Math.max(0,Math.min(s.length-1,k));s.forEach(function(e,j){e.classList.toggle('on',j===i)})}
setTimeout(function(){var d=document.getElementById('deck');for(var n=0;n<6;n++){var e=document.createElement('section');e.className='slide';e.innerHTML='<h2>Part '+(n+1)+'</h2>';d.appendChild(e);s.push(e)}show(0)},1500);
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'){e.preventDefault();show(i+1)}else if(e.key==='ArrowLeft'){e.preventDefault();show(i-1)}});
</script></body></html>`;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * After `saves` external saves: waits until the deck view shows the version on disk (the reload that shows it ran,
 * so its view state was sent back, and no reload waits or runs), then until the restore ended and the slide stayed
 * put for 2 s. Returns the slide the deck ends on and the reloads it took (1 to `saves`).
 */
async function settleOnDisk(app: BlApp, docId: string, file: string, before: Win, saves: number, timeout: number): Promise<{ slide: number; reloads: number }> {
  const want = sha256(file);
  await expect
    .poll(
      async () => {
        const x = await w(app, docId);
        return x.version === want && x.reloadView.showing === want && x.reloadView.phase === 'idle';
      },
      { timeout },
    )
    .toBe(true);
  await expect.poll(async () => (await w(app, docId)).view.restoring ?? false, { timeout }).toBe(false);
  let last = -2;
  let since = Date.now();
  const end = Date.now() + timeout;
  while (Date.now() < end && Date.now() - since < 2000) {
    const cur = (await w(app, docId)).state.slide?.current ?? -1;
    if (cur !== last) {
      last = cur;
      since = Date.now();
    }
    await sleep(150);
  }
  const reloads = (await w(app, docId)).reloads - before.reloads;
  // At least one reload showed the last save, and never more than one a save.
  expect(reloads, 'reloads for the saves').toBeGreaterThanOrEqual(1);
  expect(reloads, 'reloads for the saves').toBeLessThanOrEqual(saves);
  return { slide: last, reloads };
}

/** At the deck's slide, two saves `gap` ms apart; returns the slide the deck ends on and the reloads it took. */
async function twoSaves(app: BlApp, docId: string, file: string, gap: number, round: number): Promise<{ slide: number; reloads: number }> {
  const before = await w(app, docId);
  const src = fs.readFileSync(file, 'utf8');
  renameReplace(file, src.replace('</body>', `<!-- round ${round} a -->\n</body>`), scratch);
  await sleep(gap);
  renameReplace(file, src.replace('</body>', `<!-- round ${round} a --><!-- round ${round} b -->\n</body>`), scratch);
  return settleOnDisk(app, docId, file, before, 2, 30_000);
}

/**
 * At the deck's slide, three saves `gap` ms apart (agents commonly save several times in a row); returns the slide
 * the deck ends on and the reloads it took (review finding 20: the re-verification lost the slide with three
 * writes, because a superseded replay cleared the next restore's wait).
 */
async function threeSaves(app: BlApp, docId: string, file: string, gap: number, round: number): Promise<{ slide: number; reloads: number }> {
  const before = await w(app, docId);
  const src = fs.readFileSync(file, 'utf8');
  for (let n = 1; n <= 3; n++) {
    const marks = Array.from({ length: n }, (_, k) => `<!-- r${round} ${k + 1} -->`).join('');
    renameReplace(file, src.replace('</body>', `${marks}\n</body>`), scratch);
    if (n < 3) await sleep(gap);
  }
  return settleOnDisk(app, docId, file, before, 3, 40_000);
}

/** Notes how many reloads each round took (one per save on an idle machine; fewer when saves land within a settle). */
function noteReloads(rounds: Record<string, number>): void {
  test.info().annotations.push({ type: 'reloads', description: JSON.stringify(rounds) });
}

test('generic-index.html at slide 5 of 6: three saves 400 ms apart keep the slide', async () => {
  const dir = scratch.dir('views-reload-thrice');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launch(file);
  try {
    const deck = await app.waitForDeck('generic-index.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBe(6);
    for (let i = 0; i < 4; i++) await deck.key('ArrowRight');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(4);
    await sleep(500);
    const r = await threeSaves(app, deck.docId, file, 400, 0);
    noteReloads({ 400: r.reloads });
    expect(r.slide).toBe(4);
    expect(await deck.eval<string>('document.documentElement.outerHTML')).toContain('<!-- r0 3 -->');
  } finally {
    await app.close();
  }
});

test('a 24-slide index deck at slide 21: three saves 1.2 s apart keep the slide', async () => {
  const dir = scratch.dir('views-reload-thrice-24');
  const file = path.join(dir, 'long.html');
  fs.writeFileSync(file, indexDeck(24));
  scratch.own(dir);
  const app = await launch(file);
  try {
    const deck = await app.waitForDeck('long.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBe(24);
    for (let i = 0; i < 20; i++) await deck.key('ArrowRight');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(20);
    await sleep(500);
    const r = await threeSaves(app, deck.docId, file, 1200, 0);
    noteReloads({ 1200: r.reloads });
    expect(r.slide).toBe(20);
    expect(await deck.eval<string>('document.documentElement.outerHTML')).toContain('<!-- r0 3 -->');
  } finally {
    await app.close();
  }
});

test('generic-index.html at slide 5 of 6: two saves 300, 400 and 600 ms apart end on the same slide', async () => {
  const dir = scratch.dir('views-reload-twice');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launch(file);
  try {
    const deck = await app.waitForDeck('generic-index.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBe(6);
    for (let i = 0; i < 4; i++) await deck.key('ArrowRight');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(4);
    await sleep(500);
    const ends: Record<number, number> = {};
    const reloads: Record<number, number> = {};
    for (const [round, gap] of [300, 400, 600].entries()) {
      const r = await twoSaves(app, deck.docId, file, gap, round);
      ends[gap] = r.slide;
      reloads[gap] = r.reloads;
    }
    noteReloads(reloads);
    expect(ends).toEqual({ 300: 4, 400: 4, 600: 4 });
    expect(fs.readFileSync(file, 'utf8')).toContain('<!-- round 2 b -->');
    expect(await deck.eval<string>('document.documentElement.outerHTML')).toContain('<!-- round 2 b -->');
  } finally {
    await app.close();
  }
});

test('a 24-slide index deck at slide 21: two saves 1.5 s and 2.5 s apart end on the same slide', async () => {
  const dir = scratch.dir('views-reload-twice-24');
  const file = path.join(dir, 'long.html');
  fs.writeFileSync(file, indexDeck(24));
  scratch.own(dir);
  const app = await launch(file);
  try {
    const deck = await app.waitForDeck('long.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBe(24);
    for (let i = 0; i < 20; i++) await deck.key('ArrowRight');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(20);
    await sleep(500);
    const ends: Record<number, number> = {};
    const reloads: Record<number, number> = {};
    for (const [round, gap] of [1500, 2500].entries()) {
      const r = await twoSaves(app, deck.docId, file, gap, round);
      ends[gap] = r.slide;
      reloads[gap] = r.reloads;
    }
    noteReloads(reloads);
    expect(ends).toEqual({ 1500: 20, 2500: 20 });
    expect(await deck.eval<string>('document.documentElement.outerHTML')).toContain('<!-- round 1 b -->');
  } finally {
    await app.close();
  }
});

test('generic-index.html at slide 5 of 6: a second save before the watcher settles the first is shown by the same reload', async () => {
  // A loaded machine, made on purpose: main's event loop is held while both saves land, 400 ms apart, so the
  // watcher's settled reads (9.2 Watcher step 2) see only the second. One reload shows it, on the same slide, and no
  // version is lost. The block must cover both saves; a round where it did not (main got the block late) is retried.
  const dir = scratch.dir('views-reload-coalesced');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launch(file);
  try {
    const deck = await app.waitForDeck('generic-index.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBe(6);
    for (let i = 0; i < 4; i++) await deck.key('ArrowRight');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(4);
    await sleep(500);
    let covered = false;
    for (let round = 0; round < 4 && !covered; round++) {
      const before = await w(app, deck.docId);
      const src = fs.readFileSync(file, 'utf8');
      // Main busy-waits 1.5 s and says when it started and ended (the test runs on the same clock).
      const block = app.electronApp.evaluate(() => {
        const start = Date.now();
        while (Date.now() - start < 1500) {
          // busy: no timer, no fs event and no IPC is handled meanwhile
        }
        return { start, end: Date.now() };
      });
      await sleep(150);
      const a = Date.now();
      renameReplace(file, src.replace('</body>', `<!-- held ${round} a -->\n</body>`), scratch);
      await sleep(400);
      renameReplace(file, src.replace('</body>', `<!-- held ${round} a --><!-- held ${round} b -->\n</body>`), scratch);
      const b = Date.now();
      const held = await block;
      covered = held.start < a && b < held.end;
      const r = await settleOnDisk(app, deck.docId, file, before, 2, 30_000);
      expect(r.slide).toBe(4);
      expect(await deck.eval<string>('document.documentElement.outerHTML')).toContain(`<!-- held ${round} b -->`);
      if (covered) {
        noteReloads({ held: r.reloads, round });
        // The watcher never saw the first save on its own: one reload showed the second.
        expect(r.reloads).toBe(1);
      }
    }
    expect(covered, 'main was not held across both saves in 4 rounds').toBe(true);
  } finally {
    await app.close();
  }
});

test('an index deck that shows its slides late: a second save before the reloaded page showed them keeps the slide', async () => {
  // Review finding 20 again (the hardening round's second stress run lost the slide this way at gaps of 400 ms): a
  // reload that starts while the one before it still restores sends the same view state again, and the page it
  // replaces has not shown its slides yet (its reports say a single page). Whether main's keys bring the slide
  // back follows the page the state was taken from, an index deck. Here every page shows its slides 1.5 s after it
  // loads, so the second save (400 ms after the first) always lands in that window.
  const dir = scratch.dir('views-reload-late');
  const file = path.join(dir, 'late.html');
  fs.writeFileSync(file, lateDeck());
  scratch.own(dir);
  const app = await launch(file);
  try {
    const deck = await app.waitForDeck('late.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0, { timeout: 20_000 }).toBe(6);
    for (let i = 0; i < 4; i++) await deck.key('ArrowRight');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(4);
    await sleep(500);
    const ends: Record<number, number> = {};
    const reloads: Record<number, number> = {};
    for (const [round, gap] of [400, 700].entries()) {
      const r = await twoSaves(app, deck.docId, file, gap, round);
      ends[gap] = r.slide;
      reloads[gap] = r.reloads;
    }
    noteReloads(reloads);
    expect(ends).toEqual({ 400: 4, 700: 4 });
    expect(await deck.eval<string>('document.documentElement.outerHTML')).toContain('<!-- round 1 b -->');
  } finally {
    await app.close();
  }
});
