// Find (6.9, Cmd+F): the Find bar in the shell; results by slide from the slide index, which holds the text of
// every slide, shown or not; choosing a result navigates to that slide, then highlights the match with
// findInPage; Esc closes the bar (stopFindInPage keeps the match selected). Typing in the Find bar never reaches
// the deck (the keyboard is the shell's). A document's results scroll the page to the match.

import { expect, test } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

interface Win {
  state: { slide: { current: number } | null; layout: { findBar: number; leftRail: number }; index: { ready: boolean } | null };
}

async function w(app: BlApp, docId: string): Promise<Win> {
  return (await app.win(docId)) as unknown as Win;
}

test('Find lists text from a slide that is not showing, goes there and highlights it; typing never reaches the deck', async () => {
  const dir = scratch.dir('views-find');
  const file = copyInto(path.join(FIXTURES, 'decks/keys-prevent-default.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('keys-prevent-default.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(0);
    const shell = await app.shellPage(deck.docId);

    // Cmd/Ctrl+F from the deck (an app chord: the page that swallows every key cannot keep it).
    await deck.chord('f');
    await expect.poll(async () => (await w(app, deck.docId)).state.layout.findBar).toBeGreaterThan(0);
    await expect(shell.locator('#find-bar')).toBeVisible();
    await expect.poll(() => shell.evaluate(() => document.activeElement?.id ?? '')).toBe('find-input');
    const keysBefore = await deck.eval<string>('document.documentElement.dataset.pageKeys || ""');

    // Typed into the shell's own page: the deck's key log does not change.
    await shell.keyboard.type('your card');
    await expect.poll(async () => shell.locator('#result-list li.result').count(), { timeout: 60_000 }).toBe(1);
    expect(await deck.eval<string>('document.documentElement.dataset.pageKeys || ""')).toBe(keysBefore);
    await expect(shell.locator('#result-list .result-group')).toHaveText(/^Slide 4/);
    await expect(shell.locator('#result-list .result mark')).toHaveText('your card');
    await expect(shell.locator('#find-status')).toHaveText('1 result on 1 slide');
    // The rail shows the results while Find is open.
    await expect(shell.locator('#rail-title')).toHaveText('Results');

    // Enter chooses the first result: the deck goes to slide 4 and findInPage highlights the match.
    await shell.keyboard.press('Enter');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1, { timeout: 15_000 }).toBe(3);
    await expect(shell.locator('#result-list li.result')).toHaveAttribute('aria-current', 'true');
    await sleep(300);
    await expect(shell.locator('#find-status')).not.toHaveText(/not on screen/);
    // Esc closes the bar; the highlighted match stays selected in the page (stopFindInPage('keepSelection')).
    await shell.keyboard.press('Escape');
    await expect.poll(async () => (await w(app, deck.docId)).state.layout.findBar).toBe(0);
    await expect.poll(() => deck.eval<string>('String(getSelection())')).toBe('your card');
    // The keys typed in the Find bar, Enter and Esc included, never reached the deck: the only keys it saw since
    // are main's own ArrowRight presses that moved it to slide 4 (an index deck, 6.7 Index replay).
    const after = (await deck.eval<string>('document.documentElement.dataset.pageKeys || ""')).slice(keysBefore.length).trim();
    expect(after.split(' ').filter(Boolean)).toEqual(['ArrowRight', 'ArrowRight', 'ArrowRight']);
  } finally {
    await app.close();
  }
});

test('Find on a document: answered (or pending while the index is built), then a hit scrolls the page to the match', async () => {
  const dir = scratch.dir('views-find-doc');
  const file = copyInto(path.join(FIXTURES, 'decks/report.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('report.html');
    // Ask through main (as the shell does) as soon as the window exists: pending, or answered.
    const first = await app.electronApp.evaluate((_e, id) => (globalThis as unknown as { __blTest: { find(d: string, q: string): unknown } }).__blTest.find(id, 'interview guide'), deck.docId);
    expect(first).toMatchObject({ query: 'interview guide' });
    // Before the index of this version exists the answer is pending (the shell shows Indexing… and asks again on
    // indexReady); after, it has hits.
    const f = first as { pending: boolean; hits: unknown[] };
    expect(f.pending || f.hits.length > 0).toBe(true);
    await expect.poll(async () => (await w(app, deck.docId)).state.index?.ready ?? false, { timeout: 30_000 }).toBe(true);
    const r = (await app.electronApp.evaluate((_e, id) => (globalThis as unknown as { __blTest: { find(d: string, q: string): unknown } }).__blTest.find(id, 'interview guide'), deck.docId)) as {
      pending: boolean;
      hits: { slide: number; matchIndex: number; text: string }[];
    };
    expect(r.pending).toBe(false);
    expect(r.hits.length).toBeGreaterThan(0);
    const last = r.hits[r.hits.length - 1];
    expect(await deck.eval<number>('scrollY')).toBe(0);
    const ok = await app.electronApp.evaluate(
      (_e, a) => (globalThis as unknown as { __blTest: { findShow(d: string, s: number, m: number): Promise<boolean> } }).__blTest.findShow(a.id, a.slide, a.m),
      { id: deck.docId, slide: last.slide, m: last.matchIndex },
    );
    expect(ok).toBe(true);
    // findInPage scrolled the document to the match (a document is one page, 6.9 Find).
    await expect.poll(() => deck.eval<number>('scrollY')).toBeGreaterThan(200);
  } finally {
    await app.close();
  }
});
