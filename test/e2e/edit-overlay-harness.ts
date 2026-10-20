// Shared by the edit-overlay-*.spec.ts E2E tests (Phase 2 overlay item): the deck preload's Edit mode against a
// stub main. Main's Edit wiring (the write queue, notes, undo) is another item, built at the same time; these
// tests replace main's handlers of the edit channels with recorders (ipcMain listeners installed through
// Playwright's evaluate in main), and answer the deck as main would (webContents.send). What the closed overlay
// shows is read through the test build's __blTestEdit hook in the preload's isolated world (deck.ts).

import { expect } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';

export const EDIT_FIXTURE = path.join(FIXTURES, 'edit/edit-overlay.html');

/** Deck → main edit channels (core/ipc-edit.ts EditDeckToMain). */
export const DECK_TO_MAIN = ['bl:edit:begin', 'bl:edit:commit', 'bl:edit:candidates', 'bl:edit:undo', 'bl:edit:busy'] as const;

export interface StubMessage {
  ch: string;
  // Payloads as the deck sent them.
  p: Record<string, unknown>;
}

export interface EditState {
  mode: string;
  blocked: string | null;
  pageVersion: string | null;
  mapsAhead: number;
  outline: { kind: string; x: number; y: number; w: number; h: number } | null;
  toast: string;
  toastAction: boolean;
  toastButton: { x: number; y: number; w: number; h: number } | null;
  pickerRows: ({ x: number; y: number; w: number; h: number } | null)[];
  fit: string | null;
  badge: string | null;
  picker: { id: number; loading: boolean; index: number; items: { runId: string; line: number; context: string; keyWarning?: string }[] } | null;
  field: {
    id: number;
    svg: boolean;
    version: string;
    before: string;
    text: string;
    runs: { runId: string; start: number; end: number; value: string }[];
    caretRunId: string | null;
    tag: string;
    rootId: string;
    tampered: boolean;
  } | null;
  busy: { edit: boolean; committing: boolean };
  paused: boolean;
  map?: { version: string; utf8: boolean; runs: { id: string; stamp: string; textIndex: number; value: string; aligned: boolean }[]; literals: unknown[]; keyValues: string[]; shadowValues?: string[] };
}

export function newScratch(): Scratch {
  return new Scratch(resolveRunAs());
}

/** Replaces main's handlers of the deck's edit channels with recorders (the stub main). */
export async function stubEditMain(app: BlApp): Promise<void> {
  await app.electronApp.evaluate(({ ipcMain }, channels) => {
    const g = globalThis as unknown as { __editStub?: { log: { ch: string; p: unknown; from: number }[] } };
    g.__editStub = { log: [] };
    for (const ch of channels) {
      ipcMain.removeAllListeners(ch);
      ipcMain.on(ch, (e, p) => g.__editStub!.log.push({ ch, p, from: e.sender.id }));
    }
    // The view hooks' busy state (6.6 reload rules) is main's own channel: recorded beside main's handler.
    ipcMain.on('bl:files:busy', (e, p) => g.__editStub!.log.push({ ch: 'bl:files:busy', p, from: e.sender.id }));
  }, [...DECK_TO_MAIN]);
}

export async function stubLog(app: BlApp, ch?: string): Promise<StubMessage[]> {
  const all = await app.electronApp.evaluate(() => {
    const g = globalThis as unknown as { __editStub?: { log: { ch: string; p: unknown }[] } };
    return JSON.parse(JSON.stringify(g.__editStub?.log ?? [])) as { ch: string; p: Record<string, unknown> }[];
  });
  return ch ? all.filter((m) => m.ch === ch) : all;
}

/** Waits for the next message on `ch` after `after` messages of it were seen, and returns it. */
export async function nextMessage(app: BlApp, ch: string, after: number, timeout = 10_000): Promise<StubMessage> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const list = await stubLog(app, ch);
    if (list.length > after) return list[after];
    await sleep(50);
  }
  throw new Error(`no ${ch} message after ${after}`);
}

/** Sends a main → deck message to the deck view, as main would. */
export async function toDeck(app: BlApp, deck: DeckView, channel: string, payload: unknown): Promise<void> {
  await app.electronApp.evaluate(
    ({ webContents }, a) => {
      webContents.fromId(a.id)?.send(a.channel, a.payload);
    },
    { id: deck.wcId, channel, payload },
  );
}

export async function editState(deck: DeckView, withMap = false): Promise<EditState> {
  return await deck.isolated<EditState>(`globalThis.__blTestEdit.state(${withMap ? 'true' : 'false'})`);
}

/** The view rect of an element's `index`-th text node (main world). */
export async function textRect(deck: DeckView, selector: string, index = 0): Promise<{ x: number; y: number; w: number; h: number }> {
  const r = await deck.eval<{ x: number; y: number; w: number; h: number } | null>(`(function(){
    var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    var texts = []; var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (var n = w.nextNode(); n; n = w.nextNode()) if (n.data.trim()) texts.push(n);
    var t = texts[${index}]; if (!t) return null;
    var range = document.createRange(); range.selectNodeContents(t); var b = range.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  })()`);
  if (!r) throw new Error(`no text ${index} in ${selector}`);
  return r;
}

/** Moves the mouse over a point (trusted pointermove), and gives the controller a frame to draw. */
export async function hover(deck: DeckView, x: number, y: number): Promise<void> {
  await deck.input([{ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }]);
  await sleep(120);
}

/** How many of an event type the page's own capture listener saw (the fixture's data-seen-* counters). */
export async function pageSeen(deck: DeckView, type: string): Promise<number> {
  return Number((await deck.eval<string | null>(`document.documentElement.getAttribute('data-seen-${type}')`)) ?? 0);
}

/** Opens a copy of the edit fixture, installs the stub main, enters Edit and waits until Edit is ready (P2-6). */
export async function openEditDeck(scratch: Scratch, fixture = EDIT_FIXTURE): Promise<{ app: BlApp; deck: DeckView; file: string }> {
  const dir = scratch.dir('edit-overlay');
  const file = copyInto(fixture, dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  const deck = await app.waitForDeck(path.basename(file));
  await stubEditMain(app);
  await deck.focus();
  await app.run('mode-edit', deck.docId);
  await expect.poll(async () => (await app.win(deck.docId)).appMode, { timeout: 10_000 }).toBe('edit');
  // The complete map of the page's version arrives after the first paint (D-9).
  await expect.poll(async () => (await editState(deck)).blocked, { timeout: 15_000 }).toBeNull();
  return { app, deck, file };
}

/** A real click at the middle of an element's `index`-th text node. */
export async function clickText(deck: DeckView, selector: string, index = 0, at = 0.5): Promise<{ x: number; y: number }> {
  const r = await textRect(deck, selector, index);
  const x = r.x + r.w * at;
  const y = r.y + r.h / 2;
  await deck.click(x, y);
  return { x, y };
}
