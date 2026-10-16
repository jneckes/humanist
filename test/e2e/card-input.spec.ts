// Note card input in the real app (SPEC 6.2 step 2, 6.4, 6.5, 9.1 Preload; section 10 Diagnostics "Wispr text
// lands in the card"; findings 9, 11, 12, 13, 18). Every way text reaches the card ends in session.json:
// typing, an input method (webContents.insertText, an IME composition), webContents.paste() and Ctrl+V with
// clipboard text (Wispr Flow pastes). N's anchor pin is not a user mark: N then Esc leaves no note, and N
// plus two strokes gives marks 1 and 2. A deck that rewrites itself with document.open() keeps a working
// card and ink. The ordering limit after document.open() (listeners the rewritten page registers
// synchronously run before the preload's re-added ones) stays visible as a test.fail().
// Run with `npm run test:e2e` (global setup starts Xvfb on Linux).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, loopAround, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';
import type { Note } from '../../packages/core/src/types';

test.describe.configure({ mode: 'serial' });

const CMD = process.platform === 'darwin' ? 'meta' : 'control';

interface Opened {
  app: BlApp;
  deck: DeckView;
  sessionFile: string;
  scratch: Scratch;
}

/** Opens a copy of a fixture (never the repo file) and waits for its deck. */
async function open(rel: string, o: { protected?: boolean } = {}): Promise<Opened> {
  const scratch = new Scratch(resolveRunAs());
  const dir = scratch.dir('deck');
  const file = copyInto(path.join(FIXTURES, rel), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch, protected: o.protected });
  const deck = await app.waitForDeck(path.basename(file));
  const sessionFile = (await app.win(deck.docId)).sessionFile;
  return { app, deck, sessionFile, scratch };
}

async function close(o: Opened): Promise<void> {
  await o.app.close();
  o.scratch.cleanup();
}

/** Polls session.json until `pred` holds; returns the notes it last read. */
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

/** Cmd/Ctrl+2 (main takes the chord in before-input-event, 6.2). */
async function review(o: Opened): Promise<void> {
  await o.deck.chord('2');
  await expect.poll(async () => (await o.app.win(o.deck.docId)).appMode).toBe('review');
}

/** Moves the pointer over the center of `selector` (N's hovered element). */
async function hover(deck: DeckView, selector: string): Promise<{ x: number; y: number; w: number; h: number }> {
  const r = await deck.rect(selector);
  if (!r) throw new Error(`no ${selector}`);
  await deck.input([{ type: 'mouseMove', x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) }]);
  await sleep(100);
  return r;
}

async function setClipboard(app: BlApp, text: string): Promise<void> {
  await app.electronApp.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
}

/**
 * An IME composition through the DevTools protocol: updates, then the commit (insertCompositionText). The
 * window is focused first and the commands go back to back: a window that loses focus mid-composition (another
 * test app on the same display) commits the composition as it stands.
 */
async function compose(o: Opened, updates: string[], commit: string): Promise<void> {
  await o.deck.focus();
  await o.app.electronApp.evaluate(
    async ({ webContents }, a) => {
      const wc = webContents.fromId(a.id)!;
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      for (const u of a.updates) await wc.debugger.sendCommand('Input.imeSetComposition', { text: u, selectionStart: u.length, selectionEnd: u.length });
      await wc.debugger.sendCommand('Input.insertText', { text: a.commit });
      wc.debugger.detach();
    },
    { id: o.deck.wcId, updates, commit },
  );
}

/** Whether the overlay's card textarea has focus (main's record of the preload's focus report). */
async function cardFocused(o: Opened): Promise<boolean> {
  return (await o.app.win(o.deck.docId)).textField;
}

test('typing, an input method, paste and Ctrl+V into the card all reach session.json (6.5, D2)', async () => {
  const o = await open('decks/single.html');
  try {
    await review(o);
    await hover(o.deck, 'h1');
    await o.deck.key('n');
    await waitForNotes(o.sessionFile, (n) => n.length === 1);
    await expect.poll(() => cardFocused(o)).toBe(true);

    for (const c of 'abc') await o.deck.key(c);
    await o.deck.insertText(' ime');
    await o.deck.paste(' pasted');
    await sleep(100);
    await setClipboard(o.app, ' ctrlv');
    await o.deck.key('V', [CMD]); // Wispr Flow's simulated Cmd+V
    await sleep(100);
    await compose(o, ['ni', 'nih'], ' 你好');
    const want = 'abc ime pasted ctrlv 你好';
    const notes = await waitForNotes(o.sessionFile, (n) => n[0]?.text === want);
    expect(notes.map((n) => n.text)).toEqual([want]);

    await o.deck.key('Escape');
    const closed = await waitForNotes(o.sessionFile, (n) => n[0]?.status === 'open');
    expect(closed.map((n) => [n.text, n.status])).toEqual([[want, 'open']]);
  } finally {
    await close(o);
  }
});

test('N then Esc leaves no note; N plus two strokes gives marks 1 and 2 on one note (6.2 N, 6.4)', async () => {
  const o = await open('decks/single.html');
  try {
    await review(o);
    await hover(o.deck, 'h1');
    await o.deck.key('n');
    await waitForNotes(o.sessionFile, (n) => n.length === 1);
    await o.deck.key('Escape');
    // The N note with no text and only its anchor pin is discarded (6.4: empty and no marks).
    const afterEsc = await waitForNotes(o.sessionFile, (n) => n.length === 0);
    expect(afterEsc).toEqual([]);

    await o.deck.key('1'); // pen
    // N on the small brand line at the top left: its card opens beside it, clear of the two strokes below.
    await hover(o.deck, '.brand');
    await o.deck.key('n');
    await waitForNotes(o.sessionFile, (n) => n.length === 1);
    await o.deck.drag(loopAround({ x: 120, y: 420, w: 160, h: 70 }, 12));
    await o.deck.drag(loopAround({ x: 120, y: 600, w: 160, h: 70 }, 12));
    const notes = await waitForNotes(o.sessionFile, (n) => n.length === 1 && n[0].marks.length === 2 && n[0].marks.every((m) => m.tool === 'pen'));
    expect(notes).toHaveLength(1);
    expect(notes[0].marks.map((m) => [m.n, m.tool])).toEqual([
      [1, 'pen'],
      [2, 'pen'],
    ]);
    // The element N anchored to stays among the note's targets.
    expect(notes[0].targets.some((t) => t.text === 'Northwind Labs')).toBe(true);
    await o.deck.key('Escape');
    const kept = await waitForNotes(o.sessionFile, (n) => n[0]?.status === 'open');
    expect(kept.map((n) => [n.status, n.marks.length])).toEqual([['open', 2]]);
  } finally {
    await close(o);
  }
});

test('after document.open(), card input is saved and a pen stroke makes a mark (finding 12)', async () => {
  const o = await open('input/docopen.html');
  try {
    await o.deck.waitFor(`document.documentElement.dataset.rewritten === 'yes'`);
    await sleep(300);
    await review(o);
    await hover(o.deck, '#title');
    await o.deck.key('n');
    await waitForNotes(o.sessionFile, (n) => n.length === 1);
    await expect.poll(() => cardFocused(o)).toBe(true);
    for (const c of 'abc') await o.deck.key(c);
    await o.deck.paste(' dictated');
    const typed = await waitForNotes(o.sessionFile, (n) => n[0]?.text === 'abc dictated');
    expect(typed.map((n) => n.text)).toEqual(['abc dictated']);
    await o.deck.key('Escape');
    await waitForNotes(o.sessionFile, (n) => n[0]?.status === 'open');

    await o.deck.key('1'); // pen
    const p = await o.deck.rect('#body');
    await o.deck.drag(loopAround(p!, 14));
    const two = await waitForNotes(o.sessionFile, (n) => n.length === 2);
    expect(two.map((n) => [n.text, n.marks.map((m) => m.tool)])).toEqual([
      ['abc dictated', ['pin']],
      ['', ['pen']],
    ]);
    await expect.poll(() => cardFocused(o)).toBe(true); // the stroke's card opened with focus
  } finally {
    await close(o);
  }
});

// Ordering limit (listeners.ts): reinstall() runs from a MutationObserver callback after the scripts the
// page's document.write inserted have run, so a capture listener such a script registers synchronously sees
// card keys and input before the re-added key router and input guard. The preload cannot get ahead of it;
// the 6.2 fallback (the router in main's before-input-event) would. Expected to fail until then.
test('ordering limit: after document.open(), a capture listener the rewritten page registers synchronously sees no card input', async () => {
  test.fail(true, 'documented limit: listeners registered synchronously by document.write scripts run before the re-added router and guard');
  const o = await open('input/docopen.html');
  try {
    await o.deck.waitFor(`document.documentElement.dataset.rewritten === 'yes'`);
    await sleep(300);
    await review(o);
    await hover(o.deck, '#title');
    await o.deck.key('n');
    await waitForNotes(o.sessionFile, (n) => n.length === 1);
    await expect.poll(() => cardFocused(o)).toBe(true);
    for (const c of 'xy') await o.deck.key(c);
    await o.deck.paste(' z');
    await waitForNotes(o.sessionFile, (n) => n[0]?.text === 'xy z');
    const seen = JSON.parse((await o.deck.eval<string>('document.documentElement.dataset.pageLog || "[]"')) || '[]') as string[];
    const fromCard = seen.filter((s) => s.endsWith(':blueline-overlay'));
    test.info().annotations.push({ type: 'page-saw', description: JSON.stringify(fromCard) });
    expect(fromCard).toEqual([]);
  } finally {
    await close(o);
  }
});
