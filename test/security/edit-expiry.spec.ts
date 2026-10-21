// An Edit field's authorisation ends (lead decision E-4; review finding 4; SPEC 9.1, 9.2 Committing an edit; decision
// P2-7). A compromised renderer can send a begin within 2 s of a real press (the press opened no field), and so
// "bank" a field main accepts. That field stays authorised only while it can still be the user's open field:
//   - A: the user leaves Edit; commits sent 11 s later (an edit, and a large verbatim note) are refused;
//   - B: no trusted input in the view for the idle limit (10 minutes; shortened to 10 s here through the test-only
//     BLUELINE_TEST_FIELD_IDLE_MS), still in Edit: refused;
//   - V2: a newer begin replaces the banked field (one field at a time), and a Read -> Edit round trip ends the
//     newer one once main's request window (5 s) has passed: both refused;
//   - control: a commit for a field that was never begun, and a begin with no press, stay refused.
// Every case leaves the file, the notes, session.json, the undo stack and the history unchanged.
//
// From the preload's isolated world (__blTestIpc, test builds), as edit-forged.spec.ts does. Every test needs the
// Edit capability: @edit in each title (the reader-only gate leaves them out).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EditDeckToMain } from '../../packages/core/src/ipc-edit';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

/** Longer than main's press window (2 s): no real press counts for a later forged begin. */
const PRESS_SETTLE_MS = 2_600;
const H1 = 'Analytics your whole team can read';

async function until<T>(what: string, fn: () => Promise<T | undefined>, timeout = 20_000): Promise<T> {
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

async function forge(deck: DeckView, channel: string, payload: unknown): Promise<void> {
  const r = await deck.isolated<string>(
    `(function(){var ipc=globalThis.__blTestIpc;if(!ipc||typeof ipc.send!=='function')return 'no-ipc';ipc.send(${JSON.stringify(channel)}, ${JSON.stringify(payload)});return 'sent';})()`,
    999,
  );
  expect(r, `forge ${channel}`).toBe('sent');
}

interface Facts {
  version: string;
  h1: { id: string; stamp: string; value: string };
  lede: { id: string; stamp: string; value: string };
}

async function pageFacts(deck: DeckView): Promise<Facts> {
  return await until('the overlay map', async () => {
    const raw = await deck.isolated<string>('JSON.stringify(globalThis.__blTestEdit ? globalThis.__blTestEdit.state(true) : null)', 999);
    const st = JSON.parse(raw) as { pageVersion: string | null; blocked: string | null; map?: { runs: { id: string; stamp: string; value: string }[] } | null } | null;
    const h1 = st?.map?.runs.find((r) => r.value === H1);
    const lede = st?.map?.runs.find((r) => r.value.startsWith('Northwind turns'));
    return st?.pageVersion && st.blocked === null && h1 && lede ? { version: st.pageVersion, h1, lede } : undefined;
  });
}

async function mode(app: BlApp, deck: DeckView, key: '1' | '3', want: string): Promise<void> {
  await deck.chord(key);
  await until(`${want} mode`, async () => ((await app.win(deck.docId)).appMode === want ? true : undefined));
}

interface Run {
  s: Scratch;
  app: BlApp;
  deck: DeckView;
  file: string;
  original: string;
  facts: Facts;
}

async function open(env?: Record<string, string>, o: { second?: boolean } = {}): Promise<Run> {
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('edit-expiry');
  const file = copyInto(path.join(FIXTURES, 'decks/single.html'), dir);
  // A second window keeps the app running when the first closes.
  const files = o.second ? [file, copyInto(path.join(FIXTURES, 'decks/single.html'), dir, 'other.html')] : [file];
  s.own(dir);
  const original = fs.readFileSync(file, 'utf8');
  const app = await launchApp({ files, scratch: s, env });
  const deck = await app.waitForDeck('single.html');
  await until('Edit available', async () => ((await app.editInfo(deck.docId))?.availability.available ? true : undefined));
  await mode(app, deck, '3', 'edit');
  const facts = await pageFacts(deck);
  await sleep(PRESS_SETTLE_MS);
  return { s, app, deck, file, original, facts };
}

function editCommit(r: Run, fieldId: number, word: string): Record<string, unknown> {
  const h1 = r.facts.h1;
  return {
    fieldId,
    version: r.facts.version,
    result: { kind: 'edit', runId: h1.id, beforeText: h1.value, afterText: `${h1.value} ${word}` },
    target: { css: 'h1', text: h1.value, role: 'heading', stamp: h1.stamp },
    slide: null,
    alsoPlaces: 0,
  };
}

function verbatimCommit(r: Run, fieldId: number, text: string): Record<string, unknown> {
  const h1 = r.facts.h1;
  return {
    fieldId,
    version: r.facts.version,
    result: { kind: 'verbatim', before: 'x', after: text, why: 'across-runs' },
    target: { css: 'h1', text: h1.value, role: 'heading', stamp: h1.stamp },
    slide: null,
    alsoPlaces: 0,
  };
}

/** Nothing of the forged commits reached the file, the notes, session.json, the undo stack or the history. */
async function untouched(r: Run, words: string[]): Promise<void> {
  await sleep(2000);
  expect(fs.readFileSync(r.file, 'utf8')).toBe(r.original);
  const w = await r.app.win(r.deck.docId);
  expect(w.state.notes).toEqual([]);
  const info = await r.app.editInfo(r.deck.docId);
  expect(info?.undo).toEqual({ undo: 0, redo: 0 });
  expect(info?.history).toEqual([]);
  expect(info?.locked).toEqual([]);
  const sf = w.sessionFile;
  const raw = fs.existsSync(sf) ? fs.readFileSync(sf, 'utf8') : '';
  for (const word of words) expect(raw.includes(word), `session.json holds ${word}`).toBe(false);
  expect(r.app.logsMatching(/commit refused/).length).toBeGreaterThan(0);
}

async function close(r: Run): Promise<void> {
  await r.app.close().catch(() => undefined);
  r.s.cleanup();
}

test('@edit A: fields banked on presses in Edit, then Read, then committed 11 s later: refused, nothing changes', async () => {
  const r = await open();
  try {
    await r.deck.click(6, 6); // a press on a blank area: no field opens
    await forge(r.deck, EditDeckToMain.begin, { fieldId: 9001, version: r.facts.version, runIds: [r.facts.h1.id, r.facts.lede.id] });
    await sleep(300);
    await r.deck.key('ArrowDown');
    await forge(r.deck, EditDeckToMain.begin, { fieldId: 9002, version: r.facts.version, runIds: [r.facts.lede.id] });
    await sleep(3000);
    await mode(r.app, r.deck, '1', 'read');
    await sleep(8000);
    // Control: a field never begun.
    await forge(r.deck, EditDeckToMain.commit, editCommit(r, 9999, 'CONTROL'));
    await forge(r.deck, EditDeckToMain.commit, editCommit(r, 9001, 'FORGED-LATE'));
    await sleep(500);
    await forge(r.deck, EditDeckToMain.commit, verbatimCommit(r, 9002, 'FORGED NOTE '.repeat(1000)));
    await untouched(r, ['CONTROL', 'FORGED-LATE', 'FORGED NOTE']);
  } finally {
    await close(r);
  }
});

test('@edit B: a field banked on a press, then no trusted input for the idle limit (10 s in this test), still in Edit: refused', async () => {
  const r = await open({ BLUELINE_TEST_FIELD_IDLE_MS: '10000' });
  try {
    // Control: a begin with no press in the last 2 s is not taken, and its commit is refused.
    await forge(r.deck, EditDeckToMain.begin, { fieldId: 7001, version: r.facts.version, runIds: [r.facts.lede.id] });
    await sleep(300);
    await forge(r.deck, EditDeckToMain.commit, { ...editCommit(r, 7001, 'CTRL-C'), result: { kind: 'edit', runId: r.facts.lede.id, beforeText: r.facts.lede.value, afterText: `${r.facts.lede.value} CTRL-C` } });
    await r.deck.key('ArrowDown');
    await forge(r.deck, EditDeckToMain.begin, { fieldId: 9101, version: r.facts.version, runIds: [r.facts.h1.id] });
    await sleep(13_000);
    expect((await r.app.win(r.deck.docId)).appMode).toBe('edit');
    await forge(r.deck, EditDeckToMain.commit, editCommit(r, 9101, 'IDLE-13S'));
    await untouched(r, ['CTRL-C', 'IDLE-13S']);
  } finally {
    await close(r);
  }
});

test('@edit V2: a newer begin replaces a banked field, and a Read -> Edit round trip ends the newer one: both refused', async () => {
  const r = await open();
  try {
    await r.deck.click(6, 6);
    await forge(r.deck, EditDeckToMain.begin, { fieldId: 7101, version: r.facts.version, runIds: [r.facts.h1.id] });
    await sleep(500);
    await r.deck.click(6, 6);
    await forge(r.deck, EditDeckToMain.begin, { fieldId: 7102, version: r.facts.version, runIds: [r.facts.h1.id] });
    await sleep(3000);
    // 7101 was replaced by 7102 (the deck has one open field).
    await forge(r.deck, EditDeckToMain.commit, editCommit(r, 7101, 'LATE-REPLACED'));
    await sleep(500);
    await mode(r.app, r.deck, '1', 'read');
    await sleep(1000);
    await mode(r.app, r.deck, '3', 'edit');
    // Past main's request window for the field open at the switch (COMMIT_REQUEST_WINDOW_MS, 5 s).
    await sleep(6000);
    await forge(r.deck, EditDeckToMain.commit, verbatimCommit(r, 7102, 'LATE VERBATIM'));
    await untouched(r, ['LATE-REPLACED', 'LATE VERBATIM']);
  } finally {
    await close(r);
  }
});

test('@edit control: a real click, real keys and Enter still write (the expiry does not stop the user)', async () => {
  const r = await open();
  try {
    const p = await r.deck.eval<{ x: number; y: number } | null>(
      `(function(){var e=document.querySelector('h1');var w=document.createTreeWalker(e,4),t,last=null;while((t=w.nextNode()))if(t.data.trim())last=t;` +
        `var g=document.createRange();g.setStart(last,last.data.length-1);g.setEnd(last,last.data.length);var b=g.getBoundingClientRect();return {x:b.right-1,y:b.top+b.height/2};})()`,
    );
    const zoom = await r.app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor() ?? 1, r.deck.wcId);
    await until('a field on the heading', async () => {
      await r.deck.click(p!.x * zoom, p!.y * zoom);
      return (await r.deck.editState<{ field: unknown }>()).field ? true : undefined;
    });
    await r.deck.key('End', ['control']);
    for (const ch of ' real') await r.deck.key(ch);
    await r.deck.key('Enter');
    await until('the write', async () => (fs.readFileSync(r.file, 'utf8').includes(`${H1} real</h1>`) ? true : undefined));
  } finally {
    await close(r);
  }
});

// The bound on a banked field, as SECURITY.md (Known limits) states it: E-4's idle limit ends its authorisation, but
// the one commit main itself asks for (E-2: the window closes, the app quits, the shell takes focus, Edit is left)
// is taken within that request's window, so the words of a user who typed, walked away and then closed the window
// are kept. A compromised renderer that banked a field gets that one commit, in Edit, undoable; nothing more.
// The close's log says the commit was taken (finding 4 re-verification: it said "nothing it held was kept").
test('@edit V-close: a banked field idle past the limit, then File > Close: the one commit main asks for is taken, a second is refused, and the log says so', async () => {
  const r = await open({ BLUELINE_TEST_FIELD_IDLE_MS: '10000' }, { second: true });
  try {
    await r.deck.key('ArrowDown');
    await forge(r.deck, EditDeckToMain.begin, { fieldId: 9201, version: r.facts.version, runIds: [r.facts.h1.id] });
    // The deck says a field is open (a real one would), so the close asks it to commit.
    await forge(r.deck, EditDeckToMain.busy, { edit: true, committing: false });
    await sleep(12_000);
    const docId = r.deck.docId;
    await r.app.run('close', docId);
    await forge(r.deck, EditDeckToMain.commit, editCommit(r, 9201, 'IDLE-CLOSE'));
    await until('the write', async () => (fs.readFileSync(r.file, 'utf8').includes(`${H1} IDLE-CLOSE</h1>`) ? true : undefined), 10_000);
    // The same field once more: one commit per request.
    await forge(r.deck, EditDeckToMain.commit, editCommit(r, 9201, 'IDLE-AGAIN')).catch(() => undefined);
    await until('the window to close', async () => ((await r.app.docIds()).includes(docId) ? undefined : true), 15_000);
    expect(fs.readFileSync(r.file, 'utf8')).not.toContain('IDLE-AGAIN');
    expect(r.app.logsMatching(/the deck did not answer before closing/)).toEqual([]);
    expect(r.app.logsMatching(/the deck's commit was taken, but it still reports an open field/).length).toBe(1);
  } finally {
    await close(r);
  }
});

