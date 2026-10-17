// Auto-reload (6.1, 6.6 Reload, 9.2 Watcher): an external change (an editor's rename-replace) rebuilds the
// document's map and version and reloads the deck view in place, on the same slide; Blueline's own writes set
// knownHash and never reload; a reload waits while a card has unsaved input ("Deck changed · reloads when you
// finish") and happens when the card closes; a file that goes away shows a banner and the window keeps the last
// version, read-only, until it comes back.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, loopAround, resolveRunAs, sleep, type BlApp } from '../helpers/app';
import { RELOAD_DEFERRED_TEXT, fileGoneText } from '../../packages/core/src/ipc-files';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

interface Win {
  handshakes: number;
  reloads: number;
  reloadStatus: string | null;
  zoomFactor: number;
  appMode: string;
  editingAllowed: boolean;
  state: { slide: { current: number; count: number } | null; banner: string | null; status: { reloadDeferred: boolean; fileGone: boolean } };
}

async function w(app: BlApp, docId: string): Promise<Win> {
  return (await app.win(docId)) as unknown as Win;
}

/** An editor's save: write a temp file next to it, then rename it over the deck (a new inode). */
function renameReplace(file: string, text: string, s: Scratch): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.swp`);
  fs.writeFileSync(tmp, text);
  s.own(tmp);
  fs.renameSync(tmp, file);
}

test('an external rename-replace reloads the deck in place, on the same slide; Blueline\'s own write does not reload', async () => {
  const dir = scratch.dir('views-reload');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBe(6);
    await deck.key('ArrowRight');
    await deck.key('ArrowRight');
    await deck.key('ArrowRight');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(3);
    const zoom = (await w(app, deck.docId)).zoomFactor;
    const before = await w(app, deck.docId);

    // Someone else's save (an editor, an agent): a rename over the file.
    const src = fs.readFileSync(file, 'utf8');
    renameReplace(file, src.replace('Pipeline by stage', 'Pipeline by region'), scratch);
    await expect.poll(async () => (await w(app, deck.docId)).handshakes, { timeout: 15_000 }).toBe(before.handshakes + 1);
    await expect.poll(() => deck.eval<string>('document.body.textContent'), { timeout: 10_000 }).toContain('Pipeline by region');
    // The same slide again (an index deck: main replays its keys after the reload, 6.6).
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1, { timeout: 15_000 }).toBe(3);
    expect(await deck.eval<string>('document.getElementById("pager").textContent')).toBe('04 / 06');
    expect((await w(app, deck.docId)).reloads).toBe(1);
    // The view keeps its zoom (the deck view's isolated zoom survives the reload).
    expect((await w(app, deck.docId)).zoomFactor).toBeCloseTo(zoom, 6);

    // Blueline's own write (the write queue's atomic write sets knownHash): no reload.
    const h = (await w(app, deck.docId)).handshakes;
    await app.electronApp.evaluate(
      async (_e, a) => (globalThis as unknown as { __blTest: { ownWrite(d: string, t: string): Promise<void> } }).__blTest.ownWrite(a.id, a.text),
      { id: deck.docId, text: fs.readFileSync(file, 'utf8').replace('Pipeline by region', 'Pipeline by team') },
    );
    expect(fs.readFileSync(file, 'utf8')).toContain('Pipeline by team');
    await sleep(2500);
    const after = await w(app, deck.docId);
    expect(after.handshakes).toBe(h);
    expect(after.reloads).toBe(1);
    expect(await deck.eval<string>('document.body.textContent')).toContain('Pipeline by region');
  } finally {
    await app.close();
  }
});

test('a hash deck reloads on its slide; the slide index is rebuilt for the new version', async () => {
  const dir = scratch.dir('views-reload-hash');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-hash.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-hash.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.count ?? 0).toBeGreaterThan(3);
    await deck.key('ArrowRight');
    await deck.key('ArrowRight');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(2);
    const hash = await deck.eval<string>('location.hash');
    expect(hash).not.toBe('');
    const before = await w(app, deck.docId);
    renameReplace(file, fs.readFileSync(file, 'utf8').replace('</body>', '<!-- revised -->\n</body>'), scratch);
    await expect.poll(async () => (await w(app, deck.docId)).handshakes, { timeout: 15_000 }).toBe(before.handshakes + 1);
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1, { timeout: 10_000 }).toBe(2);
    expect(await deck.eval<string>('location.hash')).toBe(hash);
    // The index is rebuilt for the new version.
    await expect.poll(async () => ((await app.win(deck.docId)) as unknown as { state: { index: { ready: boolean; version: string } | null } }).state.index?.ready ?? false, { timeout: 30_000 }).toBe(true);
  } finally {
    await app.close();
  }
});

test('a reload waits while a card has unsaved input, and happens when the card closes', async () => {
  const dir = scratch.dir('views-reload-card');
  const file = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('single.html');
    await deck.chord('2');
    await expect.poll(async () => (await w(app, deck.docId)).appMode).toBe('review');
    await sleep(300);
    await deck.key('1');
    await deck.drag(loopAround({ x: 300, y: 180, w: 170, h: 110 }, 12));
    await sleep(400);
    const h = (await w(app, deck.docId)).handshakes;
    // Keep typing (a draft main has not seen yet: the card saves 300 ms after the last input, 6.5) while the file
    // changes on disk.
    let typing = true;
    const typer = (async () => {
      while (typing) {
        await deck.insertText('a');
        await sleep(80);
      }
    })();
    await sleep(300);
    renameReplace(file, fs.readFileSync(file, 'utf8').replace('</body>', '<!-- changed -->\n</body>'), scratch);
    await expect.poll(async () => (await w(app, deck.docId)).reloadStatus, { timeout: 10_000 }).toBe(RELOAD_DEFERRED_TEXT);
    const shell = await app.shellPage(deck.docId);
    await expect(shell.locator('#status-right')).toContainText(RELOAD_DEFERRED_TEXT);
    typing = false;
    await typer;
    // Saved, but the card is still open: the reload still waits for it to close (6.6).
    await sleep(1200);
    expect((await w(app, deck.docId)).handshakes).toBe(h);
    expect((await w(app, deck.docId)).reloadStatus).toBe(RELOAD_DEFERRED_TEXT);
    // Esc closes the card: the reload happens, the notice goes.
    await deck.key('Escape');
    await expect.poll(async () => (await w(app, deck.docId)).handshakes, { timeout: 15_000 }).toBe(h + 1);
    await expect.poll(async () => (await w(app, deck.docId)).reloadStatus).toBeNull();
    expect(await deck.eval<string>('document.documentElement.outerHTML')).toContain('<!-- changed -->');
    // Review's reduced motion (main/motion.ts) and the trust state survive the reload.
    expect(await deck.eval<boolean>('matchMedia("(prefers-reduced-motion: reduce)").matches')).toBe(true);
    expect((await app.win(deck.docId)).trust).toBe('trusted');
    // The draft was kept: the note has the typed text.
    const sessionFile = ((await app.win(deck.docId)) as unknown as { sessionFile: string }).sessionFile;
    const notes = (JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { notes: { text: string }[] }).notes;
    expect(notes[0].text).toMatch(/^a+$/);
  } finally {
    await app.close();
  }
});

test('a file that goes away: a banner, the last version stays read-only; it comes back, and so does Edit', async () => {
  const dir = scratch.dir('views-reload-gone');
  const file = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('single.html');
    const bytes = fs.readFileSync(file);
    fs.renameSync(file, path.join(dir, 'moved-away.html'));
    await expect.poll(async () => (await w(app, deck.docId)).state.banner, { timeout: 10_000 }).toBe(fileGoneText('single.html'));
    expect((await w(app, deck.docId)).state.status.fileGone).toBe(true);
    // The window keeps showing the last version.
    expect(await deck.eval<number>('document.body.textContent.length')).toBeGreaterThan(10);
    await app.run('mode-edit', deck.docId);
    await sleep(200);
    expect((await w(app, deck.docId)).appMode).not.toBe('edit');
    // Back with the same bytes: the banner goes, Edit works again, nothing reloads.
    const h = (await w(app, deck.docId)).handshakes;
    fs.writeFileSync(file, bytes);
    scratch.own(file);
    await expect.poll(async () => (await w(app, deck.docId)).state.banner, { timeout: 10_000 }).toBeNull();
    await app.run('mode-edit', deck.docId);
    await expect.poll(async () => (await w(app, deck.docId)).appMode).toBe('edit');
    expect((await w(app, deck.docId)).handshakes).toBe(h);
  } finally {
    await app.close();
  }
});
