// Two external saves in quick succession keep an index deck's slide (review finding 20; 6.6 Reload: "Before
// reloading, it saves the view state … After reloading, it restores that state"; 9.2 Watcher). An index deck's
// slide comes back after a reload through main's own key presses, about 120 ms a slide; a second save that lands
// while those presses run must not save the half-restored slide. The gaps are longer than the watcher's settle
// (150 + 50 ms), so each save is its own reload, and shorter than the restore (the review lost the slide at
// every gap of 300-700 ms at slide 4 of 6, and at 1.5 s and 2.5 s at slide 20 of 24).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

interface Win {
  handshakes: number;
  reloads: number;
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
 * At slide `at`, two saves `gap` ms apart; then waits until both reloads happened and the restore ended, and
 * returns the slide the deck ends on.
 */
async function twoSaves(app: BlApp, docId: string, file: string, gap: number, round: number): Promise<number> {
  const before = await w(app, docId);
  const src = fs.readFileSync(file, 'utf8');
  renameReplace(file, src.replace('</body>', `<!-- round ${round} a -->\n</body>`), scratch);
  await sleep(gap);
  renameReplace(file, src.replace('</body>', `<!-- round ${round} a --><!-- round ${round} b -->\n</body>`), scratch);
  await expect.poll(async () => (await w(app, docId)).reloads, { timeout: 30_000 }).toBe(before.reloads + 2);
  // The restore of the second reload ends (the page confirmed it and main's key presses stopped), and the slide
  // stays put for 2 s.
  await expect.poll(async () => (await w(app, docId)).view.restoring ?? false, { timeout: 30_000 }).toBe(false);
  let last = -2;
  let since = Date.now();
  const end = Date.now() + 30_000;
  while (Date.now() < end && Date.now() - since < 2000) {
    const cur = (await w(app, docId)).state.slide?.current ?? -1;
    if (cur !== last) {
      last = cur;
      since = Date.now();
    }
    await sleep(150);
  }
  return last;
}

/**
 * At slide `at`, three saves `gap` ms apart (agents commonly save several times in a row); then waits until all
 * three reloads happened and the restore ended, and returns the slide the deck ends on (review finding 20: the
 * re-verification lost the slide with three writes, because a superseded replay cleared the next restore's wait).
 */
async function threeSaves(app: BlApp, docId: string, file: string, gap: number, round: number): Promise<number> {
  const before = await w(app, docId);
  const src = fs.readFileSync(file, 'utf8');
  for (let n = 1; n <= 3; n++) {
    const marks = Array.from({ length: n }, (_, k) => `<!-- r${round} ${k + 1} -->`).join('');
    renameReplace(file, src.replace('</body>', `${marks}\n</body>`), scratch);
    if (n < 3) await sleep(gap);
  }
  await expect.poll(async () => (await w(app, docId)).reloads, { timeout: 40_000 }).toBeGreaterThanOrEqual(before.reloads + 2);
  await expect.poll(async () => (await w(app, docId)).view.restoring ?? false, { timeout: 40_000 }).toBe(false);
  let last = -2;
  let since = Date.now();
  const end = Date.now() + 40_000;
  while (Date.now() < end && Date.now() - since < 2000) {
    const cur = (await w(app, docId)).state.slide?.current ?? -1;
    if (cur !== last) {
      last = cur;
      since = Date.now();
    }
    await sleep(150);
  }
  return last;
}

test('generic-index.html at slide 5 of 6: three saves 400 ms apart keep the slide', async () => {
  const dir = scratch.dir('views-reload-thrice');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBe(6);
    for (let i = 0; i < 4; i++) await deck.key('ArrowRight');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(4);
    await sleep(500);
    expect(await threeSaves(app, deck.docId, file, 400, 0)).toBe(4);
  } finally {
    await app.close();
  }
});

test('a 24-slide index deck at slide 21: three saves 1.2 s apart keep the slide', async () => {
  const dir = scratch.dir('views-reload-thrice-24');
  const file = path.join(dir, 'long.html');
  fs.writeFileSync(file, indexDeck(24));
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('long.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBe(24);
    for (let i = 0; i < 20; i++) await deck.key('ArrowRight');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(20);
    await sleep(500);
    expect(await threeSaves(app, deck.docId, file, 1200, 0)).toBe(20);
  } finally {
    await app.close();
  }
});

test('generic-index.html at slide 5 of 6: two saves 300, 400 and 600 ms apart end on the same slide', async () => {
  const dir = scratch.dir('views-reload-twice');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBe(6);
    for (let i = 0; i < 4; i++) await deck.key('ArrowRight');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(4);
    await sleep(500);
    const ends: Record<number, number> = {};
    for (const [round, gap] of [300, 400, 600].entries()) ends[gap] = await twoSaves(app, deck.docId, file, gap, round);
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
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('long.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBe(24);
    for (let i = 0; i < 20; i++) await deck.key('ArrowRight');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(20);
    await sleep(500);
    const ends: Record<number, number> = {};
    for (const [round, gap] of [1500, 2500].entries()) ends[gap] = await twoSaves(app, deck.docId, file, gap, round);
    expect(ends).toEqual({ 1500: 20, 2500: 20 });
  } finally {
    await app.close();
  }
});
