// Present (6.9, Cmd+Option+P): the window goes full screen with the chrome hidden, the deck view fills it at Fit,
// every key but Esc goes to the deck (app chords too: the menu's accelerators are off, and main takes none from
// the deck), and Esc, caught in before-input-event, ends Present and restores the window, the layout and the
// mode it had, with the deck on the slide the presenter reached. A document presents at reading width.

import { expect, test } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';
import { READING_WIDTH } from '../../packages/core/src/ipc-views';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

interface Win {
  appMode: string;
  fullScreen: boolean;
  contentSize: [number, number];
  zoomFactor: number;
  deckBounds: { x: number; y: number; width: number; height: number };
  containerBounds: { x: number; y: number; width: number; height: number };
  view: { presenting: boolean; zoom: number };
  state: { slide: { current: number } | null; layout: Record<string, number> };
}

async function w(app: BlApp, docId: string): Promise<Win> {
  return (await app.win(docId)) as unknown as Win;
}

async function menuPresenting(app: BlApp): Promise<boolean> {
  return await app.electronApp.evaluate(() => (globalThis as unknown as { __blTest: { menu(): { presenting: boolean } } }).__blTest.menu().presenting);
}

test('Cmd+Option+P: full screen, chrome hidden, keys to the deck; Esc restores the window, the layout and the mode', async () => {
  const dir = scratch.dir('views-present');
  const file = copyInto(path.join(FIXTURES, 'decks/keys-prevent-default.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('keys-prevent-default.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(0);
    await deck.chord('2');
    await expect.poll(async () => (await w(app, deck.docId)).appMode).toBe('review');
    const before = await w(app, deck.docId);
    expect(before.state.layout.leftRail).toBe(200);
    expect(before.state.layout.rightPanel).toBe(300);
    const shell = await app.shellPage(deck.docId);

    // Cmd/Ctrl+Option/Alt+P (6.2: an app chord, so the page that swallows every key cannot keep it).
    await deck.chord('p', ['alt']);
    await expect.poll(async () => (await w(app, deck.docId)).view.presenting).toBe(true);
    let p = await w(app, deck.docId);
    expect(p.fullScreen).toBe(true);
    // Read routing while presenting (6.9: every key goes to the deck).
    expect(p.appMode).toBe('read');
    // No chrome: every bar, the rail and the panel are zero; the deck view fills the window at Fit.
    expect(Object.values(p.state.layout).every((v) => v === 0)).toBe(true);
    await expect.poll(async () => (await w(app, deck.docId)).containerBounds).toEqual({ x: 0, y: 0, width: (await w(app, deck.docId)).contentSize[0], height: (await w(app, deck.docId)).contentSize[1] });
    p = await w(app, deck.docId);
    const [cw, ch] = p.contentSize;
    expect(p.zoomFactor).toBeCloseTo(Math.min(cw / 1600, ch / 900), 2);
    expect(p.deckBounds.width === cw || p.deckBounds.height === ch).toBe(true);
    await expect(shell.locator('body')).toHaveClass(/presenting/);
    await expect(shell.locator('#toolbar')).toBeHidden();
    expect(await menuPresenting(app)).toBe(true);

    // Every key goes to the deck: the arrow moves it, and an app chord reaches the page instead of switching
    // the mode (the menu's accelerators are off, main takes no chord while presenting).
    await deck.key('ArrowRight');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(1);
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await deck.chord('3');
    await sleep(300);
    expect((await w(app, deck.docId)).appMode).toBe('read');
    expect(await deck.eval<string>('document.documentElement.dataset.pageKeys || ""')).toContain(`${mod}+3`);

    // Esc ends Present: never seen by the page, and the window, the layout and the mode come back.
    await deck.key('Escape');
    await expect.poll(async () => (await w(app, deck.docId)).view.presenting).toBe(false);
    const after = await w(app, deck.docId);
    expect(after.fullScreen).toBe(false);
    expect(after.appMode).toBe('review');
    expect(after.state.layout.leftRail).toBe(200);
    expect(after.state.layout.rightPanel).toBe(300);
    expect(after.state.layout.toolbar).toBe(44);
    // The slide the presenter reached stays.
    expect(after.state.slide?.current).toBe(1);
    expect(await deck.eval<string>('document.documentElement.dataset.pageKeys || ""')).not.toMatch(/(^| )Escape( |$)/);
    await expect(shell.locator('body')).not.toHaveClass(/presenting/);
    expect(await menuPresenting(app)).toBe(false);
  } finally {
    await app.close();
  }
});

test('the toolbar Present button presents; a document presents at reading width; leaving full screen ends Present', async () => {
  const dir = scratch.dir('views-present-doc');
  const file = copyInto(path.join(FIXTURES, 'decks/report.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('report.html');
    await expect.poll(async () => ((await app.win(deck.docId)) as unknown as { view: { kind: string | null } }).view.kind).toBe('document');
    const shell = await app.shellPage(deck.docId);
    await shell.locator('#present').click();
    await expect.poll(async () => (await w(app, deck.docId)).view.presenting).toBe(true);
    const p = await w(app, deck.docId);
    expect(p.zoomFactor).toBe(1);
    expect(p.deckBounds.width).toBe(Math.min(READING_WIDTH, p.contentSize[0]));
    expect(p.deckBounds.x).toBe(Math.floor((p.contentSize[0] - p.deckBounds.width) / 2));
    expect(p.deckBounds.height).toBe(p.contentSize[1]);
    // The system takes the window out of full screen (another app, the green button): Present ends with it.
    await app.electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.setFullScreen(false), ((await app.win(deck.docId)) as unknown as { windowId: number }).windowId);
    await expect.poll(async () => (await w(app, deck.docId)).view.presenting).toBe(false);
    expect((await w(app, deck.docId)).state.layout.toolbar).toBe(44);
  } finally {
    await app.close();
  }
});
