// Edit mode in the deck preload (Phase 2 overlay item; SPEC 6.3, 9.2 Committing an edit 1–5, P2-5 to P2-9, P2-17):
// the field, its input rules, commits and what main answers. Main's edit wiring is replaced by a stub that records
// what the deck sends and answers as main would (edit-overlay-harness.ts); the end-to-end path with the real
// queue is the integration step's.

import { expect, test } from '@playwright/test';
import { sleep } from '../helpers/app';
import { clickText, editState, hover, newScratch, nextMessage, openEditDeck, pageSeen, stubLog, textRect, toDeck } from './edit-overlay-harness';

test.describe.configure({ mode: 'serial' });

const scratch = newScratch();
test.afterAll(() => scratch.cleanup());

test('@edit hover outlines: solid on exact text, dashed on ambiguous text, none on text that is not editable', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    // The outline drawn around the hovered node: its kind, and whether it surrounds that node's text.
    const at = async (sel: string): Promise<string | null> => {
      const r = await textRect(deck, sel);
      await hover(deck, r.x + r.w / 2, r.y + r.h / 2);
      const o = (await editState(deck)).outline;
      if (!o) return null;
      const around = o.x <= r.x && o.y <= r.y && o.x + o.w >= r.x + r.w && o.y + o.h >= r.y + r.h;
      return around ? o.kind : `elsewhere:${o.kind}`;
    };
    await expect.poll(() => at('#title')).toBe('solid');
    await expect.poll(() => at('#inline')).toBe('solid');
    await expect.poll(() => at('#rep1')).toBe('solid');
    // Two literals with the same text, and a copy of the heading's text: the picker can offer them.
    await expect.poll(() => at('#twin')).toBe('dashed');
    await expect.poll(() => at('#toc')).toBe('dashed');
    // Computed text: no outline.
    await expect.poll(() => at('#count')).toBeNull();
    // Off any text: no outline.
    const box = await deck.rect('#box');
    await hover(deck, box!.x + box!.w - 4, box!.y + box!.h - 4);
    await expect.poll(async () => (await editState(deck)).outline).toBeNull();
  } finally {
    await app.close();
  }
});

test('@edit a click opens a field the page never sees; typing, Enter commits the run; the result puts the file text back (the Saved toast is the shell\'s, E-5)', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    const before = { pointerdown: await pageSeen(deck, 'pointerdown'), mousedown: await pageSeen(deck, 'mousedown'), click: await pageSeen(deck, 'click') };
    await clickText(deck, '#title', 0, 0.98);
    const s = await editState(deck);
    expect(s.field?.tag).toBe('h1');
    expect(s.field?.runs.length).toBe(1);
    const begin = await nextMessage(app, 'bl:edit:begin', 0);
    expect(begin.p.runIds).toEqual([s.field!.runs[0].runId]);
    expect(begin.p.version).toBe(s.pageVersion);
    expect(await deck.eval('document.activeElement && document.activeElement.id')).toBe('title');
    expect(await deck.eval(`document.getElementById('title').getAttribute('contenteditable')`)).toBe('plaintext-only');
    // P2-17: the press never reached the page's listeners.
    expect(await pageSeen(deck, 'pointerdown')).toBe(before.pointerdown);
    expect(await pageSeen(deck, 'mousedown')).toBe(before.mousedown);
    expect(await pageSeen(deck, 'click')).toBe(before.click);

    await deck.key('End');
    await deck.insertText(' 2027');
    await expect.poll(async () => (await editState(deck)).field?.text).toBe('Quarterly review 2027');
    // P2-7: the page never sees the field's keys or input.
    expect(await pageSeen(deck, 'beforeinput')).toBe(0);
    expect(await pageSeen(deck, 'input')).toBe(0);
    expect(await pageSeen(deck, 'keydown')).toBe(0);
    await deck.key('Enter');
    const commit = await nextMessage(app, 'bl:edit:commit', 0);
    expect(commit.p.fieldId).toBe(begin.p.fieldId);
    expect(commit.p.version).toBe(s.pageVersion);
    expect(commit.p.result).toEqual({ kind: 'edit', runId: s.field!.runs[0].runId, beforeText: 'Quarterly review', afterText: 'Quarterly review 2027' });
    expect(commit.p.alsoPlaces).toBe(0);
    expect((commit.p.target as { role: string }).role).toBe('heading');
    let st = await editState(deck);
    expect(st.field).toBeNull();
    expect(st.busy).toEqual({ edit: false, committing: true });
    // Enter's insertParagraph never reaches the page either.
    expect(await pageSeen(deck, 'beforeinput')).toBe(0);
    expect(await pageSeen(deck, 'keydown')).toBe(0);
    expect(await deck.eval(`document.getElementById('title').hasAttribute('contenteditable')`)).toBe(false);

    await toDeck(app, deck, 'bl:edit:result', { fieldId: commit.p.fieldId, outcome: 'written', text: 'Quarterly review 2027', line: 24, strategy: 'html-text', reload: false, token: 'tok-abcdefgh' });
    await expect.poll(async () => (await editState(deck)).busy).toEqual({ edit: false, committing: false });
    st = await editState(deck);
    // E-5 (review finding 8): "Saved · <file>:<line>" and its Undo are main's toast in the shell, which a reload
    // cannot take away; the overlay shows no second copy.
    expect(st.toast).toBe('');
    expect(st.toastAction).toBe(false);
    expect(await deck.eval(`document.getElementById('title').textContent`)).toBe('Quarterly review 2027');
    const busy = (await stubLog(app, 'bl:edit:busy')).map((m) => m.p);
    expect(busy).toEqual([
      { edit: true, committing: false },
      { edit: false, committing: true },
      { edit: false, committing: false },
    ]);
    // The reload rules' busy state (6.6) stays set from the press until main answered: it never reads idle between
    // the field closing and the commit's result.
    const files = (await stubLog(app, 'bl:files:busy')).map((m) => (m.p as { edit: boolean }).edit);
    expect(files.slice(-2)).toEqual([true, false]);
  } finally {
    await app.close();
  }
});

test('@edit Esc cancels: the text, the case and the selection rules go back; nothing is sent', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    // 6.3 Source case: an uppercase heading shows the case the file stores while it is edited.
    await clickText(deck, '#upper');
    let s = await editState(deck);
    expect(s.field?.tag).toBe('h2');
    expect(s.badge).toBe('Showing source case');
    expect(await deck.eval(`getComputedStyle(document.getElementById('upper')).textTransform`)).toBe('none');
    await deck.insertText('XY');
    await expect.poll(async () => (await editState(deck)).field?.text).toContain('XY');
    await deck.key('Escape');
    s = await editState(deck);
    expect(s.field).toBeNull();
    expect(s.badge).toBeNull();
    expect(await deck.eval(`document.getElementById('upper').textContent`)).toBe('Source case heading');
    expect(await deck.eval(`getComputedStyle(document.getElementById('upper')).textTransform`)).toBe('uppercase');
    expect(await deck.eval(`document.getElementById('upper').hasAttribute('style')`)).toBe(false);
    expect(await deck.eval(`document.getElementById('upper').hasAttribute('contenteditable')`)).toBe(false);

    // P2-17: user-select: none is lifted while the text is edited, and put back.
    await clickText(deck, '#noselect');
    expect(await deck.eval(`getComputedStyle(document.getElementById('noselect')).userSelect`)).toBe('text');
    await deck.key('Escape');
    expect(await deck.eval(`getComputedStyle(document.getElementById('noselect')).userSelect`)).toBe('none');
    expect(await deck.eval(`document.getElementById('noselect').hasAttribute('style')`)).toBe(false);
    expect(await stubLog(app, 'bl:edit:commit')).toEqual([]);
    // The second Esc (nothing left to close) returns to Read (6.2).
    await deck.key('Escape');
    await expect.poll(async () => (await app.win(deck.docId)).appMode).toBe('read');
  } finally {
    await app.close();
  }
});

test('@edit the input filter blocks a deletion across an inline element; one inside a run is committed', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    await clickText(deck, '#inline', 0);
    expect((await editState(deck)).field?.runs.map((r) => r.value)).toEqual(['Hello ', 'bold', ' world']);
    // The paragraph's text nodes and whether its <b> is still there.
    const parts = () =>
      deck.eval<string>(`(function(){var p=document.getElementById('inline'); var b=p.querySelector('b');
        return JSON.stringify([p.firstChild && p.firstChild.data, b ? b.textContent : null, p.lastChild && p.lastChild.data]);})()`);
    const original = JSON.stringify(['Hello ', 'bold', ' world']);
    // A selection across the <b>, deleted or typed over, would remove the inline element (6.3, 9.2 step 2).
    await deck.eval(`(function(){var p=document.getElementById('inline'); getSelection().setBaseAndExtent(p.firstChild, 2, p.lastChild, 3);})()`);
    await deck.key('Delete');
    expect(await parts()).toBe(original);
    await deck.key('Backspace');
    expect(await parts()).toBe(original);
    await deck.insertText('Q');
    expect(await parts()).toBe(original);
    // Shift+Enter (insertLineBreak) is ignored in v1 (6.3).
    await deck.eval(`(function(){var p=document.getElementById('inline'); getSelection().collapse(p.firstChild, 5);})()`);
    // A real Shift+Enter: keyDown, the "\r" character event that inserts the break, keyUp.
    await deck.input(
      [
        { type: 'keyDown', keyCode: 'Return', modifiers: ['shift'] },
        { type: 'char', keyCode: '\r', modifiers: ['shift'] },
        { type: 'keyUp', keyCode: 'Return', modifiers: ['shift'] },
      ],
      10,
    );
    await sleep(100);
    expect(await parts()).toBe(original);
    expect((await editState(deck)).toast).toBe('Shift+Enter is ignored: ask for a line break with a note');
    // Inside one run: allowed.
    await deck.key('Backspace');
    expect(await parts()).toBe(JSON.stringify(['Hell ', 'bold', ' world']));
    await deck.key('Enter');
    const commit = await nextMessage(app, 'bl:edit:commit', 0);
    expect(commit.p.result).toMatchObject({ kind: 'edit', beforeText: 'Hello ', afterText: 'Hell ' });
    expect(await parts()).toBe(JSON.stringify(['Hell ', 'bold', ' world']));
  } finally {
    await app.close();
  }
});

test('@edit pasted line breaks become spaces (webContents.paste and Ctrl+V), and the page never sees the paste', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    await clickText(deck, '#title', 0, 0.98);
    await deck.key('End');
    await deck.paste(' one\ntwo');
    await expect.poll(async () => (await editState(deck)).field?.text).toBe('Quarterly review one two');
    await app.electronApp.evaluate(({ clipboard }) => clipboard.writeText(' three\r\nfour'));
    await deck.chord('v');
    await expect.poll(async () => (await editState(deck)).field?.text).toBe('Quarterly review one two three four');
    expect(await pageSeen(deck, 'paste')).toBe(0);
    expect(await pageSeen(deck, 'beforeinput')).toBe(0);
    await deck.key('Enter');
    const commit = await nextMessage(app, 'bl:edit:commit', 0);
    expect(commit.p.result).toMatchObject({ kind: 'edit', afterText: 'Quarterly review one two three four' });
  } finally {
    await app.close();
  }
});

test('@edit a change the page makes with execCommand is put back (P2-7); one that re-renders the field becomes a verbatim note (P2-17)', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    await clickText(deck, '#title', 0, 0.98);
    await deck.key('End');
    await deck.insertText('X');
    await expect.poll(async () => (await editState(deck)).field?.text).toBe('Quarterly reviewX');
    // The page writes into the focused field with execCommand: a trusted input with no beforeinput.
    await deck.eval(`document.execCommand('insertText', false, 'EVIL')`);
    await sleep(100);
    expect((await editState(deck)).field?.text).toBe('Quarterly reviewX');
    expect(await deck.eval(`document.getElementById('title').textContent`)).toBe('Quarterly reviewX');
    await deck.key('Escape');

    // The page re-renders the open field: what was typed becomes a verbatim note at once.
    await clickText(deck, '#rep1', 0, 0.98);
    await deck.key('End');
    await deck.insertText(' plus');
    await expect.poll(async () => (await editState(deck)).field?.text).toBe('Repeated label plus');
    await deck.eval(`document.getElementById('rep1').textContent = 'Changed by the page'`);
    const commit = await nextMessage(app, 'bl:edit:commit', 0);
    expect(commit.p.result).toEqual({ kind: 'verbatim', before: 'Repeated label', after: 'Repeated label plus', why: 'page-changed' });
    expect((await editState(deck)).field).toBeNull();
    // The page owns its DOM now: the overlay does not write over it.
    expect(await deck.eval(`document.getElementById('rep1').textContent`)).toBe('Changed by the page');
  } finally {
    await app.close();
  }
});

test('@edit blur commits only while the window has focus', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    await clickText(deck, '#title', 0, 0.98);
    await deck.key('End');
    await deck.insertText('Z');
    // Another window takes the focus (Cmd+Tab, a dictation panel): the field stays open, nothing is sent.
    await app.electronApp.evaluate(async ({ BrowserWindow }) => {
      const w = new BrowserWindow({ width: 300, height: 200, show: true });
      (globalThis as unknown as { __other: Electron.BrowserWindow }).__other = w;
      await w.loadURL('data:text/html,<p>other</p>');
      w.focus();
    });
    await sleep(400);
    expect((await editState(deck)).field?.text).toBe('Quarterly reviewZ');
    expect(await stubLog(app, 'bl:edit:commit')).toEqual([]);
    await app.electronApp.evaluate(() => (globalThis as unknown as { __other: Electron.BrowserWindow }).__other.destroy());
    await deck.focus();
    await sleep(200);
    expect((await editState(deck)).field).not.toBeNull();
    // A click on the deck outside any text: the field loses focus with the window focused, and commits.
    const box = await deck.rect('#box');
    await deck.click(box!.x + box!.w - 3, box!.y + box!.h - 3);
    const commit = await nextMessage(app, 'bl:edit:commit', 0);
    expect(commit.p.result).toMatchObject({ kind: 'edit', afterText: 'Quarterly reviewZ' });
  } finally {
    await app.close();
  }
});

test('@edit native undo stays inside the field: it never reaches an earlier, written edit (P2-9)', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    await clickText(deck, '#title', 0, 0.98);
    await deck.key('End');
    await deck.insertText('X');
    await deck.key('Enter');
    const c1 = await nextMessage(app, 'bl:edit:commit', 0);
    await toDeck(app, deck, 'bl:edit:result', { fieldId: c1.p.fieldId, outcome: 'written', text: 'Quarterly reviewX', line: 24, strategy: 'html-text', reload: false });
    await expect.poll(async () => (await editState(deck)).busy.committing).toBe(false);
    await clickText(deck, '#fit', 0, 0.98);
    await deck.key('End');
    await deck.insertText('Y');
    await expect.poll(async () => (await editState(deck)).field?.text).toBe('Short text in a boxY');
    // Ctrl+Z in the field is the browser's native undo (6.2; main lets it through while a text field has focus).
    await deck.chord('z');
    await expect.poll(async () => (await editState(deck)).field?.text).toBe('Short text in a box');
    // Further undos (main's Edit › Undo runs webContents.undo() for a deck text field) would reach the heading's
    // written edit on the frame's undo stack: blocked.
    const native = (cmd: 'undo' | 'redo') => app.electronApp.evaluate(({ webContents }, a) => webContents.fromId(a.id)?.[a.cmd](), { id: deck.wcId, cmd });
    await deck.chord('z');
    await native('undo');
    await native('undo');
    await sleep(200);
    expect(await deck.eval(`document.getElementById('title').textContent`)).toBe('Quarterly reviewX');
    expect((await editState(deck)).field?.text).toBe('Short text in a box');
    // Redo brings back only this field's own step.
    await native('redo');
    await expect.poll(async () => (await editState(deck)).field?.text).toBe('Short text in a boxY');
    await native('redo');
    await sleep(200);
    expect((await editState(deck)).field?.text).toBe('Short text in a boxY');
  } finally {
    await app.close();
  }
});

test('@edit SVG <text> is edited in an input over the text (P2-17)', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    const before = await pageSeen(deck, 'click');
    await clickText(deck, '#svgtext', 0, 0.98);
    const s = await editState(deck);
    expect(s.field?.svg).toBe(true);
    expect(s.field?.runs.map((r) => r.value)).toEqual(['Chart label']);
    expect(await pageSeen(deck, 'click')).toBe(before);
    await deck.key('End');
    await deck.insertText(' 2026');
    await expect.poll(async () => (await editState(deck)).field?.text).toBe('Chart label 2026');
    expect(await pageSeen(deck, 'beforeinput')).toBe(0);
    await deck.key('Enter');
    const commit = await nextMessage(app, 'bl:edit:commit', 0);
    expect(commit.p.result).toMatchObject({ kind: 'edit', beforeText: 'Chart label', afterText: 'Chart label 2026' });
    expect(await deck.eval(`document.getElementById('svgtext').textContent`)).toBe('Chart label 2026');
  } finally {
    await app.close();
  }
});
