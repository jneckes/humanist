// The Find bar keeps the keyboard (review finding 18; 6.9 Find; 6.2: single-letter keys in Review). Choosing a
// result on an index deck makes main press the deck's own keys (6.7 Index replay), which needs the deck view
// focused; afterwards the keyboard goes back to the webContents that had it (the shell), so Enter goes on to
// the next result and letters land in the Find input, never in the deck (in Review, N would make a note). An
// auto-reload while the Find bar is open leaves the keyboard in the shell too.
//
// Keys here are sent to whatever webContents has focus (webContents.getFocusedWebContents().sendInputEvent), as
// the OS keyboard reaches the focused view; Playwright's shell.keyboard would type into the shell page directly
// and could not see the loss.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scratch, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

/** An index deck (no hash), the word "quokka" on slides 2, 4 and 5; it logs every key it gets on <html>. */
const DECK = `<!doctype html><html><head><meta charset="utf-8"><title>Animals</title><style>
html,body{margin:0;height:100%;overflow:hidden;font:40px system-ui}
.slide{position:absolute;inset:0;display:none;padding:80px}.slide.on{display:block}
</style></head><body>
<div class="slide on"><h1>Animals</h1><p>An overview</p></div>
<div class="slide"><h2>Marsupials</h2><p>The quokka smiles</p></div>
<div class="slide"><h2>Birds</h2><p>The kea is clever</p></div>
<div class="slide"><h2>Islands</h2><p>Rottnest has a quokka</p></div>
<div class="slide"><h2>Photos</h2><p>One more quokka</p></div>
<script>
var s=[].slice.call(document.querySelectorAll('.slide')),i=0;
function show(n){i=Math.max(0,Math.min(s.length-1,n));s.forEach(function(e,k){e.classList.toggle('on',k===i)})}
document.addEventListener('keydown',function(e){
  var d=document.documentElement.dataset;d.pageKeys=(d.pageKeys||'')+' '+e.key;
  if(e.key==='ArrowRight'){e.preventDefault();show(i+1)}else if(e.key==='ArrowLeft'){e.preventDefault();show(i-1)}
});
</script></body></html>`;

interface Win {
  shellWebContentsId: number;
  deckWebContentsId: number;
  handshakes: number;
  appMode: string;
  state: { slide: { current: number; count: number } | null; index: { ready: boolean } | null; notes: unknown[]; layout: { findBar: number } };
}

async function w(app: BlApp, docId: string): Promise<Win> {
  return (await app.win(docId)) as unknown as Win;
}

async function focusedId(app: BlApp): Promise<number | null> {
  return await app.electronApp.evaluate(() => (globalThis as unknown as { __blTest: { focusedWebContentsId(): number | null } }).__blTest.focusedWebContentsId());
}

/** One key (an accelerator name, or one character) to the focused webContents, as the OS keyboard sends it. */
async function osKey(app: BlApp, key: string): Promise<void> {
  await app.electronApp.evaluate(({ webContents }, k) => {
    const wc = webContents.getFocusedWebContents();
    if (!wc) throw new Error('no focused webContents');
    wc.sendInputEvent({ type: 'keyDown', keyCode: k });
    if (k.length === 1) wc.sendInputEvent({ type: 'char', keyCode: k });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k });
  }, key);
  await sleep(60);
}

async function osType(app: BlApp, text: string): Promise<void> {
  for (const ch of text) await osKey(app, ch);
}

function writeDeck(prefix: string): string {
  const dir = scratch.dir(prefix);
  const file = path.join(dir, 'animals.html');
  fs.writeFileSync(file, DECK);
  scratch.own(dir);
  return file;
}

async function openFindAndType(app: BlApp, docId: string, query: string): Promise<void> {
  await app.run('find', docId);
  await expect.poll(async () => (await w(app, docId)).state.layout.findBar).toBeGreaterThan(0);
  await expect.poll(() => focusedId(app)).toBe((await w(app, docId)).shellWebContentsId);
  await osType(app, query);
}

test('after a result on an index deck the keyboard is back in the Find bar: Enter goes on, letters land in the input', async () => {
  const file = writeDeck('views-find-focus');
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('animals.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.index?.ready ?? false, { timeout: 60_000 }).toBe(true);
    const shell = await app.shellPage(deck.docId);
    const ids = await w(app, deck.docId);
    await openFindAndType(app, deck.docId, 'quokka');
    await expect.poll(async () => shell.locator('#result-list li.result').count(), { timeout: 30_000 }).toBe(3);
    const keysBefore = await deck.eval<string>('document.documentElement.dataset.pageKeys || ""');

    await osKey(app, 'Enter');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => focusedId(app)).toBe(ids.shellWebContentsId);
    // Enter again: the next result (slide 4).
    await osKey(app, 'Enter');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1, { timeout: 15_000 }).toBe(3);
    await expect.poll(() => focusedId(app)).toBe(ids.shellWebContentsId);
    // Letters go to the Find input.
    await osType(app, 'zz');
    await expect.poll(() => shell.evaluate(() => (document.getElementById('find-input') as HTMLInputElement).value)).toBe('quokkazz');
    // The deck saw only main's own ArrowRight presses.
    const seen = (await deck.eval<string>('document.documentElement.dataset.pageKeys || ""')).slice(keysBefore.length).trim().split(' ').filter(Boolean);
    expect(seen.every((k) => k === 'ArrowRight')).toBe(true);
  } finally {
    await app.close();
  }
});

test('in Review, N typed after choosing a result goes to the Find input and makes no note', async () => {
  const file = writeDeck('views-find-focus-review');
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('animals.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.index?.ready ?? false, { timeout: 60_000 }).toBe(true);
    await app.run('mode-review', deck.docId);
    await expect.poll(async () => (await w(app, deck.docId)).appMode).toBe('review');
    const shell = await app.shellPage(deck.docId);
    await openFindAndType(app, deck.docId, 'quokka');
    await expect.poll(async () => shell.locator('#result-list li.result').count(), { timeout: 30_000 }).toBe(3);
    await osKey(app, 'Enter');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1, { timeout: 15_000 }).toBe(1);
    await expect.poll(async () => focusedId(app)).toBe((await w(app, deck.docId)).shellWebContentsId);
    await osKey(app, 'n');
    await expect.poll(() => shell.evaluate(() => (document.getElementById('find-input') as HTMLInputElement).value)).toBe('quokkan');
    await sleep(400);
    expect((await w(app, deck.docId)).state.notes).toEqual([]);
  } finally {
    await app.close();
  }
});

test('an auto-reload while the Find bar is open leaves the keyboard in the shell', async () => {
  const file = writeDeck('views-find-focus-reload');
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('animals.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBe(5);
    const shell = await app.shellPage(deck.docId);
    await openFindAndType(app, deck.docId, 'quo');
    const before = await w(app, deck.docId);
    // Someone else saves the file: a rename over it.
    const tmp = path.join(path.dirname(file), '.animals.html.swp');
    fs.writeFileSync(tmp, DECK.replace('An overview', 'An overview, revised'));
    scratch.own(tmp);
    fs.renameSync(tmp, file);
    await expect.poll(async () => (await w(app, deck.docId)).handshakes, { timeout: 15_000 }).toBe(before.handshakes + 1);
    await sleep(800);
    expect(await focusedId(app)).toBe(before.shellWebContentsId);
    await osType(app, 'kka');
    await expect.poll(() => shell.evaluate(() => (document.getElementById('find-input') as HTMLInputElement).value)).toBe('quokka');
  } finally {
    await app.close();
  }
});
