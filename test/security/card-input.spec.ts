// Card input belongs to the user (SPEC 9.1 Preload: "page scripts cannot drive the key router, ink or cards";
// 6.2 step 2; 6.5; SPEC 4 principle 1; D2; findings 9, 11, 13), in both trust states.
//
// - card-exec.html writes into the open card with document.execCommand (insertText, selectAll + delete,
//   insertText, undo) each time focus enters it: for a new card and for a card J reopens. Chromium fires a
//   trusted `input` with no beforeinput for these; the card must refuse them, so the saved note is exactly
//   what the user typed, inserted and pasted. Positive control: the fixture records that each execCommand
//   ran (returned true) while focus was in the card.
// - card-snoop.html listens on window and document, capture and bubble, to every key and input-family event,
//   and cancels in the capture phase any paste outside a text field. No event from the card may reach it,
//   and the paste (Wispr Flow's path) must land. Positive control: typing and pasting into the page's own
//   <input> is logged, through the same listeners.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import { Scratch, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';
import { openFixture, type SecuritySession } from '../helpers/security';
import type { Note } from '../../packages/core/src/types';

const CMD = process.platform === 'darwin' ? 'meta' : 'control';

async function waitForNotes(file: string, pred: (notes: Note[]) => boolean, timeout = 10_000): Promise<Note[]> {
  const end = Date.now() + timeout;
  let notes: Note[] = [];
  while (Date.now() < end) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { notes?: Note[] };
      notes = Array.isArray(raw.notes) ? raw.notes : [];
      if (pred(notes)) return notes;
    } catch {
      // not written yet, or mid-write
    }
    await sleep(150);
  }
  return notes;
}

async function setClipboard(app: BlApp, text: string): Promise<void> {
  await app.electronApp.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
}

async function hover(deck: DeckView, selector: string): Promise<void> {
  const r = await deck.rect(selector);
  if (!r) throw new Error(`no ${selector}`);
  await deck.input([{ type: 'mouseMove', x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) }]);
  await sleep(100);
}

async function review(s: SecuritySession): Promise<void> {
  await s.deck.chord('2');
  await expect.poll(async () => (await s.app.win(s.docId)).appMode).toBe('review');
}

/** What the user enters into the open card: typing, an input method, a paste and Wispr Flow's Cmd+V. */
async function userEnters(s: SecuritySession, typed: string, inserted: string, pasted: string, ctrlv: string): Promise<string> {
  for (const c of typed) await s.deck.key(c);
  await s.deck.insertText(inserted);
  await s.deck.paste(pasted);
  await sleep(100);
  await setClipboard(s.app, ctrlv);
  await s.deck.key('V', [CMD]);
  await sleep(100);
  return typed + inserted + pasted + ctrlv;
}

interface ExecEntry {
  entry: number;
  focusInCard: boolean;
  insertText: boolean;
  selectAll: boolean;
  del: boolean;
  replace: boolean;
  undo: boolean;
  focusAfter: boolean;
}

for (const trust of ['protected', 'trusted'] as const) {
  test(`${trust}: document.execCommand cannot write into a new or a reopened note card (finding 11)`, async () => {
    const scratch = new Scratch(resolveRunAs());
    const s = await openFixture({ scratch, fixture: 'card-exec.html', trust });
    try {
      const sessionFile = (await s.app.win(s.docId)).sessionFile;
      const execLog = async () => JSON.parse((await s.deck.eval<string>('document.documentElement.dataset.execLog || "[]"')) || '[]') as ExecEntry[];
      await review(s);
      await hover(s.deck, '#title');
      await s.deck.key('n');
      await waitForNotes(sessionFile, (n) => n.length === 1);
      // The page saw focus enter the card and ran its forgeries there (positive control).
      await expect.poll(async () => (await execLog()).length, { timeout: 10_000 }).toBe(1);
      const first = (await execLog())[0];
      // (selectAll is disabled in an empty text field, so it reports false on the new, empty card.)
      expect(first, JSON.stringify(first)).toMatchObject({ entry: 1, focusInCard: true, insertText: true, del: true, replace: true, focusAfter: true });

      const want = await userEnters(s, 'typed by user', ' and inserted', ' and pasted', ' and dictated');
      const notes = await waitForNotes(sessionFile, (n) => n[0]?.text === want);
      expect(notes.map((n) => n.text)).toEqual([want]);
      await s.deck.key('Escape');
      await waitForNotes(sessionFile, (n) => n[0]?.status === 'open');

      // J reopens the note with focus in the card: the page forges again, on text the user did not touch.
      await s.deck.key('j');
      await expect.poll(async () => (await execLog()).length, { timeout: 10_000 }).toBe(2);
      const second = (await execLog())[1];
      expect(second, JSON.stringify(second)).toMatchObject({ entry: 2, focusInCard: true, insertText: true, selectAll: true, del: true, replace: true, focusAfter: true });
      await sleep(600); // past the 300 ms save debounce: a forged edit would have been saved by now
      await s.deck.key('Escape');
      await sleep(400);
      const after = await waitForNotes(sessionFile, (n) => n[0]?.status === 'open');
      expect(after.map((n) => [n.text, n.status])).toEqual([[want, 'open']]);
      expect(JSON.stringify(after)).not.toContain('FORGED');
    } finally {
      await s.close();
      scratch.cleanup();
    }
  });

  test(`${trust}: the deck's own listeners never see, or cancel, what the user types, pastes or dictates into a card (findings 9, 13)`, async () => {
    const scratch = new Scratch(resolveRunAs());
    const s = await openFixture({ scratch, fixture: 'card-snoop.html', trust });
    try {
      const sessionFile = (await s.app.win(s.docId)).sessionFile;
      const snoop = async () => JSON.parse((await s.deck.eval<string>('document.documentElement.dataset.snoop || "[]"')) || '[]') as string[];

      // Positive control (Read mode): typing and pasting into the page's own input are logged, by the same
      // window and document listeners, capture and bubble, with their data.
      await s.deck.clickSelector('#field');
      for (const c of 'pq') await s.deck.key(c);
      await s.deck.paste('PAGE-PASTE');
      await sleep(200);
      const control = await snoop();
      for (const where of ['wcap', 'dcap', 'wbub', 'dbub']) {
        expect(control, where).toContain(`${where}:keydown:input:p`);
        expect(control, where).toContain(`${where}:beforeinput:input:q`);
        expect(control, where).toContain(`${where}:input:input:q`);
        expect(control, where).toContain(`${where}:paste:input:PAGE-PASTE`);
      }
      expect(await s.deck.eval<string>(`document.getElementById('field').value`)).toBe('pqPAGE-PASTE');

      // The card.
      await review(s);
      await hover(s.deck, '#title');
      await s.deck.key('n');
      await waitForNotes(sessionFile, (n) => n.length === 1);
      await s.deck.eval('window.__snoopClear()');
      const want = await userEnters(s, 'secret', ' margin 12pct', ' CONFIDENTIAL-PASTE', ' dictated by wispr');
      const notes = await waitForNotes(sessionFile, (n) => n[0]?.text === want);
      // Every paste landed: the deck's capture-phase paste blocker never saw them.
      expect(notes.map((n) => n.text)).toEqual([want]);
      await s.deck.key('Escape');
      await waitForNotes(sessionFile, (n) => n[0]?.status === 'open');

      const seen = await snoop();
      expect(seen.filter((e) => e.split(':')[2] === 'blueline-overlay')).toEqual([]);
      expect(seen.filter((e) => e.startsWith('blocked:'))).toEqual([]);
      for (const secret of ['secret', 'margin', 'CONFIDENTIAL', 'wispr']) expect(seen.join('\n'), secret).not.toContain(secret);
    } finally {
      await s.close();
      scratch.cleanup();
    }
  });
}
