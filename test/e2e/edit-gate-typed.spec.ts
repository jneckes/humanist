// The Phase 2 exit gate's typed edit (SPEC 11 E2E: "open a fixture, enter Edit mode, type into a heading, and
// assert the file bytes"; 10 Phase 2; 9.2 Committing an edit and Write protocol; P2-7). Real input only: a real
// click opens the field, keys are typed through sendInputEvent (main sees them in before-input-event), Enter
// commits (insertParagraph). The file on disk is the oracle, compared byte for byte with what the write protocol
// must produce: only the run's raw range changes, new `&` and `<` are encoded, untouched references keep their
// spelling, and app undo and redo restore the bytes exactly (9.2 Undo and redo).
//
// Every test here needs the Edit capability: their titles carry @edit, so the reader-only gate
// (scripts/reader-only-check.mjs, --grep-invert @edit) leaves them out.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
}

/** Polls until `fn` returns a value other than undefined, or throws with `what`. */
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

/** Cmd/Ctrl+3, then waits for main to say Edit. */
async function enterEdit(app: BlApp, deck: DeckView): Promise<void> {
  await deck.chord('3');
  await until('Edit mode', async () => ((await app.win(deck.docId)).appMode === 'edit' ? true : undefined));
}

/**
 * A real click at the end of the element's text, retried until the overlay has made the element the edit field
 * (the map arrives after first paint, D-9, and the overlay matches only once it is complete, P2-6). The browser
 * puts the caret where the author pressed, so the caret ends up after the last character. (End would go only to
 * the end of the visual line: a heading that wraps keeps its caret mid-text.)
 */
async function openField(deck: DeckView, selector: string): Promise<void> {
  const endOf = `(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});` +
    `var w=document.createTreeWalker(e,4),n,last=null;while((n=w.nextNode()))if(n.data.trim())last=n;if(!last)return null;` +
    `var r=document.createRange();r.setStart(last,last.data.length-1);r.setEnd(last,last.data.length);var b=r.getBoundingClientRect();` +
    `return {x:b.right-1,y:b.top+b.height/2};})()`;
  const atEnd = `(function(){var e=document.querySelector(${JSON.stringify(selector)});var s=getSelection();` +
    `return !!e && e.isContentEditable && document.activeElement===e && !!s.anchorNode && s.anchorNode.nodeType===3 && s.anchorOffset===s.anchorNode.data.length && s.anchorNode===(function(){var w=document.createTreeWalker(e,4),n,l=null;while((n=w.nextNode()))if(n.data.trim())l=n;return l;})();})()`;
  await until(
    `an edit field on ${selector}, the caret at its end`,
    async () => {
      const p = await deck.eval<{ x: number; y: number } | null>(endOf);
      if (!p) return undefined;
      // The page's CSS px times the view's zoom (Fit scales a deck view with setZoomFactor) are the view's px.
      const zoom = ((await deck.app.win(deck.docId)) as unknown as { zoomFactor?: number }).zoomFactor ?? 1;
      await deck.click(p.x * zoom, p.y * zoom);
      return (await deck.eval<boolean>(atEnd)) ? true : undefined;
    },
    20_000,
  );
}

/** Types text key by key (keyDown, char, keyUp): trusted input main sees (P2-7). */
async function typeKeys(deck: DeckView, text: string): Promise<void> {
  for (const ch of text) await deck.key(ch);
}

async function waitForBytes(file: string, want: Buffer, timeout = 15_000): Promise<void> {
  await until(
    'the file to hold the expected bytes',
    async () => (fs.readFileSync(file).equals(want) ? true : undefined),
    timeout,
  ).catch((e) => {
    // Show the difference: the test's own assertion below prints both texts.
    expect(fs.readFileSync(file, 'utf8'), String(e)).toBe(want.toString('utf8'));
  });
}

/** `src` with `from` (which must occur exactly once) replaced by `to`. */
function replaceOnce(src: string, from: string, to: string): string {
  const at = src.indexOf(from);
  expect(at, `${JSON.stringify(from)} occurs in the fixture`).toBeGreaterThanOrEqual(0);
  expect(src.indexOf(from, at + 1), `${JSON.stringify(from)} occurs once in the fixture`).toBe(-1);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

test('@edit typing into a heading writes exactly the run\'s new bytes, & and < encoded, nothing else touched', async () => {
  const s = scratch();
  const dir = s.dir('edit-typed');
  const file = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  s.own(dir);
  const original = fs.readFileSync(file, 'utf8');
  const app = await launchApp({ files: [file], scratch: s });
  try {
    const deck = await app.waitForDeck('single.html');
    await enterEdit(app, deck);
    await openField(deck, 'h1');
    await typeKeys(deck, ' & <b>');
    await deck.key('Enter');
    // 9.2 Strategy 1 step 5: & and < encoded, > left as it is; only the heading's text range changes.
    const want = replaceOnce(original, '<h1>Analytics your whole team can read</h1>', '<h1>Analytics your whole team can read &amp; &lt;b></h1>');
    await waitForBytes(file, Buffer.from(want, 'utf8'));
    expect(fs.readFileSync(file, 'utf8')).toBe(want);
    // The page shows the text as typed, without a reload (html-text writes need none, 9.2 Strategy 2 step 5.5).
    expect(await deck.eval<string>('document.querySelector("h1").textContent')).toBe('Analytics your whole team can read & <b>');
    expect((await app.win(deck.docId)).state.notes.filter((n) => n.kind === 'verbatim')).toEqual([]);
  } finally {
    await app.close();
    s.cleanup();
  }
});

test('@edit a heading with a character reference keeps the reference\'s spelling; undo and redo restore the bytes exactly', async () => {
  const s = scratch();
  const dir = s.dir('edit-entities');
  const file = copyInto(path.join(FIXTURES, 'decks/entities.html'), dir);
  s.own(dir);
  const original = fs.readFileSync(file);
  const app = await launchApp({ files: [file], scratch: s });
  try {
    const deck = await app.waitForDeck('entities.html');
    await enterEdit(app, deck);
    await openField(deck, 'h1');
    await typeKeys(deck, ' 2026');
    await deck.key('Enter');
    const edited = Buffer.from(replaceOnce(original.toString('utf8'), '<h1>Research &amp; Development</h1>', '<h1>Research &amp; Development 2026</h1>'), 'utf8');
    await waitForBytes(file, edited);
    expect(fs.readFileSync(file).equals(edited)).toBe(true);
    // App undo outside the field (P2-10; 9.2 Undo and redo case 1): the previous bytes exactly.
    await sleep(300);
    await deck.chord('z');
    await waitForBytes(file, original);
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    // Redo: the same splice the other way.
    await deck.chord('z', ['shift']);
    await waitForBytes(file, edited);
    expect(fs.readFileSync(file).equals(edited)).toBe(true);
  } finally {
    await app.close();
    s.cleanup();
  }
});

test('@edit Esc cancels: the field closes and the file is byte-identical', async () => {
  const s = scratch();
  const dir = s.dir('edit-cancel');
  const file = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  s.own(dir);
  const original = fs.readFileSync(file);
  const app = await launchApp({ files: [file], scratch: s });
  try {
    const deck = await app.waitForDeck('single.html');
    await enterEdit(app, deck);
    await openField(deck, 'h1');
    await typeKeys(deck, ' draft');
    await deck.key('Escape');
    await until('the field to close', async () => ((await deck.eval<boolean>('document.activeElement && document.activeElement.isContentEditable')) ? undefined : true));
    await sleep(1000);
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect(await deck.eval<string>('document.querySelector("h1").textContent')).toBe('Analytics your whole team can read');
  } finally {
    await app.close();
    s.cleanup();
  }
});
