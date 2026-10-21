// One commit that changes a run in two places, end to end (SPEC 9.2 Committing an edit step 3; 6.3 Ending an edit
// and Smart punctuation: "Nothing else changes"; review finding 23, lead decision E-12). Real input only: a real
// click opens the field, keys go through sendInputEvent, a paste goes through webContents.paste (insertFromPaste),
// Enter commits. The file on disk is the oracle, byte for byte: the deck's own straight quotes and &nbsp; between
// the two changes stay as they are, and only what the author typed or pasted is cleaned.
//
// Every test needs the Edit capability: @edit in each title (the reader-only gate leaves them out).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scratch, launchApp, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';

// A synthetic deck, written into the test's own temp directory.
const DECK = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>Two changes</title>',
  '<style>body{font:32px/1.4 sans-serif;margin:40px} h1,p{margin:30px 0}</style></head>',
  '<body>',
  '<h1 id="h">Delivery in 10&nbsp;km</h1>',
  '<p id="q">\u201CA\u201D and "b" end</p>',
  '<p id="o">Price 10&nbsp;km away</p>',
  '</body>',
  '</html>',
  '',
].join('\n');

async function until<T>(what: string, fn: () => Promise<T | undefined>, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`timed out: ${what}${last ? ` (${last instanceof Error ? last.message : String(last)})` : ''}`);
}

interface Opened {
  s: Scratch;
  app: BlApp;
  deck: DeckView;
  file: string;
}

async function open(): Promise<Opened> {
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('edit-two-changes');
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, DECK);
  s.own(dir);
  const app = await launchApp({ files: [file], scratch: s });
  const deck = await app.waitForDeck('deck.html');
  await deck.chord('3');
  await until('Edit mode', async () => ((await app.win(deck.docId)).appMode === 'edit' ? true : undefined));
  return { s, app, deck, file };
}

async function close(o: Opened): Promise<void> {
  await o.app.close();
  o.s.cleanup();
}

/** A real click on the element's text until the overlay made it the field; then the caret at the end of its text. */
async function openField(deck: DeckView, selector: string): Promise<void> {
  await until(
    `an edit field on ${selector}`,
    async () => {
      await deck.clickText(selector);
      const on = await deck.eval<boolean>(`(function(){var e=document.querySelector(${JSON.stringify(selector)});return !!e && e.isContentEditable && document.activeElement === e;})()`);
      return on ? true : undefined;
    },
    20_000,
  );
  await deck.key('End', ['control']);
}

async function typeKeys(deck: DeckView, text: string): Promise<void> {
  for (const ch of text) await deck.key(ch);
}

/** The caret at offset n of the field's text (from its start). */
async function caretAt(deck: DeckView, n: number): Promise<void> {
  await deck.key('Home', ['control']);
  for (let i = 0; i < n; i++) await deck.key('Right');
}

async function fileLineBecomes(file: string, from: string, to: string): Promise<void> {
  const want = DECK.replace(from, to);
  await until('the file to hold the edit', async () => (fs.readFileSync(file, 'utf8') === want ? true : undefined)).catch(() => undefined);
  expect(fs.readFileSync(file, 'utf8')).toBe(want);
}

test('@edit typed quotes are curled, and the run\'s own straight quotes between the two changes stay straight', async () => {
  const o = await open();
  try {
    await openField(o.deck, '#q');
    await typeKeys(o.deck, ' "c"');
    await caretAt(o.deck, 2);
    await typeKeys(o.deck, 'A');
    await o.deck.key('Enter');
    await fileLineBecomes(o.file, '<p id="q">\u201CA\u201D and "b" end</p>', '<p id="q">\u201CAA\u201D and "b" end \u201Cc\u201D</p>');
  } finally {
    await close(o);
  }
});

test('@edit a pasted NBSP becomes a space, and the deck\'s &nbsp; between the two changes stays', async () => {
  const o = await open();
  try {
    await openField(o.deck, '#h');
    await o.deck.paste(', ready in 5\u00A0min');
    await caretAt(o.deck, 8);
    await o.deck.key('Backspace');
    await typeKeys(o.deck, 'ies');
    expect(await o.deck.eval<string>('document.getElementById("h").textContent')).toBe('Deliveries in 10\u00A0km, ready in 5\u00A0min');
    await o.deck.key('Enter');
    await fileLineBecomes(o.file, '<h1 id="h">Delivery in 10&nbsp;km</h1>', '<h1 id="h">Deliveries in 10&nbsp;km, ready in 5 min</h1>');
  } finally {
    await close(o);
  }
});

test('@edit an NBSP pasted where the deck\'s own was replaced by a space becomes a space too', async () => {
  const o = await open();
  try {
    await openField(o.deck, '#o');
    await o.deck.paste('\u00A0now');
    await caretAt(o.deck, 9);
    await o.deck.key('Backspace');
    await o.deck.key(' ');
    expect(await o.deck.eval<string>('document.getElementById("o").textContent')).toBe('Price 10 km away\u00A0now');
    await o.deck.key('Enter');
    await fileLineBecomes(o.file, '<p id="o">Price 10&nbsp;km away</p>', '<p id="o">Price 10 km away now</p>');
  } finally {
    await close(o);
  }
});
