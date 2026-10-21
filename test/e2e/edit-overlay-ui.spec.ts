// Edit mode's overlay around the field (Phase 2 overlay item; SPEC 6.3, P2-5, P2-8, P2-13, P2-14, P2-17): the
// ambiguity picker, "Not editable", links, the animation pause, the fit guard, stale maps, what main answers and
// app undo's patches. Main's edit wiring is a stub (edit-overlay-harness.ts).

import { expect, test } from '@playwright/test';
import { sleep } from '../helpers/app';
import { clickText, editState, hover, newScratch, nextMessage, openEditDeck, pageSeen, stubLog, textRect, toDeck } from './edit-overlay-harness';

test.describe.configure({ mode: 'serial' });

const scratch = newScratch();
test.afterAll(() => scratch.cleanup());

test('@edit the picker: dashed text lists the places main finds, chosen with the keys or the mouse; the field carries the pick', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    const keys = await pageSeen(deck, 'keydown');
    await clickText(deck, '#twin');
    const req = await nextMessage(app, 'bl:edit:candidates', 0);
    expect(req.p.runIds).toEqual(['l:13:0', 'l:14:0']);
    expect((await editState(deck)).picker?.loading).toBe(true);
    expect(await stubLog(app, 'bl:edit:begin')).toEqual([]);
    // Main's answer; a run the deck did not ask about is never listed.
    await toDeck(app, deck, 'bl:edit:candidates', {
      fieldId: req.p.fieldId,
      candidates: [
        { runId: 'l:13:0', line: 40, context: "\u2026var twinA = 'Twin text';\u2026" },
        { runId: 'l:99:0', line: 1, context: 'not asked for' },
        { runId: 'l:14:0', line: 41, context: "\u2026var twinB = 'Twin text';\u2026", keyWarning: 'This text is also used as a key at deck.html:12' },
      ],
    });
    await expect.poll(async () => (await editState(deck)).picker?.items.map((i) => i.runId)).toEqual(['l:13:0', 'l:14:0']);
    expect((await editState(deck)).picker?.items[1].keyWarning).toBe('This text is also used as a key at deck.html:12');
    await deck.key('ArrowDown');
    expect((await editState(deck)).picker?.index).toBe(1);
    await deck.key('Enter');
    let s = await editState(deck);
    expect(s.picker).toBeNull();
    expect(s.field?.runs.map((r) => r.runId)).toEqual(['l:14:0']);
    expect((await nextMessage(app, 'bl:edit:begin', 0)).p.runIds).toEqual(['l:14:0']);
    await deck.key('End');
    await deck.insertText(' more');
    await deck.key('Enter');
    const commit = await nextMessage(app, 'bl:edit:commit', 0);
    expect(commit.p.result).toEqual({ kind: 'edit', runId: 'l:14:0', beforeText: 'Twin text', afterText: 'Twin text more' });
    expect(commit.p.pick).toEqual({ kind: 'equal', nodeBefore: 'Twin text', nodeAfter: 'Twin text more' });
    // The picker's keys never reached the page.
    expect(await pageSeen(deck, 'keydown')).toBe(keys);
    // Main refuses it (the stub): the old text is back, so the node is dashed again.
    await toDeck(app, deck, 'bl:edit:result', { fieldId: commit.p.fieldId, outcome: 'refused', reload: false });
    await expect.poll(() => deck.eval(`document.getElementById('twin').textContent`)).toBe('Twin text');

    // With the mouse: the heading's copy has one candidate, the heading's own run.
    const clicks = await pageSeen(deck, 'click');
    await clickText(deck, '#toc');
    const req2 = await nextMessage(app, 'bl:edit:candidates', 1);
    expect(req2.p.runIds).toEqual(['h:bl-1:0']);
    await toDeck(app, deck, 'bl:edit:candidates', { fieldId: req2.p.fieldId, candidates: [{ runId: 'h:bl-1:0', line: 20, context: '<h1 id="title">Quarterly review</h1>' }] });
    await expect.poll(async () => (await editState(deck)).pickerRows.length).toBe(1);
    const row = (await editState(deck)).pickerRows[0]!;
    await deck.click(row.x + row.w / 2, row.y + row.h / 2);
    s = await editState(deck);
    expect(s.field?.runs.map((r) => r.runId)).toEqual(['h:bl-1:0']);
    expect(s.field?.rootId).toBe('toc');
    expect(await pageSeen(deck, 'click')).toBe(clicks);
    await deck.key('Escape');

    // Esc closes the picker; main finding nothing it could write makes the text not editable.
    await clickText(deck, '#twin');
    const req3 = await nextMessage(app, 'bl:edit:candidates', 2);
    await deck.key('Escape');
    expect((await editState(deck)).picker).toBeNull();
    expect((await app.win(deck.docId)).appMode).toBe('edit');
    await clickText(deck, '#twin');
    const req4 = await nextMessage(app, 'bl:edit:candidates', 3);
    expect(req4.p.fieldId).not.toBe(req3.p.fieldId);
    await toDeck(app, deck, 'bl:edit:candidates', { fieldId: req4.p.fieldId, candidates: [] });
    await expect.poll(async () => (await editState(deck)).toast).toBe('Not editable');
    expect((await editState(deck)).picker).toBeNull();
  } finally {
    await app.close();
  }
});

test('@edit text that is not editable says so; a link opens a field and is never followed', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    const seen = { pointerdown: await pageSeen(deck, 'pointerdown'), click: await pageSeen(deck, 'click') };
    await clickText(deck, '#count');
    await expect.poll(async () => (await editState(deck)).toast).toBe('Not editable');
    expect((await editState(deck)).field).toBeNull();
    expect(await stubLog(app, 'bl:edit:begin')).toEqual([]);
    expect(await pageSeen(deck, 'pointerdown')).toBe(seen.pointerdown);
    expect(await pageSeen(deck, 'click')).toBe(seen.click);

    const url = await deck.url();
    await clickText(deck, '#link');
    expect((await editState(deck)).field?.tag).toBe('a');
    await sleep(300);
    expect(await deck.url()).toBe(url);
    expect((await app.harness()).dialogs).toEqual([]);
    expect(await pageSeen(deck, 'click')).toBe(seen.click);
    await deck.key('Escape');
  } finally {
    await app.close();
  }
});

test('@edit animations pause on entering Edit and resume exactly on leaving it', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    const states = () =>
      deck.eval<string[]>(`[document.getElementById('spin').getAnimations()[0].playState, document.getElementById('still').getAnimations()[0].playState, String(document.adoptedStyleSheets.length)]`);
    expect(await states()).toEqual(['paused', 'paused', '1']);
    expect((await editState(deck)).paused).toBe(true);
    await app.run('mode-read', deck.docId);
    await expect.poll(states).toEqual(['running', 'paused', '0']);
    expect((await editState(deck)).paused).toBe(false);
    await app.run('mode-edit', deck.docId);
    await expect.poll(states).toEqual(['paused', 'paused', '1']);
  } finally {
    await app.close();
  }
});

test('@edit the fit guard warns about new lines, overflow and widows, and never blocks', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    await clickText(deck, '#fit', 0, 0.98);
    await deck.key('End');
    expect((await editState(deck)).fit).toBeNull();
    // "longer" wraps alone onto a new line: one more line, and a one-word last line.
    await deck.insertText(' that grows longer');
    await expect.poll(async () => (await editState(deck)).fit).toBe('+1 line \u00b7 widow');
    // The box is 50 px high: a third line spills out of it.
    await deck.insertText(' onto more lines than the box holds');
    await expect.poll(async () => (await editState(deck)).fit).toBe('+2 lines \u00b7 overflows');
    // It warns and never blocks: the text is all there.
    expect((await editState(deck)).field?.text).toBe('Short text in a box that grows longer onto more lines than the box holds');
    await deck.key('Escape');
    expect((await editState(deck)).fit).toBeNull();

    await clickText(deck, '#narrow', 0, 0.98);
    await deck.key('End');
    await deck.insertText(' Extraordinarily');
    await expect.poll(async () => (await editState(deck)).fit ?? '').toBe('+1 line \u00b7 widow');
    await deck.key('Escape');
  } finally {
    await app.close();
  }
});

test('@edit a map of another version (an external change waiting to reload): the open field commits, no new field opens (P2-5)', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    const s0 = await editState(deck, true);
    await clickText(deck, '#title', 0, 0.98);
    await deck.key('End');
    await deck.insertText('!');
    await toDeck(app, deck, 'bl:deck:map', { ...s0.map, version: 'b'.repeat(64) });
    await expect.poll(async () => (await editState(deck)).blocked).toBe('Deck changed \u00b7 reloads when you finish');
    expect((await editState(deck)).field?.text).toBe('Quarterly review!');
    await deck.key('Enter');
    const commit = await nextMessage(app, 'bl:edit:commit', 0);
    expect(commit.p.version).toBe(s0.pageVersion);
    await clickText(deck, '#inline');
    await expect.poll(async () => (await editState(deck)).toast).toBe('Deck changed \u00b7 reloads when you finish');
    expect((await editState(deck)).field).toBeNull();
    expect((await stubLog(app, 'bl:edit:begin')).length).toBe(1);
    const r = await textRect(deck, '#inline');
    await hover(deck, r.x + 4, r.y + r.h / 2);
    expect((await editState(deck)).outline).toBeNull();
  } finally {
    await app.close();
  }
});

test('@edit a written html-text edit moves the page to its new map; a literal write waits for the reload; notes and refusals restore the text', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    const s0 = await editState(deck, true);
    await clickText(deck, '#title', 0, 0.98);
    await deck.key('End');
    await deck.insertText(' 2027');
    await deck.key('Enter');
    const c1 = await nextMessage(app, 'bl:edit:commit', 0);
    // 9.2 step 6: main sends the new version's map, then the result.
    const next = { ...s0.map!, version: 'c'.repeat(64), runs: s0.map!.runs.map((r) => (r.id === 'h:bl-1:0' ? { ...r, value: 'Quarterly review 2027' } : r)) };
    await toDeck(app, deck, 'bl:deck:map', next);
    expect((await editState(deck)).blocked).not.toBeNull();
    await toDeck(app, deck, 'bl:edit:result', { fieldId: c1.p.fieldId, outcome: 'written', text: 'Quarterly review 2027', line: 20, strategy: 'html-text', reload: false, token: 'tok-00000001' });
    await expect.poll(async () => (await editState(deck)).pageVersion).toBe('c'.repeat(64));
    expect((await editState(deck)).blocked).toBeNull();
    const r = await textRect(deck, '#title');
    await hover(deck, r.x + r.w / 2, r.y + r.h / 2);
    await expect.poll(async () => (await editState(deck)).outline?.kind).toBe('solid');

    // One literal shown in two places: the commit tells main, whose shell toast says so (6.3 Saving; E-5: the
    // overlay shows no Saved toast of its own, the reload would take it away).
    await clickText(deck, '#rep1', 0, 0.98);
    await deck.key('End');
    await deck.insertText(' X');
    await deck.key('Enter');
    const c2 = await nextMessage(app, 'bl:edit:commit', 1);
    expect(c2.p.alsoPlaces).toBe(1);
    await toDeck(app, deck, 'bl:edit:result', { fieldId: c2.p.fieldId, outcome: 'written', text: 'Repeated label X', line: 49, strategy: 'script-literal', reload: true, token: 'tok-00000002' });
    // The page's data still holds the old literal: no new field until the reload (Strategy 2 step 5.5).
    await expect.poll(async () => (await editState(deck)).blocked).toBe('Reloading to show your edit\u2026');
    expect((await editState(deck)).toast).toBe('');
  } finally {
    await app.close();
  }
});

test('@edit a note or a refusal puts the old text back (the shell says why, main-driven); app undo patches the node', async () => {
  const { app, deck } = await openEditDeck(scratch);
  try {
    await clickText(deck, '#inline', 0, 0.3);
    await deck.insertText('Q');
    await deck.key('Enter');
    const c1 = await nextMessage(app, 'bl:edit:commit', 0);
    await toDeck(app, deck, 'bl:edit:result', { fieldId: c1.p.fieldId, outcome: 'verbatim', why: 'the deck changed meanwhile', reload: false, noteId: 'n-0001' });
    await expect.poll(() => deck.eval(`document.getElementById('inline').textContent`)).toBe('Hello bold world');
    // "Not changed in place … kept as a note" is the shell's toast, shown by main with its answer (a reload right
    // after would take an overlay toast away): the overlay shows no copy (edit-fix-undo-toast.spec.ts checks the shell).
    expect((await editState(deck)).toast).toBe('');

    await clickText(deck, '#fit', 0, 0.98);
    await deck.key('End');
    await deck.insertText('!');
    await deck.key('Enter');
    const c2 = await nextMessage(app, 'bl:edit:commit', 1);
    await toDeck(app, deck, 'bl:edit:result', { fieldId: c2.p.fieldId, outcome: 'refused', why: 'editing is off', reload: false });
    await expect.poll(() => deck.eval(`document.getElementById('fit').textContent`)).toBe('Short text in a box');
    expect((await editState(deck)).toast).toBe('');

    // An app undo of an html-text write: main tells the page the text to show (P2-10).
    await toDeck(app, deck, 'bl:edit:applied', { stamp: 'bl-6', textIndex: 0, text: 'Patched by undo' });
    await expect.poll(() => deck.eval(`document.getElementById('fit').textContent`)).toBe('Patched by undo');
    // A field the page removes: what was typed is a verbatim note (P2-17).
    await clickText(deck, '#rep2', 0, 0.98);
    await deck.key('End');
    await deck.insertText(' gone');
    await deck.eval(`document.getElementById('rep2').remove()`);
    const c3 = await nextMessage(app, 'bl:edit:commit', 2);
    expect(c3.p.result).toEqual({ kind: 'verbatim', before: 'Repeated label', after: 'Repeated label gone', why: 'page-changed' });
  } finally {
    await app.close();
  }
});
