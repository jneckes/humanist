// Edit › Undo in Blueline's own text fields (review finding 21; 6.2: Cmd+Z goes to native undo while a text
// field has focus; 9.2 Undo step 5). Undo and Redo are custom menu items, so on macOS Cmd+Z reaches a field only
// through the item's click. In the shell's Find input and in the Settings host input that click undoes the
// typing, with no app-undo toast. The macOS route is run here by calling the item's click() from main while the
// field has focus (Linux and Windows handle Ctrl+Z in the page itself). Outside a field it is app undo (Phase 2,
// P2-10): with no write of the document's own to undo it says "Nothing to undo" (edit-session.ts).

import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';

/** App undo with nothing to undo (packages/app/src/main/edit-session.ts NOTHING_TO_UNDO, NOTHING_TO_REDO). */
const APP_UNDO = { undo: 'Nothing to undo', redo: 'Nothing to redo' } as const;

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

/** Runs the application menu's Edit › Undo (or Redo) item, as Cmd+Z does on macOS. */
async function menuEdit(app: BlApp, label: 'Undo' | 'Redo'): Promise<void> {
  await app.electronApp.evaluate(({ Menu }, l) => {
    const edit = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Edit');
    const item = edit?.submenu?.items.find((i) => i.label === l);
    if (!item) throw new Error(`no Edit › ${l}`);
    (item.click as unknown as () => void)();
  }, label);
  await sleep(400);
}

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

test('Edit › Undo in the Find input and in the Settings host input undoes the typing, with no app-undo toast', async () => {
  const dir = scratch.dir('views-undo-fields');
  const file = copyInto(path.join(FIXTURES, 'decks/keys-prevent-default.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('keys-prevent-default.html');
    const win = await app.win(deck.docId);
    const shell = await app.shellPage(deck.docId);
    const toasts = await watchToasts(shell);

    // The shell's Find input.
    await app.run('find', deck.docId);
    await expect.poll(() => shell.evaluate(() => document.activeElement?.id ?? '')).toBe('find-input');
    await shell.keyboard.type('quarterly revenue');
    for (let i = 0; i < 'revenue'.length; i++) await shell.keyboard.press('Backspace');
    const value = () => shell.evaluate(() => (document.getElementById('find-input') as HTMLInputElement).value);
    expect(await value()).toBe('quarterly ');
    expect(await app.electronApp.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.id ?? null)).toBe(win.shellWebContentsId);
    await menuEdit(app, 'Undo');
    await expect.poll(value).toBe('quarterly revenue');
    await menuEdit(app, 'Redo');
    await expect.poll(value).toBe('quarterly ');
    expect(await toasts()).not.toContain(APP_UNDO.undo);
    expect(await toasts()).not.toContain(APP_UNDO.redo);

    // Settings › Trust: the allowlist's host input.
    await app.run('settings');
    let settings: Page | undefined;
    await expect.poll(() => (settings = app.electronApp.windows().find((p) => p.url().includes('settings'))) !== undefined, { timeout: 15_000 }).toBe(true);
    const page = settings!;
    await page.waitForLoadState('domcontentloaded');
    if (!(await page.locator('#host-input').isVisible().catch(() => false))) {
      const tab = page.locator('[role=tab]', { hasText: /Trust/i });
      if (await tab.count()) await tab.first().click();
    }
    await page.locator('#host-input').click();
    await page.keyboard.type('cdn.example.com');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
    expect(await page.locator('#host-input').inputValue()).toBe('cdn.example');
    await menuEdit(app, 'Undo');
    await expect.poll(() => page.locator('#host-input').inputValue()).toBe('cdn.example.com');
    expect(await toasts()).not.toContain(APP_UNDO.undo);

    // The deck view keeps its rule: outside a deck text field, Undo is app undo (nothing to undo here).
    await page.close();
    await expect
      .poll(async () => {
        await deck.focus();
        return await app.electronApp.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.id ?? null);
      })
      .toBe(win.deckWebContentsId);
    await menuEdit(app, 'Undo');
    await expect.poll(toasts).toContain(APP_UNDO.undo);
  } finally {
    await app.close();
  }
});

test('Edit › Undo while the shell is focused with no text field (a toolbar or letterbox click) is app undo, not a no-op (review finding 21 re-verification)', async () => {
  const dir = scratch.dir('views-undo-shell');
  const file = copyInto(path.join(FIXTURES, 'decks/keys-prevent-default.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('keys-prevent-default.html');
    const win = await app.win(deck.docId);
    const shell = await app.shellPage(deck.docId);
    const toasts = await watchToasts(shell);
    // Give the shell the keyboard with no editable element focused (as after a click on the toolbar or
    // letterbox): document.activeElement is the body.
    await shell.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      if (a && a !== document.body) a.blur();
    });
    await app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)?.focus(), win.shellWebContentsId);
    await expect.poll(() => app.electronApp.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.id ?? null)).toBe(win.shellWebContentsId);
    expect(await shell.evaluate(() => document.activeElement?.tagName ?? '')).toBe('BODY');
    await menuEdit(app, 'Undo');
    await expect.poll(toasts).toContain(APP_UNDO.undo);
    await menuEdit(app, 'Redo');
    await expect.poll(toasts).toContain(APP_UNDO.redo);
  } finally {
    await app.close();
  }
});
