// Phase 0 E2E: Review ink and the note card (SPEC section 10 Diagnostics/ink; 6.4, 6.5). Draw two strokes
// with a card open (trusted mouse input via sendInputEvent) and assert both marks are on one note (read from
// session.json). The card's textarea receives typed text (insertText) and a simulated paste, which reach
// main as the note's text.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, loopAround, resolveRunAs, sleep, type BlApp } from '../helpers/app';
import { launchApp } from '../helpers/app';
import type { Note } from '../../packages/core/src/types';

test.describe.configure({ mode: 'serial' });

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
}

/** Polls a document's session.json until `predicate` holds, and returns the notes. */
async function waitForNotes(app: BlApp, sessionFile: string, predicate: (notes: Note[]) => boolean, timeout = 10_000): Promise<Note[]> {
  const end = Date.now() + timeout;
  let notes: Note[] = [];
  while (Date.now() < end) {
    try {
      const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { notes?: Note[] };
      notes = Array.isArray(raw.notes) ? raw.notes : [];
      if (predicate(notes)) return notes;
    } catch {
      // not written yet, or mid-write
    }
    await sleep(150);
  }
  return notes;
}

test('two strokes with a card open make two marks on one note; typed and pasted text reach it', async () => {
  const s = scratch();
  const dir = s.dir('deck');
  const file = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  s.own(dir);
  const app = await launchApp({ files: [file], scratch: s });
  try {
    const deck = await app.waitForDeck('single.html');
    const w = await app.win(deck.docId);
    const sessionFile = w.sessionFile;

    // Enter Review (Cmd/Ctrl+2) and pick the pen (key 1).
    await deck.chord('2');
    await sleep(200);
    expect((await app.win(deck.docId)).appMode).toBe('review');
    await deck.key('1');
    await sleep(150);

    // Stroke 1 (no card open): creates a note and opens its card. Coordinates are in the deck view (the
    // viewport is ~940×863 here); keep both loops well inside and clear of the card the first opens.
    await deck.drag(loopAround({ x: 300, y: 180, w: 170, h: 110 }, 12));
    const afterFirst = await waitForNotes(app, sessionFile, (n) => n.length >= 1 && n[0].marks.length >= 1);
    expect(afterFirst.length, `one note after the first stroke; got ${JSON.stringify(afterFirst.map((x) => x.marks.length))}`).toBe(1);
    expect(afterFirst[0].marks.length).toBe(1);

    // Stroke 2 (card open, no Shift): joins the same note as mark ②.
    await deck.drag(loopAround({ x: 300, y: 560, w: 170, h: 110 }, 12));
    const afterSecond = await waitForNotes(app, sessionFile, (n) => n.length === 1 && n[0].marks.length >= 2);
    expect(afterSecond.length, `still one note after the second stroke; got ${JSON.stringify(afterSecond.map((x) => x.marks.length))}`).toBe(1);
    expect(afterSecond[0].marks.length, 'both strokes should be marks on one note').toBe(2);
    // The marks are numbered ① ② within the note.
    expect(afterSecond[0].marks.map((m) => m.n).sort()).toEqual([1, 2]);

    // The card textarea has focus (the ink layer kept it there): typed text (insertText) reaches the note.
    await deck.insertText('start the axis at zero');
    await sleep(500); // card text is saved debounced (300 ms)
    let notes = await waitForNotes(app, sessionFile, (n) => n[0]?.text.includes('axis'));
    expect(notes[0]?.text, `typed text should reach the note; got ${JSON.stringify(notes[0]?.text)}`).toContain('start the axis at zero');

    // A simulated paste (Wispr Flow pastes through the clipboard, D2) also lands in the card.
    await deck.paste(' — and label it');
    await sleep(500);
    notes = await waitForNotes(app, sessionFile, (n) => n[0]?.text.includes('label'));
    expect(notes[0]?.text, `pasted text should reach the note; got ${JSON.stringify(notes[0]?.text)}`).toContain('label it');
  } finally {
    await app.close();
    s.cleanup();
  }
});
