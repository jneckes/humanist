// Edit wired into main, end to end (Phase 2; SPEC 6.3, 6.6 Edit notes, 9.2 Write protocol and Undo and redo, 10
// Phase 2; decisions P2-2, P2-10, P2-11, P2-13, P2-14). Real input only: a real click on the text opens the field,
// keys go through sendInputEvent (main sees them, P2-7), Enter commits. The file on disk is the oracle, byte for
// byte; the shell and the page are checked as the user sees them.
//
// Every test needs the Edit capability: @edit in each title (the reader-only gate leaves them out).

import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';
import { openSettings, waitConfig } from './trust-native-harness';

test.describe.configure({ mode: 'serial' });

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
  original: Buffer;
}

async function open(fixture: string, name = path.basename(fixture), o: { protected?: boolean } = {}): Promise<Opened> {
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('edit-main');
  const file = copyInto(path.join(FIXTURES, fixture), dir, name);
  s.own(dir);
  const original = fs.readFileSync(file);
  const app = await launchApp({ files: [file], scratch: s, protected: o.protected });
  const deck = await app.waitForDeck(name);
  return { s, app, deck, file, original };
}

async function close(o: Opened): Promise<void> {
  await o.app.close();
  o.s.cleanup();
}

async function enterEdit(o: Opened): Promise<void> {
  await o.deck.chord('3');
  await until('Edit mode', async () => ((await o.app.win(o.deck.docId)).appMode === 'edit' ? true : undefined));
}

/** A real click on the element's text until the overlay made it the field (its map arrives after first paint, D-9). */
async function openField(deck: DeckView, selector: string): Promise<void> {
  await until(
    `an edit field on ${selector}`,
    async () => {
      await deck.clickText(selector);
      const open = await deck.eval<boolean>(`(function(){var e=document.querySelector(${JSON.stringify(selector)});return !!e && e.isContentEditable && document.activeElement === e;})()`);
      return open ? true : undefined;
    },
    20_000,
  );
  // The end of the field's text (End alone stops at the end of a wrapped line).
  await deck.key('End', ['control']);
}

async function typeKeys(deck: DeckView, text: string): Promise<void> {
  for (const ch of text) await deck.key(ch);
}

async function bytesBecome(file: string, want: Buffer, timeout = 15_000): Promise<void> {
  await until('the file to hold the expected bytes', async () => (fs.readFileSync(file).equals(want) ? true : undefined), timeout).catch(() => undefined);
  expect(fs.readFileSync(file, 'utf8')).toBe(want.toString('utf8'));
}

function replaceOnce(src: string, from: string, to: string): string {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`${JSON.stringify(from)} must occur once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

/** Records every toast the shell shows from now on (its text and its buttons). */
async function watchToasts(shell: Page): Promise<() => Promise<string[]>> {
  await shell.evaluate(() => {
    const g = globalThis as unknown as { __toasts: string[] };
    g.__toasts = [];
    const box = document.getElementById('toast')!;
    new MutationObserver(() => {
      const text = box.querySelector('.toast-text')?.textContent ?? box.textContent;
      if (text && g.__toasts[g.__toasts.length - 1] !== text) g.__toasts.push(text);
    }).observe(box, { childList: true, characterData: true, subtree: true, attributes: true });
  });
  return () => shell.evaluate(() => (globalThis as unknown as { __toasts: string[] }).__toasts.slice());
}

test('@edit a typed edit writes exactly the run, makes an edit note in the panel, and Copy puts its exact texts on the clipboard', async () => {
  const o = await open('decks/single.html');
  try {
    await enterEdit(o);
    await openField(o.deck, 'h1');
    await typeKeys(o.deck, ' & now');
    await o.deck.key('Enter');
    const want = Buffer.from(replaceOnce(o.original.toString('utf8'), '<h1>Analytics your whole team can read</h1>', '<h1>Analytics your whole team can read &amp; now</h1>'), 'utf8');
    await bytesBecome(o.file, want);
    // 6.6 Edit notes: an edit note, done, with before → after, its line, and a lock.
    const w = await until('the edit note', async () => {
      const x = await o.app.win(o.deck.docId);
      return x.state.notes.length === 1 ? x : undefined;
    });
    expect(w.state.notes[0]).toMatchObject({ id: 'n-0001', kind: 'edit', status: 'done', before: 'Analytics your whole team can read', after: 'Analytics your whole team can read & now', locked: 'ok' });
    expect(w.state.notes[0].line).toBeGreaterThan(1);
    const info = (await o.app.editInfo(o.deck.docId))!;
    expect(info.undo).toEqual({ undo: 1, redo: 0 });
    expect(info.history.map((h) => h.cause)).toEqual(['edit']);
    expect(info.locked).toHaveLength(1);
    // The panel (Edit shows it) lists it; Copy goes through main, which writes the clipboard (P2-13).
    const shell = await o.app.shellPage(o.deck.docId);
    const item = shell.locator('#note-list li[data-id="n-0001"]');
    await expect(item.locator('.before')).toHaveText('Analytics your whole team can read');
    await expect(item.locator('.after')).toHaveText('Analytics your whole team can read & now');
    await o.app.electronApp.evaluate(({ clipboard }) => clipboard.writeText('before'));
    await item.locator('button.copy').click();
    const copied = await until('the clipboard', async () => {
      const t = await o.app.electronApp.evaluate(({ clipboard }) => clipboard.readText());
      return t !== 'before' ? t : undefined;
    });
    expect(copied.split('\n')).toEqual([
      `n-0001 · edit · done · single.html:${w.state.notes[0].line}`,
      'Before: Analytics your whole team can read',
      'After: Analytics your whole team can read & now',
    ]);
    // The page shows the text without a reload (html-text, 9.2 Strategy 2 step 5.5).
    expect((await o.app.win(o.deck.docId)).handshakes).toBe(1);
    expect(await o.deck.eval<string>('document.querySelector("h1").textContent')).toBe('Analytics your whole team can read & now');
  } finally {
    await close(o);
  }
});

test('@edit Cmd+Z and Cmd+Shift+Z restore the bytes exactly; the page shows each; undo deletes the note and redo makes a new one', async () => {
  const o = await open('decks/entities.html');
  try {
    const shell = await o.app.shellPage(o.deck.docId);
    const toasts = await watchToasts(shell);
    await enterEdit(o);
    await openField(o.deck, 'h1');
    await typeKeys(o.deck, ' 2026');
    await o.deck.key('Enter');
    const edited = Buffer.from(replaceOnce(o.original.toString('utf8'), '<h1>Research &amp; Development</h1>', '<h1>Research &amp; Development 2026</h1>'), 'utf8');
    await bytesBecome(o.file, edited);
    await until('the field to close', async () => ((await o.deck.eval<boolean>('!!(document.activeElement && document.activeElement.isContentEditable)')) ? undefined : true));
    await sleep(300);
    await o.deck.chord('z');
    await bytesBecome(o.file, o.original);
    await until('the page to show the undo', async () => ((await o.deck.eval<string>('document.querySelector("h1").textContent')) === 'Research & Development' ? true : undefined));
    expect((await o.app.win(o.deck.docId)).state.notes).toEqual([]);
    await until('the Undone toast', async () => ((await toasts()).some((t) => /^Undone · entities\.html:\d+$/.test(t)) ? true : undefined));
    await o.deck.chord('z', ['shift']);
    await bytesBecome(o.file, edited);
    await until('the page to show the redo', async () => ((await o.deck.eval<string>('document.querySelector("h1").textContent')) === 'Research & Development 2026' ? true : undefined));
    const notes = (await o.app.win(o.deck.docId)).state.notes;
    expect(notes.map((n) => [n.id, n.kind])).toEqual([['n-0002', 'edit']]);
    // Neither reloaded the page (an html-text undo is patched in, P2-10).
    expect((await o.app.win(o.deck.docId)).handshakes).toBe(1);
    expect((await o.app.editInfo(o.deck.docId))!.history.map((h) => h.cause)).toEqual(['redo', 'undo', 'edit']);
    // Nothing more to redo.
    await o.deck.chord('z', ['shift']);
    await until('Nothing to redo', async () => ((await toasts()).includes('Nothing to redo') ? true : undefined));
    expect(fs.readFileSync(o.file).equals(edited)).toBe(true);
  } finally {
    await close(o);
  }
});

test("@edit the Saved toast's Undo (in the shell, E-5) undoes that write", async () => {
  const o = await open('decks/single.html');
  try {
    await enterEdit(o);
    const shell = await o.app.shellPage(o.deck.docId);
    await openField(o.deck, 'p.lede');
    await typeKeys(o.deck, ' Today.');
    await o.deck.key('Enter');
    await until('the write', async () => (fs.readFileSync(o.file, 'utf8').includes('in the loop. Today.</p>') ? true : undefined));
    await until('the shell toast with Undo', async () => {
      const t = await shell.evaluate(() => ({ text: document.querySelector('#toast .toast-text')?.textContent ?? '', button: !!document.querySelector('#toast.visible .toast-action') }));
      return t.button && /^Saved · single\.html:\d+$/.test(t.text) ? true : undefined;
    });
    // The overlay shows no second copy.
    expect((await o.deck.editState<{ toast: string }>()).toast).toBe('');
    await shell.click('#toast .toast-action');
    await bytesBecome(o.file, o.original);
    expect((await o.app.win(o.deck.docId)).state.notes).toEqual([]);
  } finally {
    await close(o);
  }
});

test('@edit a literal edit reloads the page once the field closes, and the page shows the new text', async () => {
  const o = await open('decks/json-data.html');
  try {
    await enterEdit(o);
    await o.deck.waitFor(`Array.from(document.querySelectorAll('h1')).some(function(h){return h.textContent === 'A calmer checkout'})`);
    await until('an edit field on the JSON title', async () => {
      await o.deck.eval(`(function(){var hs=Array.from(document.querySelectorAll('h1'));var h=hs.find(function(x){return x.textContent==='A calmer checkout'});hs.forEach(function(x){x.removeAttribute('data-bl-test')});if(h)h.setAttribute('data-bl-test','t');})()`);
      await o.deck.clickText('h1[data-bl-test="t"]');
      return (await o.deck.eval<boolean>('!!(document.activeElement && document.activeElement.isContentEditable)')) ? true : undefined;
    }, 20_000);
    await o.deck.key('End', ['control']);
    await typeKeys(o.deck, ' today');
    const before = (await o.app.win(o.deck.docId)).handshakes;
    await o.deck.key('Enter');
    await until('the JSON string to be written', async () => (fs.readFileSync(o.file, 'utf8').includes('"title": "A calmer checkout today"') ? true : undefined));
    // 9.2 Strategy 2 step 5.5: the page's data still holds the old string until it reloads.
    await until('the reload', async () => ((await o.app.win(o.deck.docId)).handshakes > before ? true : undefined));
    await o.deck.waitFor(`Array.from(document.querySelectorAll('h1')).some(function(h){return h.textContent === 'A calmer checkout today'})`);
    const n = (await o.app.win(o.deck.docId)).state.notes;
    expect(n.map((x) => [x.kind, x.after])).toEqual([['edit', 'A calmer checkout today']]);
  } finally {
    await close(o);
  }
});

test('@edit Restore deck to <time> shows the counts and the diff, asks, and writes the snapshot back byte for byte', async () => {
  const o = await open('decks/single.html');
  try {
    await enterEdit(o);
    await openField(o.deck, 'h1');
    await typeKeys(o.deck, ' one');
    await o.deck.key('Enter');
    await until('the first write', async () => (fs.readFileSync(o.file, 'utf8').includes('can read one</h1>') ? true : undefined));
    await openField(o.deck, 'p.lede');
    await typeKeys(o.deck, ' Two.');
    await o.deck.key('Enter');
    await until('the second write', async () => (fs.readFileSync(o.file, 'utf8').includes('in the loop. Two.</p>') ? true : undefined));
    await o.app.run('history', o.deck.docId);
    const shell = await o.app.shellPage(o.deck.docId);
    await expect(shell.locator('#rail-title')).toHaveText('History');
    const entries = shell.locator('#history-list li.history-entry');
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(1).locator('.history-cause')).toHaveText('before a direct edit');
    // The confirmation is a native dialog (the harness answers Cancel first, then Restore).
    await entries.nth(1).locator('button.history-restore').click();
    await sleep(500);
    expect(fs.readFileSync(o.file, 'utf8')).toContain('in the loop. Two.</p>');
    let h = await o.app.harness();
    const asked = h.dialogs.filter((d) => /^Restore single\.html to /.test(d.message ?? ''));
    expect(asked).toHaveLength(1);
    expect(asked[0].detail).toContain('This discards 2 direct edits since then.');
    expect(asked[0].detail).toContain('− <h1>Analytics your whole team can read one</h1>');
    expect(asked[0].detail).toContain('+ <h1>Analytics your whole team can read</h1>');
    await o.app.answerDialogs(0);
    await entries.nth(1).locator('button.history-restore').click();
    await bytesBecome(o.file, o.original);
    h = await o.app.harness();
    expect(h.dialogs.filter((d) => /^Restore single\.html to /.test(d.message ?? ''))).toHaveLength(2);
    // The page reloads to the restored version; the history keeps what the restore replaced.
    await o.deck.waitFor(`document.querySelector('h1').textContent === 'Analytics your whole team can read'`);
    const info = (await o.app.editInfo(o.deck.docId))!;
    expect(info.history.map((x) => x.cause)).toEqual(['restore', 'edit', 'edit']);
    // The edit notes stay, their locks flagged: the restore discarded them (section 8).
    expect(info.locked.every((l) => l.state === 'violated')).toBe(true);
  } finally {
    await close(o);
  }
});

test('@edit Edit is unavailable in Protected view until Enable editing, which then enters Edit at once', async () => {
  const o = await open('decks/single.html', 'protected.html', { protected: true });
  try {
    const shell = await o.app.shellPage(o.deck.docId);
    const toasts = await watchToasts(shell);
    const editButton = shell.locator('#mode-switch button[data-mode="edit"]');
    await expect(editButton).toBeDisabled();
    await expect(editButton).toHaveAttribute('title', 'This file is in Protected view. Click Enable editing to edit it.');
    const menu = await o.app.electronApp.evaluate(() => (globalThis as unknown as { __blTest: { menu(): Record<string, unknown> } }).__blTest.menu());
    expect(menu.editAvailable).toBe(false);
    await o.deck.chord('3');
    await until('the reason', async () => ((await toasts()).includes('This file is in Protected view. Click Enable editing to edit it.') ? true : undefined));
    expect((await o.app.win(o.deck.docId)).appMode).toBe('read');
    // A click on the text opens nothing and writes nothing.
    await o.deck.clickText('h1');
    await sleep(300);
    expect(await o.deck.eval<boolean>('!!document.querySelector("[contenteditable]")')).toBe(false);
    await shell.locator('#enable-editing').click();
    await until('Edit, at once', async () => ((await o.app.win(o.deck.docId)).appMode === 'edit' ? true : undefined));
    await expect(editButton).toBeEnabled();
    await openField(o.deck, 'h1');
    await typeKeys(o.deck, ' now');
    await o.deck.key('Enter');
    await until('the write', async () => (fs.readFileSync(o.file, 'utf8').includes('can read now</h1>') ? true : undefined));
  } finally {
    await close(o);
  }
});

test('@edit the name chip changes the name on notes: config.json, the session, the chip', async () => {
  const o = await open('decks/single.html');
  try {
    await enterEdit(o);
    await openField(o.deck, 'h1');
    await typeKeys(o.deck, '!');
    await o.deck.key('Enter');
    await until('the edit note', async () => ((await o.app.win(o.deck.docId)).state.notes.length === 1 ? true : undefined));
    const shell = await o.app.shellPage(o.deck.docId);
    const chip = shell.locator('#name-chip');
    await expect(chip).toBeVisible();
    await chip.click();
    const input = shell.locator('#name-input');
    await expect(input).toBeFocused();
    await input.fill('Ada Lovelace');
    await input.press('Enter');
    await expect(chip).toHaveText('Ada Lovelace');
    expect((await o.app.win(o.deck.docId)).state.userName).toBe('Ada Lovelace');
    // The open deck hears it without a reload (MainToDeck.userName): the note card's author chip.
    await until('the deck to hear the new name', async () => ((await o.deck.editState<{ userName?: string }>()).userName === 'Ada Lovelace' ? true : undefined));
    const config = JSON.parse(fs.readFileSync(path.join(o.app.userData, 'config.json'), 'utf8')) as { name: string; personId: string };
    expect(config.name).toBe('Ada Lovelace');
    const sessionFile = (await o.app.win(o.deck.docId)).sessionFile;
    await until('the session to list the new name', async () => {
      const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { people: { id: string; name: string }[] };
      return s.people.some((p) => p.id === config.personId && p.name === 'Ada Lovelace') ? true : undefined;
    });
    // A name the rules refuse keeps the old one and says why.
    const toasts = await watchToasts(shell);
    await chip.click();
    await input.fill('   ');
    await input.press('Enter');
    await until('the reason', async () => ((await toasts()).some((t) => /A name is 1 to 200 characters/.test(t)) ? true : undefined));
    await expect(chip).toHaveText('Ada Lovelace');
  } finally {
    await close(o);
  }
});

test('@edit Settings › General › Smart punctuation reaches an open deck without a reload: curly quotes in a curly run, then straight ones', async () => {
  const o = await open('decks/unicode-edit-points.html');
  try {
    const HEAD = '<h1>Launch plan \u2014 \u201cAtlas\u201d \ud83d\ude80';
    await enterEdit(o);
    expect((await o.deck.editState<{ smartPunctuation?: boolean }>()).smartPunctuation, '6.3: on by default').toBe(true);
    // 6.3: the run already uses curly quotes, so straight ones typed into it are curled.
    await openField(o.deck, 'h1');
    await typeKeys(o.deck, ' "a"');
    await o.deck.key('Enter');
    const curled = replaceOnce(o.original.toString('utf8'), `${HEAD}</h1>`, `${HEAD} \u201ca\u201d</h1>`);
    await bytesBecome(o.file, Buffer.from(curled, 'utf8'));
    const handshakes = (await o.app.win(o.deck.docId)).handshakes;
    // Settings › General turns it off: config.json's defaults, and MainToDeck.settings to the open deck.
    const { page } = await openSettings(o.app, 'general');
    const box = page.locator('#smart-punctuation');
    await expect(box).toBeChecked();
    await box.click();
    await waitConfig(o.app, (c) => (c.defaults as { smartPunctuation?: unknown } | undefined)?.smartPunctuation === false);
    await until('the deck to hear the setting', async () => ((await o.deck.editState<{ smartPunctuation?: boolean }>()).smartPunctuation === false ? true : undefined));
    await page.close();
    await openField(o.deck, 'h1');
    await typeKeys(o.deck, ' "b"');
    await o.deck.key('Enter');
    await bytesBecome(o.file, Buffer.from(replaceOnce(curled, '\u201ca\u201d</h1>', '\u201ca\u201d "b"</h1>'), 'utf8'));
    expect((await o.app.win(o.deck.docId)).handshakes, 'the setting and both html-text writes needed no reload').toBe(handshakes);
  } finally {
    await close(o);
  }
});
