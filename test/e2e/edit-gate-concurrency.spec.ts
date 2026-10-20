// The Phase 2 concurrency gate and "external write during an edit" (SPEC 10 Phase 2 exit gate "Concurrency. An
// external write lands 50 ms before a direct edit commits. The edit lands on the right text, or becomes a verbatim
// note, and the external change survives either way"; 11 E2E "external write during an edit"; 9.2 Write protocol
// steps 2–4 and Watcher; P2-3, P2-4, P2-5; docs/PHASE2-PLAN.md Exit gate).
//
// Each test opens a field in Edit with real input, types, has another program replace the file (write a temp file
// and rename it over the deck, as editors and agents save), and commits. The file on disk is the oracle: it must
// hold the external change and, at the heading's text, either the edit or the text the external write left (then a
// verbatim note holds the edit). Never anything else: an edit written to another element fails.
//
// The variants: an unrelated change 50 ms before the commit; the same text rewritten 50 ms before (the edit must
// become a note); an element inserted before the target 50 ms before (every stamp after it shifts, so a stale run id
// paired with the new version would name another element); a change that arrives while the field stays open long
// enough for the watcher to decide (the reload waits for the field); and a write that lands inside the atomic write,
// after the temp file and before the re-hash (a one-shot test hook in main). The window between the re-hash and the
// rename is the protocol's stated limit (9.2 Atomic write steps 3–4): an external write there is lost; it is not
// tested here because nothing can observe it before it happens.
//
// Every test needs the Edit capability: @edit in each title (the reader-only gate leaves them out).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const HEADING = 'Analytics your whole team can read';
const TYPED = ' now';

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
}

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

async function typeKeys(deck: DeckView, text: string): Promise<void> {
  for (const ch of text) await deck.key(ch);
}

/**
 * Another program saves the deck: a temp file in the same folder, owned like the deck (the app runs as bltest), then
 * a rename over it. Returns the bytes written.
 */
function externalSave(s: Scratch, file: string, text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  const tmp = path.join(path.dirname(file), `.external-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, bytes);
  s.own(tmp);
  fs.renameSync(tmp, file);
  return bytes;
}

function replaceOnce(src: string, from: string, to: string): string {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`${JSON.stringify(from)} must occur once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

/** Waits until the file stops changing (two equal reads 500 ms apart) and returns it. */
async function settled(file: string, timeout = 20_000): Promise<string> {
  let last = fs.readFileSync(file, 'utf8');
  return until(
    'the file to settle',
    async () => {
      await sleep(500);
      const now = fs.readFileSync(file, 'utf8');
      const same = now === last;
      last = now;
      return same ? now : undefined;
    },
    timeout,
  );
}

interface Opened {
  s: Scratch;
  app: BlApp;
  deck: DeckView;
  file: string;
  original: string;
}

async function openEditing(fixture: string, name: string): Promise<Opened> {
  const s = scratch();
  const dir = s.dir('edit-race');
  const file = copyInto(path.join(FIXTURES, fixture), dir, name);
  s.own(dir);
  const original = fs.readFileSync(file, 'utf8');
  const app = await launchApp({ files: [file], scratch: s });
  const deck = await app.waitForDeck(name);
  await enterEdit(app, deck);
  return { s, app, deck, file, original };
}

/**
 * The document's verbatim notes as session.json holds them (6.6; section 8): the exact texts are there, not in the
 * notes list's one-line summary. Written by main's coalescing writer, so read until it has landed.
 */
async function verbatimNotes(app: BlApp, docId: string): Promise<{ before: string; after: string }[]> {
  const file = (await app.win(docId)).sessionFile;
  try {
    const session = JSON.parse(fs.readFileSync(file, 'utf8')) as { notes?: { kind?: string; verbatim?: { before: string; after: string } }[] };
    return (session.notes ?? []).filter((n) => n.kind === 'verbatim' && n.verbatim).map((n) => n.verbatim!);
  } catch {
    return [];
  }
}

/**
 * The gate's oracle: the external change survived, and the heading holds the edit (`landed`) or the external text
 * with the edit kept as a verbatim note (`note`). Anything else (the edit on another element, a lost change) fails.
 */
async function judge(o: Opened, external: string, outcome: { landed: string; noteOk: boolean }): Promise<'landed' | 'note'> {
  // Wait for the edit's own outcome, then for the file to settle. A quiet file alone is no outcome: under the full
  // suite's load a requeued write (9.2 Atomic write step 3) can land more than a second after the external write,
  // and two equal reads 500 ms apart in between once made this oracle judge the external bytes alone.
  // The note holds the exact text before and after (SPEC 10 Phase 2: "the note holds the exact before and after").
  const hasNote = async (): Promise<boolean> =>
    (await verbatimNotes(o.app, o.deck.docId)).some((n) => n.before === HEADING && n.after === HEADING + TYPED);
  let decided: 'landed' | 'note';
  try {
    decided = await until(
      'the edit to land or become a verbatim note',
      async () => (fs.readFileSync(o.file, 'utf8') === outcome.landed ? 'landed' : (await hasNote()) ? 'note' : undefined),
      30_000,
    );
  } catch (e) {
    const tail = o.app.logs.filter((l) => l.startsWith('[blueline]')).slice(-30).join('\n');
    throw new Error(`${e instanceof Error ? e.message : String(e)}; the file is:\n${fs.readFileSync(o.file, 'utf8')}\nmain's log:\n${tail}`);
  }
  const now = await settled(o.file);
  if (decided === 'landed') {
    expect(now, 'nothing changes the file after the edit landed').toBe(outcome.landed);
    return 'landed';
  }
  expect(outcome.noteOk, `the edit did not land, and a note is not an acceptable outcome here; the file is:\n${now}`).toBe(true);
  expect(now, 'when the edit becomes a note the file is exactly what the external write left').toBe(external);
  return 'note';
}

test('@edit an unrelated external write 50 ms before the commit: the edit lands on its heading and the change survives', async () => {
  const o = await openEditing('decks/single.html', 'race-unrelated.html');
  try {
    await openField(o.deck, 'h1');
    await typeKeys(o.deck, TYPED);
    const external = replaceOnce(o.original, 'Book a demo', 'Book a call today');
    externalSave(o.s, o.file, external);
    await sleep(50);
    await o.deck.key('Enter');
    const landed = replaceOnce(external, `<h1>${HEADING}</h1>`, `<h1>${HEADING}${TYPED}</h1>`);
    // The heading's text is unchanged by the external write, so the queue finds it by its text (9.2 step 2).
    expect(await judge(o, external, { landed, noteOk: false })).toBe('landed');
    // The page reloads after the field closed (the edit absorbed an external change, P2-4) and shows both.
    await until('the page to show both changes', async () =>
      (await o.deck.eval<boolean>(`document.querySelector('h1').textContent === ${JSON.stringify(HEADING + TYPED)} && document.body.textContent.includes('Book a call today')`)) ? true : undefined,
    );
  } finally {
    await o.app.close();
    o.s.cleanup();
  }
});

test('@edit the same text rewritten 50 ms before the commit: the edit becomes a verbatim note and the file is the external write', async () => {
  const o = await openEditing('decks/single.html', 'race-same.html');
  try {
    await openField(o.deck, 'h1');
    await typeKeys(o.deck, TYPED);
    const external = replaceOnce(o.original, `<h1>${HEADING}</h1>`, '<h1>Dashboards for everyone</h1>');
    const bytes = externalSave(o.s, o.file, external);
    await sleep(50);
    await o.deck.key('Enter');
    // The text the edit was made on is gone: never write over the external text (9.2 step 2: "Stale offsets are
    // never applied").
    expect(await judge(o, external, { landed: '\u0000never', noteOk: true })).toBe('note');
    expect(fs.readFileSync(o.file).equals(bytes)).toBe(true);
  } finally {
    await o.app.close();
    o.s.cleanup();
  }
});

test('@edit an element inserted before the heading 50 ms before the commit: the edit lands on the heading, never on a shifted stamp', async () => {
  const o = await openEditing('decks/single.html', 'race-insert.html');
  try {
    await openField(o.deck, 'h1');
    await typeKeys(o.deck, TYPED);
    // A new element with text before the heading: every data-bl-e stamp from here on shifts by one.
    const external = replaceOnce(o.original, '<div class="brand">Northwind Labs</div>', '<div class="brand">Northwind Labs</div>\n  <p class="banner">New banner from the agent</p>');
    externalSave(o.s, o.file, external);
    await sleep(50);
    await o.deck.key('Enter');
    const landed = replaceOnce(external, `<h1>${HEADING}</h1>`, `<h1>${HEADING}${TYPED}</h1>`);
    const outcome = await judge(o, external, { landed, noteOk: true });
    // Either is the right outcome; the file is never anything else (judge checked it). Recorded for the results.
    test.info().annotations.push({ type: 'outcome', description: outcome });
    expect(['landed', 'note']).toContain(outcome);
  } finally {
    await o.app.close();
    o.s.cleanup();
  }
});

test('@edit an external write while the field stays open: the reload waits for the field, then both changes are on disk and on the page', async () => {
  const o = await openEditing('decks/single.html', 'race-open.html');
  try {
    await openField(o.deck, 'h1');
    await typeKeys(o.deck, TYPED);
    const external = replaceOnce(o.original, 'Book a demo', 'Book a call today');
    externalSave(o.s, o.file, external);
    // Long enough for the watcher to settle (150 + 50 ms) and decide: the reload must wait for the open field
    // (SPEC 6.6, Phase 2 scope "deferring reloads while an edit is open"; P2-5).
    await sleep(1500);
    expect(await o.deck.eval<boolean>('document.activeElement && document.activeElement.isContentEditable'), 'the field is still open: no reload took it away').toBe(true);
    expect(await o.deck.eval<string>('document.querySelector("h1").textContent'), 'what was typed is still in the field').toBe(HEADING + TYPED);
    await o.deck.key('Enter');
    const landed = replaceOnce(external, `<h1>${HEADING}</h1>`, `<h1>${HEADING}${TYPED}</h1>`);
    expect(await judge(o, external, { landed, noteOk: false })).toBe('landed');
    await until('the page to show both changes', async () =>
      (await o.deck.eval<boolean>(`document.querySelector('h1').textContent === ${JSON.stringify(HEADING + TYPED)} && document.body.textContent.includes('Book a call today')`)) ? true : undefined,
    );
  } finally {
    await o.app.close();
    o.s.cleanup();
  }
});

test('@edit an external write inside the atomic write, before the re-hash: the write is requeued, the edit lands on its heading and the change survives', async () => {
  const o = await openEditing('decks/single.html', 'race-inside.html');
  try {
    await openField(o.deck, 'h1');
    await typeKeys(o.deck, TYPED);
    const external = replaceOnce(o.original, 'Book a demo', 'Book a call today');
    // One-shot hook in main (BLUELINE_TEST only): on this document's next deck write, after the temp file has its
    // bytes and attributes and before the re-hash (atomic-write prepareTemp), these bytes replace the deck.
    const armed = await o.app.electronApp.evaluate(
      (_e, a) => {
        const t = (globalThis as unknown as { __blTest?: { onceBeforeRehash?: (docId: string, base64: string) => boolean } }).__blTest;
        return typeof t?.onceBeforeRehash === 'function' ? t.onceBeforeRehash(a.docId, a.bytes) : null;
      },
      { docId: o.deck.docId, bytes: Buffer.from(external, 'utf8').toString('base64') },
    );
    expect(armed, 'main exposes __blTest.onceBeforeRehash(docId, base64) (contract request to main-wiring)').toBe(true);
    await o.deck.key('Enter');
    const landed = replaceOnce(external, `<h1>${HEADING}</h1>`, `<h1>${HEADING}${TYPED}</h1>`);
    // 9.2 Atomic write step 3: the re-hash sees the external write, the write aborts and is requeued, and the
    // requeued write finds the heading by its text.
    expect(await judge(o, external, { landed, noteOk: true })).toBe('landed');
  } finally {
    await o.app.close();
    o.s.cleanup();
  }
});
