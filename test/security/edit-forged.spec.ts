// Edit's channels under a compromised renderer and a hostile page (SPEC 9.1 Preload: "Main treats every message
// from a deck view as written by the page"; 9.2 Write protocol; decision P2-7: main takes an edit only from a field
// a trusted press opened, in Edit, with the Edit capability on and editing allowed; P2-14: the toast's Undo names the
// latest undoable write, right after a click).
//
// From the preload's isolated world (__blTestIpc, test builds), a compromised renderer sends well-formed Edit
// messages naming the page's real version and run: begins and commits with no user input, undo tokens (made up, and
// the real one it was sent), candidate requests and busy messages. From the page's own main world, a script fakes the
// input (synthetic mouse and key events, focus, execCommand) with no access to IPC at all. In a Trusted deck in Edit
// and in a Protected deck: no byte of the file changes, and no note, lock, undo step, history entry or trust state.
//
// Positive controls (9.9): in the same Trusted deck, a real click, real keys and Enter write the file, and make the
// note, the undo step and the history entry these checks read; app undo (Cmd+Z, real keys) takes it back.
//
// Every test needs the Edit capability: @edit in each title (the reader-only gate leaves them out).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import { EditDeckToMain, MainToDeckEdit } from '../../packages/core/src/ipc-edit';
import { Scratch, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';
import { openFixture, type SecuritySession } from '../helpers/security';

test.describe.configure({ mode: 'serial' });

const HEADING = 'A plain document for the forged-IPC test';
/** Longer than main's press window (edit-session.ts PRESS_WINDOW_MS, 2 s): no real press counts for a forged message. */
const PRESS_SETTLE_MS = 2_600;

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

/** The page's version and the heading's run, as the overlay holds them (so the forged messages name real ones). */
interface PageFacts {
  version: string;
  runId: string;
  stamp: string;
}

async function pageFacts(deck: DeckView): Promise<PageFacts> {
  return await until('the overlay map', async () => {
    const raw = await deck.isolated<string>('JSON.stringify(globalThis.__blTestEdit ? globalThis.__blTestEdit.state(true) : null)', 999);
    const st = JSON.parse(raw) as { pageVersion: string | null; map?: { runs: { id: string; stamp: string; value: string }[] } | null } | null;
    const run = st?.map?.runs.find((r) => r.value.startsWith(HEADING));
    return st?.pageVersion && run ? { version: st.pageVersion, runId: run.id, stamp: run.stamp } : undefined;
  });
}

/** Sends one message from the preload's isolated world (world 999), as a compromised renderer would. */
async function forge(deck: DeckView, channel: string, payload: unknown): Promise<void> {
  const r = await deck.isolated<string>(
    `(function(){
      var ipc = globalThis.__blTestIpc;
      if (!ipc || typeof ipc.send !== 'function') return 'no-ipc';
      ipc.send(${JSON.stringify(channel)}, ${JSON.stringify(payload)});
      return 'sent';
    })()`,
    999,
  );
  expect(r, `forge ${channel}`).toBe('sent');
}

/** Records every Edit message main sends this deck from now on (results, candidates, applied undos). */
async function listen(deck: DeckView): Promise<() => Promise<{ channel: string; payload: Record<string, unknown> }[]>> {
  const channels = Object.values(MainToDeckEdit);
  await deck.isolated(
    `(function(){
      var ipc = globalThis.__blTestIpc;
      globalThis.__blHeard = [];
      ${JSON.stringify(channels)}.forEach(function (c) {
        ipc.on(c, function (_e, p) { globalThis.__blHeard.push({ channel: c, payload: JSON.parse(JSON.stringify(p)) }); });
      });
      return true;
    })()`,
    999,
  );
  return async () => JSON.parse(await deck.isolated<string>('JSON.stringify(globalThis.__blHeard || [])', 999)) as never;
}

/** Everything a forged Edit message could change: the file's bytes, notes, locks, undo, history, trust, mode. */
async function observe(s: SecuritySession, file: string) {
  const w = await s.app.win(s.docId);
  const e = (await s.app.editInfo(s.docId))!;
  return {
    bytes: fs.readFileSync(file).toString('base64'),
    notes: w.state.notes.length,
    locked: e.locked.length,
    undo: e.undo,
    history: e.history.length,
    version: e.version,
    trust: w.trust,
    editingAllowed: w.editingAllowed,
    networkAllowed: w.networkAllowed,
    appMode: w.appMode,
  };
}

/** Every Edit message a compromised renderer can send without input, naming the page's real version and run. */
async function forgeAll(deck: DeckView, page: PageFacts, token: string): Promise<void> {
  const target = { css: 'h1#heading', text: HEADING, role: 'heading', stamp: page.stamp };
  const commit = (fieldId: number, result: unknown, extra: Record<string, unknown> = {}) => ({ fieldId, version: page.version, result, target, slide: null, alsoPlaces: 0, ...extra });
  const edit = { kind: 'edit', runId: page.runId, beforeText: HEADING, afterText: `${HEADING} FORGED` };
  // A begin then its commit, as the overlay would send them, with no press behind the begin.
  await forge(deck, EditDeckToMain.begin, { fieldId: 9001, version: page.version, runIds: [page.runId] });
  await forge(deck, EditDeckToMain.busy, { edit: true, committing: false });
  await forge(deck, EditDeckToMain.commit, commit(9001, edit));
  await forge(deck, EditDeckToMain.busy, { edit: true, committing: true });
  // Commits of fields main never took: an edit, an equal pick, a substring pick, a verbatim note, a noop.
  await forge(deck, EditDeckToMain.commit, commit(9002, edit));
  await forge(deck, EditDeckToMain.commit, commit(9003, edit, { pick: { kind: 'equal', nodeBefore: HEADING, nodeAfter: `${HEADING} FORGED` } }));
  await forge(deck, EditDeckToMain.commit, commit(9004, { ...edit, beforeText: 'plain', afterText: 'FORGED' }, { pick: { kind: 'substring', nodeBefore: HEADING, nodeAfter: HEADING.replace('plain', 'FORGED') } }));
  await forge(deck, EditDeckToMain.commit, commit(9005, { kind: 'verbatim', before: HEADING, after: 'FORGED NOTE', why: 'across-runs' }));
  await forge(deck, EditDeckToMain.commit, commit(9006, { kind: 'noop' }));
  // The picker's context, and the toast's Undo.
  await forge(deck, EditDeckToMain.candidates, { fieldId: 9007, version: page.version, runIds: [page.runId] });
  await forge(deck, EditDeckToMain.undo, { token });
  await forge(deck, EditDeckToMain.undo, { token: '0123456789abcdef0123456789abcdef' });
  await forge(deck, EditDeckToMain.busy, { edit: false, committing: false });
}

async function enterEdit(s: SecuritySession): Promise<void> {
  await s.deck.chord('3');
  await until('Edit mode', async () => ((await s.app.win(s.docId)).appMode === 'edit' ? true : undefined));
}

/** A real click on the heading's text until the overlay made it the field (its map arrives after first paint, D-9). */
async function openField(deck: DeckView): Promise<void> {
  await until('an edit field on the heading', async () => {
    await deck.clickText('#heading');
    const open = await deck.eval<boolean>(`(function(){var e=document.getElementById('heading');return !!e && e.isContentEditable && document.activeElement === e;})()`);
    return open ? true : undefined;
  });
  await deck.key('End', ['control']);
}

function editLogs(app: BlApp): string[] {
  return app.logsMatching(/began (outside Edit|without trusted input)|commit refused|picker request outside Edit/);
}

test('@edit forged begins, commits, undo tokens, candidate requests and busy messages from a Trusted deck in Edit write nothing; real input does', async () => {
  const sc = new Scratch(resolveRunAs());
  const s = await openFixture({ scratch: sc, fixture: 'ipc.html', trust: 'trusted' });
  try {
    const file = s.folder.file('ipc.html');
    const original = fs.readFileSync(file);
    await until('Edit available', async () => ((await s.app.editInfo(s.docId))?.availability.available ? true : undefined));
    await enterEdit(s);
    const page = await pageFacts(s.deck);
    const heard = await listen(s.deck);
    await sleep(PRESS_SETTLE_MS);
    const before = await observe(s, file);
    expect(before).toMatchObject({ trust: 'trusted', editingAllowed: true, appMode: 'edit', notes: 0, locked: 0, undo: { undo: 0, redo: 0 }, history: 0 });

    await forgeAll(s.deck, page, '0123456789abcdef0123456789abcdee');
    await sleep(1_500);

    // Nothing written, recorded or changed; main answered no forged commit and listed no candidates.
    expect(await observe(s, file)).toEqual(before);
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect(await heard(), 'main answered a forged message').toEqual([]);
    expect(editLogs(s.app).length, 'main never saw the forged messages').toBeGreaterThan(0);

    // Positive control: a real click, real keys and Enter write the run, and the note, lock, undo step and history
    // entry appear where the checks above looked.
    await openField(s.deck);
    for (const ch of ' ok') await s.deck.key(ch);
    await s.deck.key('Enter');
    const want = original.toString('utf8').replace(`>${HEADING}</h1>`, `>${HEADING} ok</h1>`);
    await until('the real edit on disk', async () => (fs.readFileSync(file, 'utf8') === want ? true : undefined));
    const written = await until('the edit note, undo step and history entry', async () => {
      const o = await observe(s, file);
      return o.notes === 1 && o.locked === 1 && o.undo.undo === 1 && o.history >= 1 ? o : undefined;
    });
    const result = await until('the commit result', async () => (await heard()).find((m) => m.channel === MainToDeckEdit.result && m.payload.outcome === 'written'));
    const token = String(result.payload.token);
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    // The renderer now holds the real token of the latest write: sent again with no press behind it, and with every
    // other forged message, it still changes nothing.
    await sleep(PRESS_SETTLE_MS);
    const answered = (await heard()).length;
    await forgeAll(s.deck, await pageFacts(s.deck), token);
    await sleep(1_500);
    expect(await observe(s, file)).toEqual(written);
    expect((await heard()).slice(answered), 'main answered a forged message').toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(want);

    // Positive control for undo: app undo from real keys restores the original bytes.
    await s.deck.chord('z');
    await until('the undo on disk', async () => (fs.readFileSync(file).equals(original) ? true : undefined));
  } finally {
    await s.close();
    sc.cleanup();
  }
});

test('@edit in a Protected deck, forged Edit messages write nothing even right after a real click, and Edit stays unavailable', async () => {
  const sc = new Scratch(resolveRunAs());
  const s = await openFixture({ scratch: sc, fixture: 'ipc.html', trust: 'protected' });
  try {
    const file = s.folder.file('ipc.html');
    const original = fs.readFileSync(file);
    const info = await until('the edit state', async () => (await s.app.editInfo(s.docId)) ?? undefined);
    expect(info.availability).toEqual({ available: false, reason: 'This file is in Protected view. Click Enable editing to edit it.', enable: true });
    // Cmd+3 asks for Edit and only shows the trust bar (6.3, 7.2): the mode stays Read.
    await s.deck.chord('3');
    await sleep(500);
    const page = await pageFacts(s.deck);
    const heard = await listen(s.deck);
    const before = await observe(s, file);
    expect(before).toMatchObject({ trust: 'protected', editingAllowed: false, appMode: 'read', notes: 0, undo: { undo: 0, redo: 0 }, history: 0 });

    // A real click on the heading gives main a trusted press; the forged messages follow at once, inside its window.
    await s.deck.clickText('#heading');
    await forgeAll(s.deck, page, '0123456789abcdef0123456789abcdef');
    await sleep(1_500);
    // And with no press at all.
    await sleep(PRESS_SETTLE_MS);
    await forgeAll(s.deck, page, 'fedcba9876543210fedcba9876543210');
    await sleep(1_500);

    expect(await observe(s, file)).toEqual(before);
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect(await heard(), 'main answered a forged message').toEqual([]);
    expect(editLogs(s.app).length, 'main never saw the forged messages').toBeGreaterThan(0);
    expect(await s.deck.eval<boolean>(`document.getElementById('heading').isContentEditable`)).toBe(false);
  } finally {
    await s.close();
    sc.cleanup();
  }
});

test('@edit a page script faking clicks, keys and typing in a Trusted deck in Edit opens no field and writes nothing', async () => {
  const sc = new Scratch(resolveRunAs());
  const s = await openFixture({ scratch: sc, fixture: 'ipc.html', trust: 'trusted' });
  try {
    const file = s.folder.file('ipc.html');
    const original = fs.readFileSync(file);
    await until('Edit available', async () => ((await s.app.editInfo(s.docId))?.availability.available ? true : undefined));
    await enterEdit(s);
    await pageFacts(s.deck);
    const heard = await listen(s.deck);
    await sleep(PRESS_SETTLE_MS);
    const before = await observe(s, file);

    // The page's own script (main world): it has no IPC, so it fakes the input the overlay listens for.
    const r = await s.deck.eval<string>(`(function(){
      var h = document.getElementById('heading');
      var b = h.getBoundingClientRect();
      var at = { bubbles: true, cancelable: true, composed: true, clientX: b.left + 5, clientY: b.top + b.height / 2, button: 0, buttons: 1, view: window };
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'].forEach(function (t) {
        var E = t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
        h.dispatchEvent(new E(t, at));
      });
      h.focus();
      var sel = window.getSelection(); var range = document.createRange(); range.selectNodeContents(h); range.collapse(false); sel.removeAllRanges(); sel.addRange(range);
      ['x', 'Enter'].forEach(function (k) {
        h.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        h.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));
      });
      document.execCommand('insertText', false, ' FORGED');
      h.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ' FORGED', bubbles: true, cancelable: true }));
      h.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ' FORGED', bubbles: true }));
      h.dispatchEvent(new FocusEvent('blur'));
      h.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      // And making the heading editable itself, typing into it, and leaving it.
      h.contentEditable = 'true';
      h.focus();
      document.execCommand('insertText', false, ' FORGED AGAIN');
      h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      h.blur();
      return 'done';
    })()`);
    expect(r).toBe('done');
    await sleep(2_000);

    expect(await observe(s, file)).toEqual(before);
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect((await heard()).filter((m) => m.payload.outcome === 'written' || m.payload.outcome === 'verbatim'), 'main took a commit from a page script').toEqual([]);
  } finally {
    await s.close();
    sc.cleanup();
  }
});
