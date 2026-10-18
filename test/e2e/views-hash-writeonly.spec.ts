// Navigation on a deck that writes its hash but never reads it (review finding 17; 6.9 Navigation: "clicking a
// thumbnail navigates", "PageUp and PageDown work too"; 6.9 Find: "Choosing a result navigates to that slide";
// 9.4 step 2). fixtures/decks/generic-hash-writeonly.html writes #1 … #6 with history.replaceState on every move
// and reads location.hash only at load, so 9.4 takes it for a hash deck but a hash goto never moves it. Blueline
// then puts the hash back and moves it with its own keys (as the index walk does), and from then on uses the
// keys at once. Afterwards the URL hash names the slide shown. Control: generic-hash.html (which renders from
// hashchange) still navigates by hash.

import { expect, test } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

interface Win {
  appMode: string;
  state: { slide: { current: number; count: number; kind: string } | null; index: { ready: boolean } | null };
  view: { brokenGotos?: { hash?: boolean } };
}

async function w(app: BlApp, docId: string): Promise<Win> {
  return (await app.win(docId)) as unknown as Win;
}

async function current(app: BlApp, docId: string): Promise<number> {
  return (await w(app, docId)).state.slide?.current ?? -1;
}

async function show(app: BlApp, docId: string, entry: number): Promise<boolean> {
  return await app.electronApp.evaluate(
    (_e, a) => (globalThis as unknown as { __blTest: { show(d: string, n: number): Promise<boolean> } }).__blTest.show(a.id, a.n),
    { id: docId, n: entry },
  );
}

test('rail, Find and PageDown move a deck that writes its hash but never reads it; the hash then names the slide shown', async () => {
  const dir = scratch.dir('views-hash-writeonly');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-hash-writeonly.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-hash-writeonly.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBe(6);
    expect(await deck.eval<string>('location.hash')).toBe('#1');
    const shell = await app.shellPage(deck.docId);
    await expect.poll(async () => (await w(app, deck.docId)).state.index?.ready ?? false, { timeout: 60_000 }).toBe(true);

    // A real click on slide 5's thumbnail: the hash goto does nothing, the fallback presses the deck's keys.
    await expect.poll(async () => shell.locator('#slide-list li.slide button').count()).toBe(6);
    await shell.locator('#slide-list li.slide[data-slide="4"] button').click();
    await expect.poll(() => current(app, deck.docId), { timeout: 20_000 }).toBe(4);
    await expect.poll(() => deck.eval<string>('location.hash')).toBe('#5');
    expect(await deck.eval<string>('document.getElementById("pager").textContent')).toBe('5 / 6');
    // Remembered for the document: the next goto uses keys at once.
    expect((await w(app, deck.docId)).view.brokenGotos?.hash).toBe(true);

    // __blTest.show (as the rail calls it): back to slide 2, quickly this time.
    const t0 = Date.now();
    expect(await show(app, deck.docId, 1)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await current(app, deck.docId)).toBe(1);
    expect(await deck.eval<string>('location.hash')).toBe('#2');

    // Find: a word only on slide 5, chosen through main as the shell does.
    const r = (await app.electronApp.evaluate(
      (_e, id) => (globalThis as unknown as { __blTest: { find(d: string, q: string): unknown } }).__blTest.find(id, 'thistle'),
      deck.docId,
    )) as { pending: boolean; hits: { slide: number; matchIndex: number }[] };
    expect(r.pending).toBe(false);
    expect(r.hits.map((h) => h.slide)).toEqual([4]);
    const ok = await app.electronApp.evaluate(
      (_e, a) => (globalThis as unknown as { __blTest: { findShow(d: string, s: number, m: number): Promise<boolean> } }).__blTest.findShow(a.id, a.s, a.m),
      { id: deck.docId, s: r.hits[0].slide, m: r.hits[0].matchIndex },
    );
    expect(ok).toBe(true);
    expect(await current(app, deck.docId)).toBe(4);
    expect(await deck.eval<string>('location.hash')).toBe('#5');

    // PageDown in Read: the deck ignores it, so Blueline steps one slide.
    await deck.key('PageDown');
    await expect.poll(() => current(app, deck.docId), { timeout: 10_000 }).toBe(5);
    expect(await deck.eval<string>('location.hash')).toBe('#6');
    // PageUp and PageDown in Review (the key router keeps them from the deck; Blueline steps).
    await app.run('mode-review', deck.docId);
    await expect.poll(async () => (await w(app, deck.docId)).appMode).toBe('review');
    await deck.key('PageUp');
    await expect.poll(() => current(app, deck.docId), { timeout: 10_000 }).toBe(4);
    await deck.key('PageUp');
    await expect.poll(() => current(app, deck.docId), { timeout: 10_000 }).toBe(3);
    await deck.key('PageDown');
    await expect.poll(() => current(app, deck.docId), { timeout: 10_000 }).toBe(4);
    expect(await deck.eval<string>('location.hash')).toBe('#5');
    expect((await w(app, deck.docId)).appMode).toBe('review');
  } finally {
    await app.close();
  }
});

test('control: a deck that reads its hash still navigates by hash', async () => {
  const dir = scratch.dir('views-hash-control');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-hash.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-hash.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBe(5);
    await expect.poll(async () => (await w(app, deck.docId)).state.index?.ready ?? false, { timeout: 60_000 }).toBe(true);
    expect(await show(app, deck.docId, 3)).toBe(true);
    expect(await current(app, deck.docId)).toBe(3);
    expect(await deck.eval<string>('location.hash')).toBe('#budget');
    expect((await w(app, deck.docId)).view.brokenGotos?.hash ?? false).toBe(false);
  } finally {
    await app.close();
  }
});
