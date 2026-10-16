// Document window lifecycle in the real app (9.1 Windows and views; 6.10 Storage; 6.1 One window per file).
//
// - Finding 21: a closed window's document (its bytes, served copies and map) must not stay in main's memory
//   through the deck partition's native callbacks. Each Protected open is a new non-persistent partition that
//   Electron keeps until the app quits.
// - Finding 23: while a window closes, its deck view is gone before the window is; nothing that lists the
//   windows (the test hooks, the controller) may then read the dead deck webContents and throw.
//
// Run with `npm run test:e2e` (global setup starts Xvfb on Linux).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });
test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run through `npm run test:e2e` (its global setup starts Xvfb)');

/** A ~4 MB deck: 12 slides and a large embedded image, as a received deck often is. */
function writeBigDeck(file: string): number {
  const payload = Buffer.alloc(3 * 1024 * 1024 + 64 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) >>> 24;
  const slides = Array.from({ length: 12 }, (_, i) => `<section class="slide"><h2>Slide ${i + 1}</h2><p>Body text of slide ${i + 1}.</p></section>`).join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Big deck</title></head><body>
${slides}
<section class="slide"><h2>Picture</h2><img alt="" width="10" height="10" src="data:image/png;base64,${payload.toString('base64')}"></section>
</body></html>
`;
  fs.writeFileSync(file, html);
  return Buffer.byteLength(html);
}

/** Exposes gc() in main (BLUELINE_TEST only, through Playwright's evaluate). */
async function enableGc(app: BlApp): Promise<void> {
  await app.electronApp.evaluate(() => {
    const v8 = process.getBuiltinModule('v8');
    const vm = process.getBuiltinModule('vm');
    v8.setFlagsFromString('--expose-gc');
    (globalThis as Record<string, unknown>).__blGc = vm.runInNewContext('gc');
  });
}

/** Main-process memory after a full collection. */
async function mainMemory(app: BlApp): Promise<{ external: number; rss: number }> {
  return await app.electronApp.evaluate(async () => {
    const gc = (globalThis as Record<string, unknown>).__blGc as () => void;
    for (let i = 0; i < 4; i++) {
      gc();
      await new Promise((r) => setTimeout(r, 100));
    }
    const m = process.memoryUsage();
    return { external: m.external, rss: m.rss };
  });
}

/** Waits until a document's window is gone (closeDoc, which also tolerates a hook that throws mid-close). */
async function waitGone(app: BlApp, docId: string): Promise<void> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    if (!(await app.docIds()).includes(docId)) return;
    await sleep(50);
  }
  throw new Error(`window ${docId} did not close`);
}

test('a closed Protected window does not keep its document in main memory (finding 21)', async () => {
  test.setTimeout(240_000);
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('lifecycle');
  // A small Trusted deck keeps the app running while the big one opens and closes.
  const anchor = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  const big = path.join(dir, 'big.html');
  const size = writeBigDeck(big);
  expect(size).toBeGreaterThan(3.5 * 1024 * 1024);
  s.own(dir);
  const app = await launchApp({ files: [anchor], scratch: s });
  try {
    await app.waitForDeck('single.html');
    await enableGc(app);
    const before = await mainMemory(app);
    const seen: string[] = [];
    const rows: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const docId = await app.open(big, true);
      expect(docId, `open #${i}\n${app.logs.slice(-20).join('\n')}`).not.toBeNull();
      const deck = await app.waitForDeck('big.html', { exclude: seen });
      expect(deck.docId).toBe(docId);
      expect((await app.win(docId!)).trust).toBe('protected');
      seen.push(docId!);
      await app.closeDoc(docId!);
      await sleep(500);
      const m = await mainMemory(app);
      rows.push(`after close #${i}: external ${(m.external / 1048576).toFixed(1)} MB, rss ${(m.rss / 1048576).toFixed(1)} MB`);
    }
    const after = await mainMemory(app);
    const grown = after.external - before.external;
    const report = `deck ${(size / 1048576).toFixed(1)} MB; external ${(before.external / 1048576).toFixed(1)} → ${(after.external / 1048576).toFixed(1)} MB\n${rows.join('\n')}`;
    console.log(report);
    // Before the fix each close kept about three times the file (bytes, decoded source, served copy).
    expect(grown, `main external memory grew by ${(grown / 1048576).toFixed(1)} MB over 6 opens and closes\n${report}`).toBeLessThan(size);
    // The app still works: the anchor is open and usable.
    expect((await app.windows()).map((w) => w.fileName)).toEqual(['single.html']);
  } finally {
    await app.close();
    s.cleanup();
  }
});

test('closing one document while waiting for another never throws (finding 23)', async () => {
  test.setTimeout(240_000);
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('lifecycle');
  const a = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  const b = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  s.own(dir);
  const app = await launchApp({ files: [b], scratch: s });
  try {
    await app.waitForDeck('single.html');
    const failures: string[] = [];
    for (let i = 0; i < 20; i++) {
      const idA = await app.open(a);
      expect(idA).not.toBeNull();
      await app.waitForDeck('generic-index.html');
      await app.run('close', idA!);
      // At once, while A's window is closing: list the windows and wait for B.
      try {
        await app.waitForDeck('single.html', { timeout: 5_000 });
        const names = (await app.windows()).map((w) => w.fileName);
        if (!names.includes('single.html')) failures.push(`#${i}: B missing from ${JSON.stringify(names)}`);
      } catch (e) {
        failures.push(`#${i}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
      await waitGone(app, idA!);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  } finally {
    await app.close();
    s.cleanup();
  }
});

test('reopening a file while its window closes opens it again (6.1; finding 23)', async () => {
  test.setTimeout(180_000);
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('lifecycle');
  const a = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  const b = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  s.own(dir);
  const app = await launchApp({ files: [b], scratch: s });
  try {
    await app.waitForDeck('single.html');
    for (let i = 0; i < 5; i++) {
      const first = await app.open(a);
      expect(first).not.toBeNull();
      await app.waitForDeck('generic-index.html');
      // The reopen arrives while the window is closing: after its 'close' event (the deck view is closed), before
      // 'closed'. A slow beforeunload in the shell page (it runs after 'close') holds the window there for
      // 300 ms, so the reopen reliably lands in that gap.
      const winId = (await app.win(first!)).windowId;
      const again = await app.electronApp.evaluate(
        async ({ BrowserWindow }, o) => {
          const t = (globalThis as unknown as { __blTest: { run(a: string, id?: string): void; open(p: string): Promise<string | null> } }).__blTest;
          const bw = BrowserWindow.fromId(o.winId)!;
          await bw.webContents.executeJavaScript("addEventListener('beforeunload', () => { const t = Date.now(); while (Date.now() - t < 300) {} }); true");
          const reopened = new Promise<string | null>((resolve) => bw.once('close', () => setImmediate(() => void t.open(o.file).then(resolve))));
          t.run('close', o.docId);
          return await reopened;
        },
        { file: a, docId: first!, winId },
      );
      // A Trusted file keeps its docId; what matters is that a live window shows it again.
      expect(again, `reopen #${i}: ${app.logsMatching(/open failed/).join('\n')}`).not.toBeNull();
      const deck = await app.waitForDeck('generic-index.html', { timeout: 15_000 });
      expect(deck.docId).toBe(again);
      expect((await app.windows()).map((w) => w.fileName).sort()).toEqual(['generic-index.html', 'single.html']);
      await app.closeDoc(again!);
    }
    expect(app.logsMatching(/open failed/)).toEqual([]);
  } finally {
    await app.close();
    s.cleanup();
  }
});
