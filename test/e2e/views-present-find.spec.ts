// Present with the Find bar open (6.9 Present: "chrome views hidden"; 6.9 Find: the highlight goes when Find
// closes; review finding 19). Presenting hides the Find bar, so it closes Find in main as Esc does: main stops
// findInPage (the active match's orange highlight leaves the slide the audience sees; the kept selection may
// stay) and clears the query, and after Present the window has no empty Find strip, the rail is the slide list
// again, and Cmd/Ctrl+F opens a working bar.

import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

interface Win {
  view: { presenting: boolean; findOpen: boolean };
  state: { slide: { current: number } | null; layout: Record<string, number>; index?: { ready: boolean } | null };
}

async function w(app: BlApp, docId: string): Promise<Win> {
  return (await app.win(docId)) as unknown as Win;
}

/** Pixels in Chromium's find active-match colour (orange, about #ff9632) in a capture of the deck view. */
async function activeMatchPixels(app: BlApp, deck: DeckView): Promise<number> {
  return await app.electronApp.evaluate(async ({ webContents }, id) => {
    const img = await webContents.fromId(id)!.capturePage();
    const bmp = img.toBitmap(); // BGRA
    let n = 0;
    for (let i = 0; i < bmp.length; i += 4) {
      const b = bmp[i];
      const g = bmp[i + 1];
      const r = bmp[i + 2];
      if (r > 235 && g > 120 && g < 180 && b < 90) n++;
    }
    return n;
  }, deck.wcId);
}

async function shellFind(shell: Page): Promise<{ barHidden: boolean; railTitle: string | null }> {
  return await shell.evaluate(() => ({
    barHidden: (document.getElementById('find-bar') as HTMLElement).hidden === true,
    railTitle: document.getElementById('rail-title')?.textContent ?? null,
  }));
}

test('Present closes an open Find: no find highlight on the presented slide, no empty Find strip after it', async () => {
  const dir = scratch.dir('views-present-find');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-hash.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-hash.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(0);
    const shell = await app.shellPage(deck.docId);
    expect(await activeMatchPixels(app, deck)).toBe(0);

    // Find a word on slide 4 and show the first result: findInPage highlights it in the deck.
    await deck.chord('f');
    await expect.poll(async () => (await w(app, deck.docId)).state.layout.findBar).toBe(36);
    await expect(shell.locator('#find-bar')).toBeVisible();
    await shell.keyboard.type('Budget');
    await expect.poll(async () => shell.locator('#result-list li.result').count(), { timeout: 60_000 }).toBeGreaterThan(0);
    await shell.keyboard.press('Enter');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1, { timeout: 15_000 }).toBe(3);
    await expect.poll(async () => await activeMatchPixels(app, deck), { timeout: 10_000 }).toBeGreaterThan(0);

    // Present (Cmd/Ctrl+Option/Alt+P): the Find bar goes with the rest of the chrome, and Find closes in main.
    await deck.chord('p', ['alt']);
    await expect.poll(async () => (await w(app, deck.docId)).view.presenting).toBe(true);
    await expect.poll(async () => (await w(app, deck.docId)).view.findOpen).toBe(false);
    await sleep(800);
    expect(await activeMatchPixels(app, deck)).toBe(0);
    expect((await w(app, deck.docId)).state.slide?.current).toBe(3);

    // Esc ends Present: no Find strip comes back, and the rail is the slide list.
    await deck.key('Escape');
    await expect.poll(async () => (await w(app, deck.docId)).view.presenting).toBe(false);
    await sleep(800);
    const after = await w(app, deck.docId);
    expect(after.view.findOpen).toBe(false);
    expect(after.state.layout.findBar).toBe(0);
    expect(await shellFind(shell)).toEqual({ barHidden: true, railTitle: 'Slides' });

    // Cmd/Ctrl+F opens a working bar again.
    await deck.chord('f');
    await expect.poll(async () => (await w(app, deck.docId)).state.layout.findBar).toBe(36);
    await expect(shell.locator('#find-bar')).toBeVisible();
    await expect.poll(async () => (await shellFind(shell)).railTitle).toBe('Results');
    await shell.keyboard.type('Budget');
    await expect.poll(async () => shell.locator('#result-list li.result').count(), { timeout: 60_000 }).toBeGreaterThan(0);
    await shell.keyboard.press('Escape');
    await expect.poll(async () => (await w(app, deck.docId)).state.layout.findBar).toBe(0);
    expect((await w(app, deck.docId)).view.findOpen).toBe(false);
  } finally {
    await app.close();
  }
});
