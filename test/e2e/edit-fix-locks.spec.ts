// Locks hold across a restart and across a window closed during its own write (lead decision E-7; review findings 17
// and 18; SPEC 9.2 Locked spans; P2-12). Real clicks and keys on the built app:
//   - one edit (or edit, undo, edit), quit, another program changes a line far from the edit while Blueline is
//     closed, relaunch with the same app data: the lock is ok and moved with its text (the content main knew is
//     kept for the first edit too);
//   - Enter on the heading and the window closed (File › Close, held for the answer) or destroyed (not held: the
//     write lands after the document is gone) 30 ms later, then the file opened again: each lock holds the text
//     that was written, and a later change to that text by another program is reported.
//
// Every test needs the Edit capability: @edit in each title (the reader-only gate leaves them out).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scratch, launchApp, resolveRunAs } from '../helpers/app';
import { FIXTURES, closeAll, externalSave, openDeck, openFieldAt, replaceOnce, sleep, typeKeys, until, type Opened } from './edit-fix-helpers';

test.describe.configure({ mode: 'serial' });

const single = fs.readFileSync(path.join(FIXTURES, 'decks/single.html'), 'utf8');
const BRAND = '<div class="brand">Northwind Labs</div>';
const H1 = 'Analytics your whole team can read';
const has = (f: string, s: string) => fs.readFileSync(f, 'utf8').includes(s);

async function edit(o: Opened, sel: string, word: string, onDisk: string): Promise<void> {
  await openFieldAt(o.deck, sel);
  await o.deck.key('End', ['control']);
  await typeKeys(o.deck, ` ${word}`);
  await o.deck.key('Enter');
  await until(`"${word}" on disk`, async () => (has(o.file, onDisk) ? true : undefined), 30_000);
  await sleep(600);
}

async function quit(o: Opened): Promise<void> {
  const proc = o.app.electronApp.process();
  await o.app.electronApp.evaluate(({ app }) => app.quit()).catch(() => undefined);
  await until('the app to exit', async () => (proc.exitCode !== null || proc.signalCode !== null ? true : undefined), 20_000);
}

/** Every lock is ok and covers exactly its text in `src`. */
function locksHold(locks: { start: number; end: number; text: string; state: string }[], src: string): boolean {
  return locks.every((l) => l.state === 'ok' && src.slice(l.start, l.end) === l.text);
}

for (const c of [
  { label: 'one edit', steps: ['h1'] },
  { label: 'an edit, its undo, then another edit', steps: ['h1', 'undo', '.lede'] },
  { label: 'control: two edits', steps: ['h1', '.lede'] },
]) {
  test(`@edit ${c.label}, quit, another program changes the brand line, relaunch: every lock is ok and moved with its text`, async () => {
    const s = new Scratch(resolveRunAs());
    const ud = s.dir('edit-fix-ud');
    const o = await openDeck({ html: single, name: 'deck.html', s, userData: ud });
    let relaunched: Awaited<ReturnType<typeof launchApp>> | null = null;
    try {
      let n = 0;
      for (const step of c.steps) {
        if (step === 'undo') {
          const before = fs.readFileSync(o.file, 'utf8');
          await o.deck.chord('z');
          await until('the undo on disk', async () => (fs.readFileSync(o.file, 'utf8') !== before ? true : undefined));
          await sleep(600);
          continue;
        }
        const word = `w${++n}`;
        await edit(o, step, word, step === 'h1' ? `can read ${word}</h1>` : `in the loop. ${word}</p>`);
      }
      const before = (await o.app.editInfo(o.deck.docId))!.locked;
      expect(before.length).toBeGreaterThan(0);
      expect(locksHold(before, fs.readFileSync(o.file, 'utf8'))).toBe(true);
      await quit(o);
      // Another program changes the brand line, far before the locks, while Blueline is closed.
      externalSave(o, replaceOnce(fs.readFileSync(o.file, 'utf8'), BRAND, '<div class="brand">Northwind Labs Inc.</div>'));
      relaunched = await launchApp({ files: [o.file], scratch: s, userData: ud });
      const deck = await relaunched.waitForDeck('deck.html');
      const after = await until('the locks after the relaunch', async () => {
        const l = (await relaunched!.editInfo(deck.docId))?.locked;
        return l && l.length === before.length ? l : undefined;
      });
      const src = fs.readFileSync(o.file, 'utf8');
      expect(after.map((l) => [l.noteId, l.state, l.text])).toEqual(before.map((l) => [l.noteId, 'ok', l.text]));
      expect(after.map((l) => l.start - before.find((b) => b.noteId === l.noteId)!.start)).toEqual(before.map(() => ' Inc.'.length));
      expect(locksHold(after, src)).toBe(true);
      expect(relaunched.logsMatching(/lock\(s\) flagged/)).toEqual([]);
      const panel = (await relaunched.win(deck.docId)).state.notes.filter((x) => x.kind === 'edit');
      expect(panel.every((x) => x.locked === 'ok')).toBe(true);
    } finally {
      await relaunched?.close().catch(() => undefined);
      await closeAll(o);
    }
  });
}

// File › Close is held until the deck's commit is answered (E-2), so the write lands while the document is still
// open. A window destroyed 30 ms after Enter (no 'close' event to hold) is the path E-7 is about: the write lands
// after the document is gone, and the lane still records the content and the lock (finding 18 re-verification: the
// close-only test did not reach that path).
for (const how of ['File › Close', 'the window destroyed'] as const) {
test(`@edit Enter on the heading and ${how} 30 ms later, then the file opened again: each lock holds the written text, and a later change to it is reported`, async () => {
  let filler = '';
  for (let i = 0; i < 9000; i++) filler += `  <p class="fine" style="display:none">Filler paragraph number ${i} with some words to make the deck larger than usual.</p>\n`;
  const html = single.replace('</body>', `${filler}</body>`);
  expect(Buffer.byteLength(html)).toBeGreaterThan(1_000_000);
  const o = await openDeck({ html, name: 'big.html', extra: ['other.html'] });
  try {
    await edit(o, '.lede', 'one', 'in the loop. one</p>');
    await openFieldAt(o.deck, 'h1');
    await o.deck.key('End', ['control']);
    await typeKeys(o.deck, ' two');
    await o.deck.input([{ type: 'keyDown', keyCode: 'Return' }, { type: 'keyUp', keyCode: 'Return' }]);
    await sleep(30);
    if (how === 'File › Close') await o.app.run('close', o.deck.docId);
    else {
      await o.app.electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle().includes('big.html'))
          ?.destroy();
      });
    }
    await until('E2 on disk', async () => (has(o.file, `${H1} two</h1>`) ? true : undefined), 30_000);
    await until('the window to close', async () => ((await o.app.docIds()).includes(o.deck.docId) ? undefined : true), 15_000);
    await sleep(1500);
    // The destroyed window's write landed after its document was gone: the late path ran.
    if (how === 'the window destroyed') expect(o.app.logsMatching(/own write not adopted \(big\.html was closed\)/).length).toBeGreaterThan(0);
    const id = await o.app.open(o.file);
    expect(id).not.toBeNull();
    const deck = await o.app.waitForDeck('big.html');
    const locks = await until('both locks after the reopen', async () => {
      const l = (await o.app.editInfo(deck.docId))?.locked;
      return l && l.length === 2 ? [...l].sort((a, b) => a.noteId.localeCompare(b.noteId)) : undefined;
    });
    const src = fs.readFileSync(o.file, 'utf8');
    expect(locks.map((l) => l.state)).toEqual(['ok', 'ok']);
    expect(locks[0].text.endsWith('in the loop. one')).toBe(true);
    expect(locks[1].text).toBe(`${H1} two`);
    expect(locksHold(locks, src)).toBe(true);
    // Another program changes what the author wrote: the new note's lock reports it.
    externalSave(o, replaceOnce(src, `${H1} two</h1>`, `${H1} three</h1>`));
    const flagged = await until('the heading lock flagged', async () => {
      const l = (await o.app.editInfo(deck.docId))?.locked;
      const h = l?.find((x) => x.noteId === locks[1].noteId);
      return h && h.state === 'violated' ? l : undefined;
    });
    expect(flagged.find((x) => x.noteId === locks[0].noteId)?.state).toBe('ok');
  } finally {
    await closeAll(o);
  }
});
}
