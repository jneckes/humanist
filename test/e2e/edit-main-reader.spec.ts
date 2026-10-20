// Edit's availability in the shell, in both builds (P2-15: "A reader-only app shows Edit as unavailable"; 6.3:
// "Edit mode is available when the Edit capability is on (D11) and editing is allowed"). No @edit tag: this runs in
// the full build and in the reader-only gate's build (scripts/reader-only-check.mjs, built without packages/editor).
// Which build it is comes from the build output itself: a reader-only build ships no dist/editor.cjs.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_DIR, FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep } from '../helpers/app';

const READER_ONLY = !fs.existsSync(path.join(APP_DIR, 'dist', 'editor.cjs'));

test(`the mode switch, View › Edit and File › History ${READER_ONLY ? 'say Edit is not available in this reader-only build; Cmd+Z has nothing to undo' : 'offer Edit for a Trusted file in this full build'}`, async () => {
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('edit-avail');
  const file = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  s.own(dir);
  const original = fs.readFileSync(file);
  const app = await launchApp({ files: [file], scratch: s });
  try {
    const deck = await app.waitForDeck('single.html');
    const shell = await app.shellPage(deck.docId);
    const editButton = shell.locator('#mode-switch button[data-mode="edit"]');
    const menu = () => app.electronApp.evaluate(() => (globalThis as unknown as { __blTest: { menu(): Record<string, unknown> } }).__blTest.menu());
    const state = (await app.win(deck.docId)).state;
    if (!READER_ONLY) {
      await expect(editButton).toBeEnabled();
      expect(state.edit).toEqual({ available: true, reason: null, enable: false });
      await expect.poll(async () => (await menu()).editAvailable).toBe(true);
      expect((await menu()).history).toBe(true);
      return;
    }
    await expect(editButton).toBeDisabled();
    await expect(editButton).toHaveAttribute('title', 'Edit is not available in this version of Blueline.');
    expect(state.edit).toEqual({ available: false, reason: 'Edit is not available in this version of Blueline.', enable: false });
    await expect.poll(async () => (await menu()).editAvailable).toBe(false);
    expect((await menu()).history).toBe(false);
    // App undo has nothing of its own to undo; nothing is ever written.
    await deck.chord('z');
    await expect.poll(() => shell.evaluate(() => document.getElementById('toast')?.textContent ?? '')).toBe('Nothing to undo');
    await sleep(300);
    expect(fs.readFileSync(file).equals(original)).toBe(true);
  } finally {
    await app.close();
    s.cleanup();
  }
});
