// Undo waits for the writes in flight, and the Saved toast lives in the shell (lead decisions E-3 and E-5; review
// findings 14 and 8; SPEC 6.2 Cmd+Z, 6.3 Saving, 9.2 Undo and redo; P2-10, P2-14). Real keys and clicks on the
// built app:
//   - Ctrl+Z pressed while the newest commit is still being written undoes that commit (it is queued behind it in
//     the document's lane), never the edit before it, and Ctrl+Shift+Z brings it back;
//   - after a literal write the page reloads, and the shell's "Saved · deck.html:<line> · also changes 1 other
//     place" is still there, with an Undo that restores the file.
//
// Every test needs the Edit capability: @edit in each title (the reader-only gate leaves them out).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, closeAll, externalSave, openDeck, openFieldAt, sleep, typeKeys, until, type Opened } from './edit-fix-helpers';

test.describe.configure({ mode: 'serial' });

const single = fs.readFileSync(path.join(FIXTURES, 'decks/single.html'), 'utf8');
const E1 = 'can read one</h1>';
const E2 = 'in the loop. two</p>';
const has = (f: string, s: string) => fs.readFileSync(f, 'utf8').includes(s);

function big(n: number): string {
  let f = '';
  for (let i = 0; i < n; i++) f += `  <p class="fine" style="display:none">Filler paragraph number ${i} with some words to make the deck larger than usual.</p>\n`;
  return single.replace('</body>', `${f}</body>`);
}

/** E1 on the heading (written), then E2 on .lede: Enter and, `gapMs` later, Ctrl+Z, sent from main in one go. */
async function race(o: Opened, gapMs: number): Promise<void> {
  await openFieldAt(o.deck, 'h1');
  await o.deck.key('End', ['control']);
  await typeKeys(o.deck, ' one');
  await o.deck.key('Enter');
  await until('E1 on disk', async () => (has(o.file, E1) ? true : undefined), 60_000);
  await until('E1 in the undo stack', async () => ((await o.app.editInfo(o.deck.docId))?.undo.undo === 1 ? true : undefined));
  await sleep(500);
  await openFieldAt(o.deck, '.lede');
  await o.deck.key('End', ['control']);
  await typeKeys(o.deck, ' two');
  await o.app.electronApp.evaluate(
    async ({ webContents }, a) => {
      const wc = webContents.fromId(a.id)!;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await new Promise((r) => setTimeout(r, a.gap));
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['control'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['control'] });
    },
    { id: o.deck.wcId, gap: gapMs },
  );
}

async function settledStack(o: Opened, want: { undo: number; redo: number }): Promise<void> {
  await until(`the undo stack ${JSON.stringify(want)}`, async () => {
    const u = (await o.app.editInfo(o.deck.docId))?.undo;
    return u && u.undo === want.undo && u.redo === want.redo ? true : undefined;
  }, 30_000);
}

for (const c of [
  { label: 'a 3.7 KB deck, Ctrl+Z 15 ms after Enter', src: single, gap: 15 },
  { label: 'a 500 KB deck, Ctrl+Z 200 ms after Enter', src: big(4000), gap: 200 },
]) {
  test(`@edit ${c.label}: the commit just made is undone, the earlier edit stays, and redo restores it`, async () => {
    const o = await openDeck({ html: c.src, name: 'deck.html' });
    try {
      await race(o, c.gap);
      await settledStack(o, { undo: 1, redo: 1 });
      expect(has(o.file, E1)).toBe(true);
      expect(has(o.file, E2)).toBe(false);
      const notes = (await o.app.win(o.deck.docId)).state.notes;
      expect(notes.map((n) => [n.kind, n.after])).toEqual([['edit', 'Analytics your whole team can read one']]);
      await o.deck.chord('z', ['shift']);
      await settledStack(o, { undo: 2, redo: 0 });
      expect(has(o.file, E1)).toBe(true);
      expect(has(o.file, E2)).toBe(true);
    } finally {
      await closeAll(o);
    }
  });
}

/** The shell's toast as the user sees it: its text and whether it has a button. */
async function shellToast(o: Opened): Promise<{ text: string; button: boolean; visible: boolean }> {
  const shell = await o.app.shellPage(o.deck.docId);
  return await shell.evaluate(() => ({
    text: document.querySelector('#toast .toast-text')?.textContent ?? '',
    button: !!document.querySelector('#toast .toast-action'),
    visible: !!document.querySelector('#toast.visible'),
  }));
}

test('@edit a literal shown twice: after the reload the shell still says "Saved · deck.html:56 · also changes 1 other place", and its Undo restores the file', async () => {
  const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/edit-overlay.html'), name: 'deck.html' });
  try {
    const before = (await o.app.win(o.deck.docId)).handshakes;
    await openFieldAt(o.deck, '#rep1');
    await o.deck.key('End', ['control']);
    await typeKeys(o.deck, ' X');
    await o.deck.key('Enter');
    await until('the literal write', async () => (has(o.file, "'Repeated label X'") ? true : undefined));
    await until('the reload', async () => ((await o.app.win(o.deck.docId)).handshakes > before ? true : undefined));
    await sleep(2500);
    const t = await shellToast(o);
    expect(t).toEqual({ text: 'Saved · deck.html:56 · also changes 1 other place', button: true, visible: true });
    // The overlay shows no second copy.
    expect((await o.deck.editState<{ toast: string }>()).toast).toBe('');
    const shell = await o.app.shellPage(o.deck.docId);
    await shell.click('#toast .toast-action');
    await until('the file restored', async () => (fs.readFileSync(o.file, 'utf8') === o.original ? true : undefined));
  } finally {
    await closeAll(o);
  }
});

test('@edit control: an html-text edit shows the shell\'s Saved toast too, with no reload', async () => {
  const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/edit-overlay.html'), name: 'deck.html' });
  try {
    const before = (await o.app.win(o.deck.docId)).handshakes;
    await openFieldAt(o.deck, '#title');
    await o.deck.key('End', ['control']);
    await typeKeys(o.deck, ' 2027');
    await o.deck.key('Enter');
    await until('the write', async () => (has(o.file, 'Quarterly review 2027') ? true : undefined));
    const t = await until('the shell toast', async () => {
      const x = await shellToast(o);
      return x.text.startsWith('Saved') ? x : undefined;
    });
    expect(t.text).toMatch(/^Saved · deck\.html:\d+$/);
    expect(t.button).toBe(true);
    await sleep(1500);
    expect((await o.app.win(o.deck.docId)).handshakes).toBe(before);
  } finally {
    await closeAll(o);
  }
});

// Finding 7/20 re-verification: when the deck changed on disk while a field was open, the overlay's "Not changed in
// place … your text is kept as a note" was taken away by the reload that follows the answer, so the author was not
// told their words were kept. That toast is the shell's now (main-driven, as Saved is, E-5).
test('@edit the field\'s run was rewritten by another program while it was open: the shell says the text is kept as a note, after the reload too', async () => {
  const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/edit-overlay.html'), name: 'deck.html' });
  try {
    await openFieldAt(o.deck, '#title');
    await o.deck.key('End', ['control']);
    await typeKeys(o.deck, ' 2027');
    const before = (await o.app.win(o.deck.docId)).handshakes;
    const title = await o.deck.eval<string>(`document.getElementById('title').textContent`);
    // Another program rewrites the very text being edited: the commit cannot be placed, and a reload is due.
    const agent = o.original.replace(`>${title.replace(/ 2027$/, '')}<`, '>Agent title<');
    expect(agent).not.toBe(o.original);
    externalSave(o, agent);
    await sleep(1500);
    await o.deck.key('Enter');
    await until('the verbatim note', async () => ((await o.app.win(o.deck.docId)).state.notes.some((n) => n.kind === 'verbatim') ? true : undefined));
    await until('the reload', async () => ((await o.app.win(o.deck.docId)).handshakes > before ? true : undefined), 15_000);
    await sleep(1000);
    const t = await shellToast(o);
    expect(t.text).toMatch(/^Not changed in place: .* · your text is kept as a note$/);
    expect(t.visible).toBe(true);
    expect((await o.deck.editState<{ toast: string }>()).toast).toBe('');
    expect(fs.readFileSync(o.file, 'utf8')).toBe(agent);
  } finally {
    await closeAll(o);
  }
});

