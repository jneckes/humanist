// View › Fit, 100%, Fill width (6.9 Deck view) and View › Reading Width (6.9 Document view). 100% is the design
// size at zoom 1; Fill width scales to the content width. A deck view larger than the window keeps its design-size
// viewport and scrolls inside a clipping container: the shell's scroll bars (and a wheel the page does not use)
// move it. Reading Width narrows a document's view to 960 px, centred, and is remembered per file (session.json).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';
import { READING_WIDTH, SCROLLBAR_SIZE } from '../../packages/core/src/ipc-views';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

interface Win {
  windowId: number;
  zoomFactor: number;
  deckBounds: { x: number; y: number; width: number; height: number };
  containerBounds: { x: number; y: number; width: number; height: number };
  view: { zoomMode: string; zoom: number; kind: string | null; readingWidth: boolean; deck: { x: number; y: number } };
  state: { view: { scroll: { width: number; height: number; x: number; y: number } | null; zoomMode: string } };
  sessionFile: string;
}

async function w(app: BlApp, docId: string): Promise<Win> {
  return (await app.win(docId)) as unknown as Win;
}

/** session.json's settings.readingWidth, or undefined while the file is not written yet (or mid-write). */
function readingWidthSaved(sessionFile: string): boolean | undefined {
  try {
    return (JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { settings?: { readingWidth?: boolean } }).settings?.readingWidth;
  } catch {
    return undefined;
  }
}

test('100% and Fill width: zoom 1 or the content width; a larger deck view scrolls with the shell\'s bars and the wheel', async () => {
  const dir = scratch.dir('views-zoom');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    await expect.poll(async () => (await w(app, deck.docId)).view.kind).toBe('deck');
    const fit = await w(app, deck.docId);
    expect(fit.view.zoomMode).toBe('fit');
    const area = fit.containerBounds;

    // 100%: the design size at zoom 1; 1600×900 is larger than the content area, so it scrolls.
    await app.run('zoom-actual', deck.docId);
    await expect.poll(async () => (await w(app, deck.docId)).zoomFactor).toBe(1);
    let a = await w(app, deck.docId);
    expect(a.deckBounds.width).toBe(1600);
    expect(a.deckBounds.height).toBe(900);
    expect(a.containerBounds).toEqual({ x: area.x, y: area.y, width: area.width - SCROLLBAR_SIZE, height: area.height - SCROLLBAR_SIZE });
    expect(a.state.view.scroll).toEqual({ width: 1600, height: 900, x: 0, y: 0 });
    // The new bounds and the new zoom reach the page separately; it settles at the design size.
    await expect.poll(() => deck.eval<[number, number]>('[innerWidth, innerHeight]')).toEqual([1600, 900]);
    const shell = await app.shellPage(deck.docId);
    await expect(shell.locator('#status-left')).toContainText('100% · 100%');
    await expect(shell.locator('#deck-slot')).toHaveClass(/scrolling/);

    // The shell's scroll bars move the deck view inside its container.
    await shell.locator('#deck-slot').evaluate((el) => {
      el.scrollLeft = 200;
      el.scrollTop = 30;
    });
    await expect.poll(async () => (await w(app, deck.docId)).view.deck).toMatchObject({ x: -200, y: -30 });
    a = await w(app, deck.docId);
    expect(a.deckBounds.x).toBe(area.x - 200);
    expect(a.state.view.scroll).toMatchObject({ x: 200, y: 30 });

    // A wheel the page does not use pans the view (and the bars follow).
    await deck.focus();
    await deck.input([{ type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: -100, canScroll: true }]);
    await expect.poll(async () => (await w(app, deck.docId)).view.deck.y, { timeout: 5000 }).not.toBe(-30);
    const panned = (await w(app, deck.docId)).state.view.scroll!;
    await expect.poll(async () => shell.locator('#deck-slot').evaluate((el) => el.scrollTop)).toBe(panned.y);

    // Fill width: a shorter window makes the 16:9 deck taller than the area; its vertical bar comes off the width.
    await app.electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.setContentSize(1440, 600), a.windowId);
    await app.run('zoom-fill', deck.docId);
    await expect.poll(async () => (await w(app, deck.docId)).view.zoomMode).toBe('fill');
    await sleep(300);
    const f = await w(app, deck.docId);
    expect(f.deckBounds.width).toBe(f.containerBounds.width);
    expect(f.zoomFactor).toBeCloseTo(f.containerBounds.width / 1600, 6);
    expect(f.state.view.scroll?.height).toBe(f.deckBounds.height);
    expect(f.deckBounds.height).toBeGreaterThan(f.containerBounds.height);
    await expect(shell.locator('#status-left')).toContainText('Fill width');
    await expect.poll(() => deck.eval<number>('innerWidth')).toBe(1600);

    // Back to Fit: nothing scrolls.
    await app.run('zoom-fit', deck.docId);
    await expect.poll(async () => (await w(app, deck.docId)).state.view.scroll).toBeNull();
    await expect(shell.locator('#deck-slot')).not.toHaveClass(/scrolling/);
  } finally {
    await app.close();
  }
});

test('Reading Width: a document narrows to 960 px, centred, remembered per file; decks keep their zoom commands', async () => {
  const dir = scratch.dir('views-reading');
  const file = copyInto(path.join(FIXTURES, 'decks/report.html'), dir);
  scratch.own(dir);
  let userData = '';
  {
    const app = await launchApp({ files: [file], scratch });
    userData = app.userData;
    try {
      const deck = await app.waitForDeck('report.html');
      await expect.poll(async () => (await w(app, deck.docId)).view.kind).toBe('document');
      const doc = await w(app, deck.docId);
      expect(doc.zoomFactor).toBe(1);
      expect(doc.deckBounds.width).toBe(doc.containerBounds.width);
      // The zoom commands do nothing to a document.
      await app.run('zoom-actual', deck.docId);
      await sleep(200);
      expect((await w(app, deck.docId)).view.zoomMode).toBe('fit');
      await app.run('reading-width', deck.docId);
      await expect.poll(async () => (await w(app, deck.docId)).view.readingWidth).toBe(true);
      const r = await w(app, deck.docId);
      expect(r.deckBounds.width).toBe(READING_WIDTH);
      expect(r.deckBounds.x - r.containerBounds.x).toBe(Math.floor((r.containerBounds.width - READING_WIDTH) / 2));
      await expect.poll(() => deck.eval<number>('innerWidth')).toBe(READING_WIDTH);
      // session.json exists only once the first save lands (SessionStore.open writes nothing), and expect.poll does not
      // retry a callback that throws: an absent file reads as "not yet".
      await expect.poll(() => readingWidthSaved(r.sessionFile)).toBe(true);
    } finally {
      await app.close();
    }
  }
  // Reopened: still at reading width (6.9: remembered per file).
  const app = await launchApp({ files: [file], scratch, userData });
  try {
    const deck = await app.waitForDeck('report.html');
    await expect.poll(async () => (await w(app, deck.docId)).deckBounds.width).toBe(READING_WIDTH);
    expect((await w(app, deck.docId)).view.readingWidth).toBe(true);
  } finally {
    await app.close();
  }
});
