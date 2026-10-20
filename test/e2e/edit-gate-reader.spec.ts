// The reader-only side of the capability seam, in the running app (P2-15: "A reader-only app shows Edit as
// unavailable"; SPEC 9.6 "Read and Review must build and run with packages/editor removed"). This test has no @edit
// tag: it runs in the full build, where Cmd/Ctrl+3 enters Edit, and in the reader-only gate's build
// (scripts/reader-only-check.mjs, built without packages/editor), where Edit is refused with a toast, the deck stays
// in Read, and a click on its text opens no edit field. Which build it is comes from the build output itself: a
// reader-only build ships no dist/editor.cjs.

import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_DIR, FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep } from '../helpers/app';

const READER_ONLY = !fs.existsSync(path.join(APP_DIR, 'dist', 'editor.cjs'));

/** Records every toast the shell shows from now on. */
async function watchToasts(shell: Page): Promise<() => Promise<string[]>> {
  await shell.evaluate(() => {
    const g = globalThis as unknown as { __toasts: string[] };
    g.__toasts = [];
    const box = document.getElementById('toast')!;
    new MutationObserver(() => {
      if (box.textContent) g.__toasts.push(box.textContent);
    }).observe(box, { childList: true, characterData: true, subtree: true, attributes: true });
  });
  return () => shell.evaluate(() => (globalThis as unknown as { __toasts: string[] }).__toasts.slice());
}

test(`Cmd/Ctrl+3 ${READER_ONLY ? 'is refused with "Edit is not available" in this reader-only build' : 'enters Edit in this full build'}`, async () => {
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('edit-reader');
  const file = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  s.own(dir);
  const original = fs.readFileSync(file);
  const app = await launchApp({ files: [file], scratch: s });
  try {
    const deck = await app.waitForDeck('single.html');
    const shell = await app.shellPage(deck.docId);
    const toasts = await watchToasts(shell);
    await deck.chord('3');
    await sleep(800);
    const mode = (await app.win(deck.docId)).appMode;
    if (!READER_ONLY) {
      expect(mode).toBe('edit');
      return;
    }
    expect(mode, 'a reader-only build never enters Edit').not.toBe('edit');
    expect((await toasts()).some((t) => t.includes('Edit is not available')), `toasts: ${JSON.stringify(await toasts())}`).toBe(true);
    // A click on the deck's text opens no edit field, and nothing is ever written.
    await deck.clickSelector('h1');
    await sleep(300);
    expect(await deck.eval<boolean>('!!document.querySelector("[contenteditable]")')).toBe(false);
    expect(fs.readFileSync(file).equals(original)).toBe(true);
  } finally {
    await app.close();
    s.cleanup();
  }
});
