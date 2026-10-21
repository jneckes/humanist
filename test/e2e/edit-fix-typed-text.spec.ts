// What the author typed is never lost silently (lead decision E-2; review findings 5, 6, 7, 16, 19 and 20; SPEC 6.3
// Ending an edit, When a write fails; P2-17). Real clicks and keys on the built app, a second window kept open so
// closing the first does not quit the app:
//   - File › Close, a real Ctrl+W and a quit with an open field: main asks the deck to commit and waits, so the words
//     are in the file;
//   - a click in the shell (the notes panel, the toolbar) ends the field as a blur does, so a later external change
//     reloads the page;
//   - the file moved away, or stopped being UTF-8, while the field was open: the exact words are kept as a note;
//   - Enter, then Read 40 ms later on a large deck: the commit was accepted in Edit, so it is written.
//
// Every test needs the Edit capability: @edit in each title (the reader-only gate leaves them out).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, closeAll, externalSave, openDeck, openFieldAt, sessions, sleep, typeKeys, until, type Opened } from './edit-fix-helpers';
import { xclicker } from '../helpers/xclick';

test.describe.configure({ mode: 'serial' });

const H1 = 'Analytics your whole team can read';

async function single(name = 'deck.html'): Promise<Opened> {
  return openDeck({ fixture: path.join(FIXTURES, 'decks/single.html'), name, extra: ['other.html'] });
}

async function typedInH1(o: Opened, word: string): Promise<void> {
  await openFieldAt(o.deck, 'h1');
  await o.deck.key('End', ['control']);
  await typeKeys(o.deck, ` ${word}`);
  expect((await o.deck.editState<{ field: { text: string } | null }>()).field?.text).toBe(`${H1} ${word}`);
}

async function gone(o: Opened): Promise<void> {
  await until('the window to close', async () => ((await o.app.docIds()).includes(o.deck.docId) ? undefined : true), 15_000);
}

function editNotes(o: Opened): { kind: string; status: string }[] {
  return sessions(o.app.userData).flatMap((x) => x.json.notes ?? []);
}

test('@edit File › Close with an open field: the typed words are written before the window goes', async () => {
  const o = await single();
  try {
    await typedInH1(o, 'zqclose');
    await o.app.run('close', o.deck.docId);
    await gone(o);
    expect(fs.readFileSync(o.file, 'utf8')).toContain(`<h1>${H1} zqclose</h1>`);
    await until('the edit note saved', async () => (editNotes(o).some((n) => n.kind === 'edit') ? true : undefined));
  } finally {
    await closeAll(o);
  }
});

test('@edit a real Ctrl+W typed into the field: the words are written', async () => {
  const o = await single();
  try {
    await typedInH1(o, 'zqctrlw');
    await o.deck.key('w', ['control']).catch(() => undefined);
    await gone(o);
    expect(fs.readFileSync(o.file, 'utf8')).toContain(`<h1>${H1} zqctrlw</h1>`);
  } finally {
    await closeAll(o);
  }
});

test('@edit quitting with an open field: the words are written before the app exits', async () => {
  const o = await single();
  try {
    await typedInH1(o, 'zqquit');
    const proc = o.app.electronApp.process();
    await o.app.electronApp.evaluate(({ app }) => app.quit()).catch(() => undefined);
    await until('the app to exit', async () => (proc.exitCode !== null || proc.signalCode !== null ? true : undefined), 20_000);
    expect(fs.readFileSync(o.file, 'utf8')).toContain(`<h1>${H1} zqquit</h1>`);
    expect(editNotes(o).some((n) => n.kind === 'edit')).toBe(true);
  } finally {
    await closeAll(o);
  }
});

for (const target of ['#panel', '#toolbar'] as const) {
  test(`@edit a real click in the shell (${target === '#panel' ? 'the notes panel' : 'the toolbar'}) ends the field: written, and a later external change reloads the page`, async () => {
    const o = await single();
    try {
      await typedInH1(o, 'zqshell');
      const shell = await o.app.shellPage(o.deck.docId);
      const r = await shell.evaluate((sel) => {
        const e = document.querySelector(sel) as HTMLElement | null;
        if (!e) return null;
        const b = e.getBoundingClientRect();
        // An empty spot of it: its bottom-left corner area.
        return { x: Math.round(b.left + Math.min(12, b.width / 4)), y: Math.round(b.bottom - Math.min(12, b.height / 4)) };
      }, target);
      expect(r).not.toBeNull();
      await o.app.electronApp.evaluate(
        ({ webContents, BrowserWindow }, a) => {
          const wc = webContents.fromId(a.id)!;
          BrowserWindow.fromWebContents(wc)?.focus();
          wc.focus();
          wc.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: 'left', clickCount: 1 });
          wc.sendInputEvent({ type: 'mouseUp', x: a.x, y: a.y, button: 'left', clickCount: 1 });
        },
        { id: (await o.app.win(o.deck.docId)).shellWebContentsId, x: r!.x, y: r!.y },
      );
      await until('the write', async () => (fs.readFileSync(o.file, 'utf8').includes(`${H1} zqshell</h1>`) ? true : undefined));
      await until('the field closed', async () => ((await o.deck.editState<{ busy: { edit: boolean; committing: boolean } }>()).busy.edit ? undefined : true));
      const before = (await o.app.win(o.deck.docId)).handshakes;
      const now = fs.readFileSync(o.file, 'utf8');
      externalSave(o, now.replace('</body>', '<p id="agent">Agent paragraph</p>\n</body>'));
      await until('the reload', async () => ((await o.app.win(o.deck.docId)).handshakes > before ? true : undefined), 15_000);
      await o.deck.waitFor(`!!document.getElementById('agent')`);
    } finally {
      await closeAll(o);
    }
  });
}

// Finding 6, re-verification: a click in the shell of a window that was NOT active (the author was in another
// window) focuses the shell before the window is active, so main's shell 'focus' saw an unfocused window and the
// field stayed open ('Deck changed · reloads when you finish' for good). Real X clicks (XTEST): Electron's own focus
// calls do not give that order. Coming back by a click on the field's own text keeps it open (P2-17).
test.describe('a real click that brings the window back', () => {
  const xclick = xclicker();
  test.skip(!xclick, 'needs a real X click (test/helpers/xclick.c: Linux, a C compiler, libX11 and libXtst)');

  async function twoWindows(): Promise<{ o: Opened; back: (to: 'panel' | 'toolbar' | 'field') => Promise<void> }> {
    const o = await single();
    const other = await o.app.waitForDeck('other.html');
    const wa = await o.app.win(o.deck.docId);
    const wb = await o.app.win(other.docId);
    // Side by side on the (large) test screen, so each click lands on the window it is meant for.
    await o.app.electronApp.evaluate(
      ({ BrowserWindow }, a) => {
        BrowserWindow.fromId(a.a)!.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
        BrowserWindow.fromId(a.b)!.setBounds({ x: 2000, y: 0, width: 1100, height: 700 });
      },
      { a: wa.windowId, b: wb.windowId },
    );
    await sleep(500);
    await typedInH1(o, 'zqback');
    const bounds = (id: number) => o.app.electronApp.evaluate(({ BrowserWindow }, w) => BrowserWindow.fromId(w)!.getContentBounds(), id);
    const cbA = await bounds(wa.windowId);
    const cbB = await bounds(wb.windowId);
    const dbB = (await o.app.win(other.docId)).deckBounds;
    // Another window takes the focus: the field stays open (P2-17).
    xclick!(cbB.x + dbB.x + 30, cbB.y + dbB.y + 20);
    await sleep(800);
    expect((await o.deck.editState<{ field: { text: string } | null }>()).field?.text).toBe(`${H1} zqback`);
    const back = async (to: 'panel' | 'toolbar' | 'field') => {
      if (to === 'field') {
        const p = await o.deck.eval<{ x: number; y: number }>(`(function(){var b=document.querySelector('h1').getBoundingClientRect();return {x:b.left+10,y:b.top+b.height/2};})()`);
        const zoom = await o.app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor() ?? 1, o.deck.wcId);
        xclick!(cbA.x + wa.deckBounds.x + p.x * zoom, cbA.y + wa.deckBounds.y + p.y * zoom);
        return;
      }
      const shell = await o.app.shellPage(o.deck.docId);
      const r = await shell.evaluate((sel) => {
        const b = document.querySelector(sel)!.getBoundingClientRect();
        // An empty spot of it.
        return sel === '#panel' ? { x: b.left + b.width / 2, y: b.top + b.height * 0.7 } : { x: b.left + Math.min(12, b.width / 4), y: b.bottom - Math.min(12, b.height / 4) };
      }, to === 'panel' ? '#panel' : '#toolbar');
      xclick!(cbA.x + r.x, cbA.y + r.y);
    };
    return { o, back };
  }

  for (const to of ['panel', 'toolbar'] as const) {
    test(`@edit back from another window by a real click on the ${to === 'panel' ? 'notes panel' : 'toolbar'}: the field ends and is written`, async () => {
      const { o, back } = await twoWindows();
      try {
        await back(to);
        await until('the write', async () => (fs.readFileSync(o.file, 'utf8').includes(`${H1} zqback</h1>`) ? true : undefined), 15_000);
        await until('the field closed', async () => ((await o.deck.editState<{ busy: { edit: boolean } }>()).busy.edit ? undefined : true));
        // So a later external change reloads the page (nothing waits for a field any more).
        const before = (await o.app.win(o.deck.docId)).handshakes;
        externalSave(o, fs.readFileSync(o.file, 'utf8').replace('</body>', '<p id="agent">Agent paragraph</p>\n</body>'));
        await until('the reload', async () => ((await o.app.win(o.deck.docId)).handshakes > before ? true : undefined), 15_000);
      } finally {
        await closeAll(o);
      }
    });
  }

  test('@edit back from another window by a real click on the field\'s own text: it stays open, and Enter writes it', async () => {
    const { o, back } = await twoWindows();
    try {
      await back('field');
      await sleep(1000);
      expect((await o.deck.editState<{ field: { text: string } | null }>()).field?.text).toBe(`${H1} zqback`);
      expect(fs.readFileSync(o.file, 'utf8')).toBe(o.original);
      await o.deck.key('Enter');
      await until('the write', async () => (fs.readFileSync(o.file, 'utf8').includes(`${H1} zqback</h1>`) ? true : undefined), 15_000);
    } finally {
      await closeAll(o);
    }
  });
});

test('@edit the file moved away while the field held text: the exact words are kept as a verbatim note', async () => {
  const o = await single();
  try {
    await typedInH1(o, 'GONEWORD');
    fs.renameSync(o.file, path.join(o.dir, 'moved-away.html'));
    const notes = await until('the verbatim note', async () => {
      const n = (await o.app.win(o.deck.docId)).state.notes;
      return n.length > 0 ? n : undefined;
    }, 15_000);
    expect(notes.map((x) => [x.kind, x.status, x.before, x.after])).toEqual([['verbatim', 'open', H1, `${H1} GONEWORD`]]);
    expect(fs.readFileSync(path.join(o.dir, 'moved-away.html'), 'utf8')).toBe(o.original);
  } finally {
    await closeAll(o);
  }
});

test('@edit the file stopped being UTF-8 while the field was open: Enter keeps the exact words as a verbatim note', async () => {
  const o = await single();
  try {
    await typedInH1(o, 'BADWORD');
    const bad = Buffer.concat([Buffer.from(o.original.replace('</body>', '<!--'), 'utf8'), Buffer.from([0xe9]), Buffer.from('--></body>', 'utf8')]);
    externalSave(o, bad);
    await until('Edit unavailable', async () => ((await o.app.win(o.deck.docId)).state.edit?.available ? undefined : true), 15_000);
    if ((await o.deck.editState<{ field: unknown }>()).field) await o.deck.key('Enter');
    const notes = await until('the verbatim note', async () => {
      const n = (await o.app.win(o.deck.docId)).state.notes;
      return n.length > 0 ? n : undefined;
    }, 15_000);
    expect(notes.map((x) => [x.kind, x.before, x.after])).toEqual([['verbatim', H1, `${H1} BADWORD`]]);
    expect(fs.readFileSync(o.file).equals(bad)).toBe(true);
  } finally {
    await closeAll(o);
  }
});

test('@edit a 1.2 MB deck: Enter, then Read 40 ms later: the edit accepted in Edit is written', async () => {
  const filler = Array.from({ length: 11_000 }, (_, i) => `<p class="f" hidden>Filler paragraph number ${i} with some words to make the deck larger than usual.</p>`).join('\n');
  const src = fs.readFileSync(path.join(FIXTURES, 'decks/single.html'), 'utf8').replace('</body>', `${filler}\n</body>`);
  expect(Buffer.byteLength(src)).toBeGreaterThan(1_100_000);
  const o = await openDeck({ html: src, name: 'big.html' });
  try {
    await typedInH1(o, 'one');
    // Enter and, 40 ms later, Ctrl+1, both sent from main in one go (no test round trip between them).
    await o.app.electronApp.evaluate(
      async ({ webContents }, a) => {
        const wc = webContents.fromId(a.id)!;
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        wc.sendInputEvent({ type: 'char', keyCode: '\r' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        await new Promise((r) => setTimeout(r, 40));
        wc.sendInputEvent({ type: 'keyDown', keyCode: '1', modifiers: ['control'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: '1', modifiers: ['control'] });
      },
      { id: o.deck.wcId },
    );
    await until('the write', async () => (fs.readFileSync(o.file, 'utf8').includes(`${H1} one</h1>`) ? true : undefined), 20_000);
    const notes = await until('the edit note', async () => {
      const n = (await o.app.win(o.deck.docId)).state.notes;
      return n.length > 0 ? n : undefined;
    });
    expect(notes.map((x) => [x.kind, x.status])).toEqual([['edit', 'done']]);
    expect((await o.app.win(o.deck.docId)).appMode).toBe('read');
  } finally {
    await closeAll(o);
  }
});
