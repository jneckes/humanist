// Open in Protected View on a file that is already open (review finding 6; 6.10 When it applies: the user's
// request for Protected view; 6.1 One window per file). The window that shows the file is focused, and when it
// is not Protected view with network and editing off, it says so instead of dropping the request without a
// word. A Protected window with both off is what was asked for: it is focused, with no message.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scratch, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

const PAGE = (t: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title></head><body><h1>${t}</h1><p>A plain page.</p></body></html>`;

function files(prefix: string): { a: string; b: string } {
  const dir = scratch.dir(prefix);
  const a = path.join(dir, 'a.html');
  const b = path.join(dir, 'b.html');
  fs.writeFileSync(a, PAGE('Page A'));
  fs.writeFileSync(b, PAGE('Page B'));
  scratch.own(dir);
  return { a, b };
}

async function toast(app: BlApp, docId: string): Promise<string> {
  const shell = await app.shellPage(docId);
  return (await shell.locator('#toast').textContent().catch(() => '')) ?? '';
}

test('a file open Trusted: Open in Protected View (the API and the menu) focuses its window and says it is open Trusted', async () => {
  const { a } = files('views-open-protected');
  const app = await launchApp({ files: [a], scratch });
  try {
    const deck = await app.waitForDeck('a.html');
    expect((await app.win(deck.docId)).trust).toBe('trusted');

    // As a second launch with --protected or a link from a Protected deck asks.
    expect(await app.open(a, true)).toBe(deck.docId);
    expect((await app.windows()).map((w) => [w.fileName, w.trust])).toEqual([['a.html', 'trusted']]);
    await expect.poll(() => toast(app, deck.docId)).toBe('a.html is already open in Trusted view. Close it to open it in Protected view.');
    expect(app.logsMatching(/open in Protected view: a\.html is already open/).length).toBe(1);

    // File › Open in Protected View…, with the Open dialog answered by the file.
    await app.electronApp.evaluate(({ dialog }, f) => {
      (dialog as unknown as Record<string, unknown>).showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    }, a);
    await app.electronApp.evaluate(({ Menu, BrowserWindow }) => {
      const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File');
      const item = file?.submenu?.items.find((i) => i.label === 'Open in Protected View…');
      if (!item) throw new Error('no Open in Protected View… item');
      item.click(undefined, BrowserWindow.getAllWindows()[0], undefined as never);
    });
    await expect.poll(() => app.logsMatching(/open in Protected view: a\.html is already open/).length).toBe(2);
    expect((await app.windows()).map((w) => [w.fileName, w.trust])).toEqual([['a.html', 'trusted']]);
    expect(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null)).toBe(deck.windowId);
  } finally {
    await app.close();
  }
});

test('two opens of the same file at once, the second asking for Protected view: one window, and the request is not dropped silently', async () => {
  const { a, b } = files('views-open-protected-inflight');
  const app = await launchApp({ files: [b], scratch });
  try {
    await app.waitForDeck('b.html');
    const ids = await app.electronApp.evaluate(async (_e, f) => {
      const t = (globalThis as unknown as { __blTest: { open(p: string, prot: boolean): Promise<string | null> } }).__blTest;
      return await Promise.all([t.open(f, false), t.open(f, true)]);
    }, a);
    expect(ids[0]).toBe(ids[1]);
    const deck = await app.waitForDeck('a.html');
    expect((await app.windows()).filter((w) => w.fileName === 'a.html').length).toBe(1);
    await expect.poll(() => toast(app, deck.docId)).toContain('already open in Trusted view');
  } finally {
    await app.close();
  }
});

test('a Protected window with network and editing off: focused, no message', async () => {
  const { b } = files('views-open-protected-control');
  const app = await launchApp({ files: [b], scratch, protected: true });
  try {
    const deck = await app.waitForDeck('b.html');
    const win = await app.win(deck.docId);
    expect([win.trust, win.networkAllowed, win.editingAllowed]).toEqual(['protected', false, false]);
    expect(await app.open(b, true)).toBe(deck.docId);
    await sleep(800);
    expect(await toast(app, deck.docId)).not.toContain('already open');
    expect(app.logsMatching(/open in Protected view: b\.html is already open/)).toEqual([]);
  } finally {
    await app.close();
  }
});
