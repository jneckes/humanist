// Opening files (6.1): File › Open Recent lists every file that opened and reopens it; a file dropped on the
// shell's areas opens; a file dropped on the deck view is refused before the page sees it (9.1: a deck view never
// gives main a path) and the view does not navigate; the trust bar's Allow network is remembered in trust.json for
// the file while its internet marker is the same (6.10), and dropped with a new marker; the trust bar's overflow
// and Help show the Protected view help; Settings… opens Settings.
//
// Drops are trusted drags made with the DevTools protocol (Input.dispatchDragEvent with a file path), the way
// Chromium sees a drag from the desktop. Markers come from BLUELINE_TEST_MARKERS (markers.ts; Linux has none).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, ROOT, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

/** A trusted file drag onto a webContents at (x, y): dragEnter, dragOver, drop (CDP Input.dispatchDragEvent). */
async function dropFile(app: BlApp, wcId: number, file: string, x: number, y: number): Promise<void> {
  await app.electronApp.evaluate(
    async ({ webContents }, a) => {
      const wc = webContents.fromId(a.id)!;
      const dbg = wc.debugger;
      const attached = dbg.isAttached();
      if (!attached) dbg.attach('1.3');
      try {
        const data = { items: [], files: [a.file], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
          await dbg.sendCommand('Input.dispatchDragEvent', { type, x: a.x, y: a.y, data });
        }
      } finally {
        if (!attached) dbg.detach();
      }
    },
    { id: wcId, file, x, y },
  );
}

async function menuLabels(app: BlApp, top: string, sub?: string): Promise<string[]> {
  return await app.electronApp.evaluate(
    ({ Menu }, a) => {
      const m = Menu.getApplicationMenu();
      const t = m?.items.find((i) => i.label === a.top);
      let items = t?.submenu?.items ?? [];
      if (a.sub) items = items.find((i) => i.label === a.sub)?.submenu?.items ?? [];
      return items.map((i) => i.label);
    },
    { top, sub },
  );
}

async function clickMenu(app: BlApp, top: string, sub: string, label: string): Promise<void> {
  await app.electronApp.evaluate(
    ({ Menu, BrowserWindow }, a) => {
      const m = Menu.getApplicationMenu();
      const s = m?.items.find((i) => i.label === a.top)?.submenu?.items.find((i) => i.label === a.sub);
      const item = s?.submenu?.items.find((i) => i.label === a.label);
      if (!item) throw new Error(`no menu item ${a.label}`);
      item.click(undefined, BrowserWindow.getAllWindows()[0], undefined as never);
    },
    { top, sub, label },
  );
}

test('File › Open Recent lists every file that opened and reopens it', async () => {
  const dir = scratch.dir('views-recent');
  const a = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  const b = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [a], scratch });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    await app.open(b);
    await app.waitForDeck('single.html');
    await expect.poll(() => menuLabels(app, 'File', 'Open Recent')).toEqual(expect.arrayContaining(['single.html', 'generic-index.html']));
    expect((await menuLabels(app, 'File', 'Open Recent'))[0]).toBe('single.html');
    // recent.json follows the menu: the menu is built from the list in memory (recent.ts commit), and the file is
    // written after it through a coalescing atomic write, so it is polled until the second open's write lands
    // (one read could come before it: the hardening round's full run once read the first open's list).
    const recentFile = path.join(app.userData, 'recent.json');
    const stored = (): string[] | null => {
      try {
        return (JSON.parse(fs.readFileSync(recentFile, 'utf8')) as { files: string[] }).files;
      } catch {
        return null;
      }
    };
    await expect.poll(stored, { timeout: 15_000 }).toEqual([fs.realpathSync(b), fs.realpathSync(a)]);
    // Close the first, then reopen it from the menu.
    await app.closeDoc(deck.docId);
    expect((await app.windows()).some((w) => w.fileName === 'generic-index.html')).toBe(false);
    await clickMenu(app, 'File', 'Open Recent', 'generic-index.html');
    // A Trusted file keeps its docId across opens (6.10 Storage), so the reopened window has the same one.
    const again = await app.waitForDeck('generic-index.html');
    expect((await app.windows()).filter((w) => w.fileName === 'generic-index.html')).toHaveLength(1);
    expect(again.wcId).not.toBe(deck.wcId);
    // Its rail fills again: the first window's walk, cut short by its close, does not stand in for a new one.
    await expect
      .poll(async () => ((await app.win(again.docId)) as unknown as { state: { index: { ready: boolean } | null } }).state.index?.ready ?? false, { timeout: 30_000 })
      .toBe(true);
    expect(app.logsMatching(/showed the overlay/)).toEqual([]);
  } finally {
    await app.close();
  }
});

test('a file dropped on the shell opens; one dropped on the deck view is refused before the page sees it', async () => {
  const dir = scratch.dir('views-drop');
  const a = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  const b = copyInto(path.join(FIXTURES, 'decks/report.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [a], scratch });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    const win = await app.win(deck.docId);
    // The page records any drag event that reaches it.
    await deck.eval(
      `(function(){ window.__drops = []; ['dragenter','dragover','drop'].forEach(function(t){ window.addEventListener(t, function(e){ window.__drops.push(t); }, true); document.addEventListener(t, function(e){ window.__drops.push('doc:' + t); }, true); }); return true; })()`,
    );
    const url = await deck.url();
    // On the deck view: refused in the preload's capture phase (drop-guard.ts); main only hears "refused".
    await dropFile(app, win.deckWebContentsId, b, 300, 300);
    await sleep(800);
    expect(await deck.eval<string[]>('window.__drops')).toEqual([]);
    expect(await deck.url()).toBe(url);
    expect((await app.windows()).some((w) => w.fileName === 'report.html')).toBe(false);
    const shell = await app.shellPage(deck.docId);
    await expect(shell.locator('#toast')).toContainText('drop it on the toolbar or the slide rail');
    // On the shell (the rail): it opens as File › Open does.
    await dropFile(app, win.shellWebContentsId, b, 100, 300);
    await app.waitForDeck('report.html');
  } finally {
    await app.close();
  }
});

test("the trust bar's Allow network is remembered while the file's marker is the same, and dropped with a new one", async () => {
  const dir = scratch.dir('views-trust');
  const file = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  scratch.own(dir);
  // The markers file is read on every open (markers.ts testMarker): the test changes it between opens.
  const markersDir = path.join(ROOT, 'test-results', 'views-open');
  fs.mkdirSync(markersDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(path.join(ROOT, 'test-results'), 0o755);
  const markers = path.join(markersDir, `markers-${process.pid}.json`);
  const real = fs.realpathSync(file);
  fs.writeFileSync(markers, JSON.stringify({ [real]: '0083;6720f2a1;Safari;AAAA' }), { mode: 0o644 });
  let userData = '';
  try {
    {
      const app = await launchApp({ files: [file], scratch, env: { BLUELINE_TEST_MARKERS: markers } });
      userData = app.userData;
      try {
        const deck = await app.waitForDeck('single.html');
        let w = await app.win(deck.docId);
        expect(w.trust).toBe('protected');
        expect(w.networkAllowed).toBe(false);
        const shell = await app.shellPage(deck.docId);
        await shell.locator('#allow-network').click();
        await expect.poll(async () => (await app.win(deck.docId)).networkAllowed).toBe(true);
        w = await app.win(deck.docId);
        expect(w.trust).toBe('protected');
        const trust = path.join(app.userData, 'trust.json');
        await expect
          .poll(() => (fs.existsSync(trust) ? (JSON.parse(fs.readFileSync(trust, 'utf8')) as { files: Record<string, { allowNetwork: boolean; marker: string }> }).files[real] : null))
          .toMatchObject({ allowNetwork: true, marker: '0083;6720f2a1;Safari;AAAA' });
        // The trust bar's overflow and Help › About Protected View show 6.10's help.
        await app.run('about-protected', deck.docId);
        await expect.poll(async () => (await app.harness()).dialogs.some((d) => d.message === 'About Protected view')).toBe(true);
      } finally {
        await app.close();
      }
    }
    {
      // Same marker: opens Protected with the network allowed at once.
      const app = await launchApp({ files: [file], scratch, userData, env: { BLUELINE_TEST_MARKERS: markers } });
      try {
        const deck = await app.waitForDeck('single.html');
        const w = await app.win(deck.docId);
        expect(w.trust).toBe('protected');
        expect(w.networkAllowed).toBe(true);
        expect(w.state.trustBarVisible).toBe(true);
      } finally {
        await app.close();
      }
    }
    {
      // A new download over the same path brings a new marker: Protected again, nothing allowed (6.10).
      fs.writeFileSync(markers, JSON.stringify({ [real]: '0083;6720f2b7;Safari;BBBB' }), { mode: 0o644 });
      const app = await launchApp({ files: [file], scratch, userData, env: { BLUELINE_TEST_MARKERS: markers } });
      try {
        const deck = await app.waitForDeck('single.html');
        const w = await app.win(deck.docId);
        expect(w.trust).toBe('protected');
        expect(w.networkAllowed).toBe(false);
      } finally {
        await app.close();
      }
    }
  } finally {
    fs.rmSync(markers, { force: true });
  }
});

test('Settings… opens the Settings window (Edit › Settings… with Ctrl+, on Linux and Windows)', async () => {
  const dir = scratch.dir('views-settings');
  const file = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    await app.waitForDeck('single.html');
    const edit = await menuLabels(app, 'Edit');
    expect(edit).toContain('Settings…');
    await app.run('settings');
    await expect.poll(() => app.electronApp.windows().some((p) => p.url().startsWith('app://shell/settings.html'))).toBe(true);
    // Help has the Phase 1 items.
    expect(await menuLabels(app, 'Help')).toEqual(expect.arrayContaining(['About Protected View', 'Welcome to Blueline', 'Install Command Line Tool…', 'Run Diagnostics']));
  } finally {
    await app.close();
  }
});
