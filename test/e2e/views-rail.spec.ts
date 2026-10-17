// The left rail (6.0, 6.9 Navigation): thumbnails filled by background renders, the current slide highlighted,
// a click navigating through slide.nav (index decks by the deck's own keys, hash decks by their hash); PageUp and
// PageDown working in decks whose engine ignores them; the outline of a document, a click scrolling to its
// heading; and View › Hide Slides, remembered for the next window.

import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

interface Win {
  state: { slide: { current: number; count: number } | null; layout: { leftRail: number }; view: { railHidden: boolean; kind: string | null } };
}

async function current(app: BlApp, docId: string): Promise<number> {
  return ((await app.win(docId)) as unknown as Win).state.slide?.current ?? -1;
}

/** A deck that moves only on ArrowRight and ArrowLeft (it ignores PageUp and PageDown). */
const ARROWS_ONLY = `<!doctype html><html><head><meta charset="utf-8"><title>Arrows only</title><style>
html,body{margin:0;height:100%;overflow:hidden;font:40px system-ui}
section{position:absolute;inset:0;display:none;padding:80px}
section.on{display:block}
</style></head><body>
<section class="on"><h1>One</h1></section><section><h1>Two</h1></section><section><h1>Three</h1></section><section><h1>Four</h1></section>
<script>
var s=[].slice.call(document.querySelectorAll('section')),i=0;
function show(n){i=Math.max(0,Math.min(s.length-1,n));s.forEach(function(e,k){e.classList.toggle('on',k===i)})}
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'){e.preventDefault();show(i+1)}else if(e.key==='ArrowLeft'){e.preventDefault();show(i-1)}});
</script></body></html>`;

async function railButtons(shell: Page): Promise<number> {
  return await shell.locator('#slide-list li.slide button').count();
}

test('the rail fills with thumbnails; clicking one navigates (index deck: the deck\'s own keys); the current slide is highlighted', async () => {
  const dir = scratch.dir('views-rail');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    const shell = await app.shellPage(deck.docId);
    await expect.poll(() => railButtons(shell)).toBe(6);
    // Placeholders first, then one PNG per slide as each arrives (6.9: filled by background renders).
    await expect.poll(async () => shell.locator('#slide-list .thumb img').count(), { timeout: 60_000 }).toBe(6);
    const srcs = await shell.locator('#slide-list .thumb img').evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
    for (const src of srcs) expect(src).toMatch(new RegExp(`^app://shell/thumbs/${deck.docId}/[0-9a-f]{64}-\\d+-152\\.png$`));
    await expect(shell.locator('#slide-list li[aria-current="true"]')).toHaveAttribute('data-slide', '0');

    // A click on slide 5's thumbnail: generic-index moves by keys (navKind index), replayed by main.
    await shell.locator('#slide-list li.slide[data-slide="4"] button').click();
    await expect.poll(() => current(app, deck.docId), { timeout: 20_000 }).toBe(4);
    await expect(shell.locator('#slide-list li[aria-current="true"]')).toHaveAttribute('data-slide', '4');
    expect(await deck.eval<string>('document.getElementById("pager").textContent')).toBe('05 / 06');
    // Back to slide 2.
    await shell.locator('#slide-list li.slide[data-slide="1"] button').click();
    await expect.poll(() => current(app, deck.docId), { timeout: 20_000 }).toBe(1);
    // The keyboard is the deck's after a rail click (6.2 Read: every key to the deck).
    await deck.key('ArrowRight');
    await expect.poll(() => current(app, deck.docId)).toBe(2);
    // In Review the rail navigates too (the key router lets main's replayed keys through).
    await app.run('mode-review', deck.docId);
    await shell.locator('#slide-list li.slide[data-slide="5"] button').click();
    await expect.poll(() => current(app, deck.docId), { timeout: 20_000 }).toBe(5);
    expect(((await app.win(deck.docId)) as unknown as { appMode: string }).appMode).toBe('review');
  } finally {
    await app.close();
  }
});

test('a hash deck navigates by its hash; a reveal.js deck by Reveal.slide', async () => {
  const dir = scratch.dir('views-rail-hash');
  const hashDeck = copyInto(path.join(FIXTURES, 'decks/generic-hash.html'), dir);
  const reveal = copyInto(path.join(FIXTURES, 'decks/reveal-hash'), dir, 'reveal-hash');
  scratch.own(dir);
  const app = await launchApp({ files: [hashDeck], scratch });
  try {
    const deck = await app.waitForDeck('generic-hash.html');
    await expect.poll(async () => ((await app.win(deck.docId)) as unknown as Win).state.slide?.count ?? 0).toBeGreaterThan(3);
    // Before the index is ready the visible view's own report (SlideState.hashes) is used; after it, the index.
    const ok = await app.electronApp.evaluate((_e, id) => (globalThis as unknown as { __blTest: { show(d: string, n: number): Promise<boolean> } }).__blTest.show(id, 3), deck.docId);
    expect(ok).toBe(true);
    expect(await current(app, deck.docId)).toBe(3);
    expect(await deck.eval<string>('location.hash')).not.toBe('');

    const rid = await app.open(path.join(reveal, 'index.html'));
    const rdeck = await app.waitForDeck('index.html');
    expect(rdeck.docId).toBe(rid);
    await expect.poll(async () => ((await app.win(rdeck.docId)) as unknown as Win).state.slide?.count ?? 0, { timeout: 20_000 }).toBeGreaterThan(3);
    const shell = await app.shellPage(rdeck.docId);
    await expect.poll(() => railButtons(shell)).toBeGreaterThan(3);
    await shell.locator('#slide-list li.slide[data-slide="2"] button').click();
    await expect.poll(() => current(app, rdeck.docId), { timeout: 15_000 }).toBe(2);
    expect(await rdeck.eval<number>('Reveal.getIndices().h')).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

test('PageDown and PageUp work in a deck that ignores them (Read: the deck has them first; Review: Blueline steps)', async () => {
  const dir = scratch.dir('views-pagekeys');
  const file = path.join(dir, 'arrows.html');
  fs.writeFileSync(file, ARROWS_ONLY);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('arrows.html');
    await expect.poll(async () => ((await app.win(deck.docId)) as unknown as Win).state.slide?.count ?? 0).toBe(4);
    await deck.key('PageDown');
    await expect.poll(() => current(app, deck.docId), { timeout: 5000 }).toBe(1);
    await deck.key('PageDown');
    await expect.poll(() => current(app, deck.docId), { timeout: 5000 }).toBe(2);
    await deck.key('PageUp');
    await expect.poll(() => current(app, deck.docId), { timeout: 5000 }).toBe(1);
    // A deck that handles PageDown itself (generic-index) moves once, not twice: covered by the rail test's deck.
    // Review: the key router keeps PageDown from the deck (6.2 step 5); Blueline steps the slide.
    await deck.chord('2');
    await expect.poll(async () => ((await app.win(deck.docId)) as unknown as { appMode: string }).appMode).toBe('review');
    await deck.key('PageDown');
    await expect.poll(() => current(app, deck.docId), { timeout: 5000 }).toBe(2);
    await sleep(800);
    expect(await current(app, deck.docId)).toBe(2);
  } finally {
    await app.close();
  }
});

test('a deck that uses PageDown itself is not stepped twice', async () => {
  const dir = scratch.dir('views-pagekeys-own');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    await expect.poll(async () => ((await app.win(deck.docId)) as unknown as Win).state.slide?.count ?? 0).toBe(6);
    await deck.key('PageDown');
    await expect.poll(() => current(app, deck.docId)).toBe(1);
    await sleep(1200);
    expect(await current(app, deck.docId)).toBe(1);
  } finally {
    await app.close();
  }
});

test('a document gets an outline from h1–h3; a click scrolls to its heading; Hide Slides is remembered', async () => {
  const dir = scratch.dir('views-outline');
  const file = copyInto(path.join(FIXTURES, 'decks/report.html'), dir);
  const other = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('report.html');
    const shell = await app.shellPage(deck.docId);
    await expect(shell.locator('#rail-title')).toHaveText('Outline');
    await expect.poll(async () => shell.locator('#outline-list button').count(), { timeout: 20_000 }).toBeGreaterThan(5);
    const titles = await shell.locator('#outline-list button').allTextContents();
    expect(titles).toContain('Recommendations');
    expect(await deck.eval<number>('scrollY')).toBe(0);
    await shell.locator('#outline-list button', { hasText: 'Recommendations' }).click();
    await expect
      .poll(async () => deck.eval<number>('Math.round([].slice.call(document.querySelectorAll("h1,h2,h3")).find(function(h){return h.textContent.trim()==="Recommendations"}).getBoundingClientRect().top)'))
      .toBeLessThan(5);
    expect(await deck.eval<number>('scrollY')).toBeGreaterThan(100);

    // View › Hide Outline: the rail goes; config.json remembers it for the next window.
    await app.run('toggle-rail', deck.docId);
    await expect.poll(async () => ((await app.win(deck.docId)) as unknown as Win).state.layout.leftRail).toBe(0);
    const cfg = path.join(app.userData, 'config.json');
    await expect.poll(() => (fs.existsSync(cfg) ? (JSON.parse(fs.readFileSync(cfg, 'utf8')) as { railHidden?: boolean }).railHidden : undefined)).toBe(true);
    const id2 = await app.open(other);
    await app.waitForDeck('generic-index.html');
    expect(((await app.win(id2!)) as unknown as Win).state.layout.leftRail).toBe(0);
    expect(((await app.win(id2!)) as unknown as Win).state.view.railHidden).toBe(true);
    await app.run('toggle-rail', id2!);
    await expect.poll(async () => ((await app.win(id2!)) as unknown as Win).state.layout.leftRail).toBe(200);
  } finally {
    await app.close();
  }
});
