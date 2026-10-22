// Forged IPC from a compromised renderer (SPEC 9.1 Preload: "Main treats every message from a deck view as
// written by the page"; section 10; work item 4). From a Protected deck, send forged payloads on every
// DeckToMain channel through __blTestIpc (the ipcRenderer the preload puts on its isolated world in test
// builds). Assert that no file is written, and no trust state, setting, app mode or other document changes,
// and that main survives floods and prototype-pollution attempts. A renderer exploit has the same
// ipcRenderer as the shell's preload, so the deck also invokes every ShellToMain channel (9.1 Shell view:
// "Main accepts trust changes only from the shell's trust-bar buttons and Settings"), and a second document
// is open while the deck sends note operations naming its notes.
//
// Positive controls (9.9): the guard logs each dropped message; the same shell calls from the shell succeed
// and visibly change the state these tests read; a valid note operation from a deck changes its own
// document's notes and session.json.

import { expect, test } from '@playwright/test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DeckToMain, ShellToMain } from '../../packages/core/src/ipc';
import { EditDeckToMain } from '../../packages/core/src/ipc-edit';
import { DECK_CHANNEL_RATES, DECK_SENDER_RATE } from '../../packages/app/src/main/ipc-guard';
import { Scratch, launchApp, resolveRunAs, sleep, type BlApp, type DeckView, type WinInfo } from '../helpers/app';
import { openFixture, prepareFixtureFolder, uniqLabel, type NetConfig } from '../helpers/security';
import { sharedDnsServer } from '../helpers/servers';

test.describe.configure({ mode: 'serial' });

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
}

// A content snapshot of a directory tree: path -> sha256+size. mtimes are ignored (a touch is not a write of
// bytes); creation and deletion show up as added/removed keys.
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        try {
          const b = fs.readFileSync(abs);
          out[r] = `${b.length}:${crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)}`;
        } catch {
          out[r] = 'unreadable';
        }
      }
    }
  };
  walk(dir, '');
  return out;
}

function diff(before: Record<string, string>, after: Record<string, string>): string[] {
  const changes: string[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] !== after[k]) changes.push(`${k}: ${before[k] ?? '(absent)'} -> ${after[k] ?? '(absent)'}`);
  }
  return changes;
}

/** Waits for the slide index, then for userData to stay the same for 1.5 s (the thumbnails follow the index). */
async function waitProductsWritten(app: BlApp, docId: string): Promise<void> {
  await expect
    .poll(async () => ((await app.win(docId)) as unknown as { state: { index: { ready: boolean } | null } }).state.index?.ready ?? false, {
      timeout: 90_000,
    })
    .toBe(true);
  let prev = JSON.stringify(snapshot(app.userData));
  const until = Date.now() + 60_000;
  for (;;) {
    await sleep(1500);
    const now = JSON.stringify(snapshot(app.userData));
    if (now === prev) return;
    if (Date.now() > until) throw new Error('userData kept changing for 60 s after the slide index was ready');
    prev = now;
  }
}

const DECK_CHANNELS = {
  ready: 'bl:deck:ready',
  focus: 'bl:deck:focus',
  link: 'bl:deck:link',
  slides: 'bl:deck:slides',
  mode: 'bl:deck:mode',
  note: 'bl:deck:note',
  diag: 'bl:deck:diag',
  renderReply: 'bl:render:reply',
  // Phase 2 (Edit; core/ipc-edit.ts).
  editBegin: 'bl:edit:begin',
  editCommit: 'bl:edit:commit',
  editCandidates: 'bl:edit:candidates',
  editUndo: 'bl:edit:undo',
  editBusy: 'bl:edit:busy',
} as const;

/** The page's version and a run of it, as the overlay holds them (so a forged commit names real ones). */
interface PageFacts {
  version: string;
  runId: string;
  text: string;
  stamp: string;
}

/** The forged payloads for one channel: wrong types, oversized, poisoned keys, and other-document claims. */
function forgedPayloads(page: PageFacts): { channel: string; payloads: unknown[] }[] {
  const big = 'x'.repeat(2_000_000);
  const bigArray = (n: number) => Array.from({ length: n }, (_, i) => i);
  const target = { css: 'h1', text: page.text, role: 'heading', stamp: page.stamp };
  const commit = (fieldId: number, result: unknown, extra: Record<string, unknown> = {}) => ({ fieldId, version: page.version, result, target, slide: null, alsoPlaces: 0, ...extra });
  const edit = { kind: 'edit', runId: page.runId, beforeText: page.text, afterText: `${page.text} FORGED` };
  const record = { versionBefore: page.version, versionAfter: page.version, start: 0, rawBefore: '<!DOCTYPE', rawAfter: 'FORGED', prefix: '', suffix: '' };
  return [
    { channel: DECK_CHANNELS.ready, payloads: [{ steal: true }, 123, 'go'] },
    { channel: DECK_CHANNELS.focus, payloads: [{ textField: 'yes' }, { textField: 1 }, {}, { textField: true, extra: big }] },
    {
      channel: DECK_CHANNELS.link,
      payloads: [
        { href: 'javascript:fetch("http://evil.example/")' },
        { href: 'file:///etc/passwd' },
        { href: big },
        { href: 42 },
        {},
      ],
    },
    {
      channel: DECK_CHANNELS.slides,
      payloads: [
        { kind: 'evil', count: 1, current: 0, titles: [], navKind: 'index' },
        { kind: 'generic', count: -1, current: 0, titles: [], navKind: 'index' },
        { kind: 'generic', count: 1, current: 0, titles: bigArray(50_000), navKind: 'index' },
        { kind: 'generic', count: 1, current: 0, titles: [big], navKind: 'index' },
        { kind: 'generic', count: 1, current: 0, titles: [], navKind: 'index', deckNav: { forward: big, back: big } },
        'not-an-object',
      ],
    },
    {
      channel: DECK_CHANNELS.mode,
      // A deck may only ask for Read; anything else (edit/review) must be dropped, so it cannot enable Edit.
      payloads: [{ mode: 'edit' }, { mode: 'review' }, { mode: 'read', extra: 1 }, { mode: 2 }, 'edit'],
    },
    {
      channel: DECK_CHANNELS.note,
      payloads: [
        { op: 'evil' },
        { op: 'delete', id: 'anna-x7k2:n-0003' }, // claims another author's note on another document
        { op: 'update', id: 'n-0001', text: big },
        { op: 'create', clientId: 'c1', text: 'x', marks: bigArray(100_000), slide: 0 },
        { op: 'create', clientId: 'c2', text: big, marks: [], slide: 0 },
        { op: 'create', clientId: '../../etc', text: 'x', marks: [], slide: 0 },
        { op: 'close', id: 'n-9999' },
      ],
    },
    { channel: DECK_CHANNELS.diag, payloads: [{ event: 'evil', data: {} }, { event: 'paste', data: { length: big } }, {}] },
    { channel: DECK_CHANNELS.renderReply, payloads: [{ reqId: 1, ok: true, result: { deep: { a: 1 } } }, { reqId: -1, ok: 'yes' }] },
    // Phase 2 (P2-7): well-formed edits of the page's real version and run, with no trusted press, outside Edit, in
    // Protected view; and the malformed and dangerous ones (a write record, a path, oversized text).
    { channel: DECK_CHANNELS.editBegin, payloads: [{ fieldId: 1, version: page.version, runIds: [page.runId] }, { fieldId: -1, version: 'x', runIds: [] }, { fieldId: 1, version: page.version, runIds: ['../../etc/passwd'] }] },
    {
      channel: DECK_CHANNELS.editCommit,
      payloads: [
        commit(1, edit),
        commit(1, edit, { pick: { kind: 'equal', nodeBefore: page.text, nodeAfter: 'FORGED' } }),
        commit(2, { kind: 'verbatim', before: page.text, after: 'FORGED NOTE', why: 'across-runs' }),
        commit(3, { kind: 'noop' }),
        commit(1, { ...edit, afterText: big }),
        commit(1, edit, { record, path: '/etc/passwd', docId: 'fedcba9876543210' }),
        commit(1, { kind: 'restore', bytes: 'FORGED' }),
      ],
    },
    { channel: DECK_CHANNELS.editCandidates, payloads: [{ fieldId: 1, version: page.version, runIds: [page.runId] }, { fieldId: 1, version: page.version, runIds: bigArray(60).map((i) => `h:bl-${i}:0`) }] },
    { channel: DECK_CHANNELS.editUndo, payloads: [{ token: '0123456789abcdef0123456789abcdef' }, { token: 'x' }, { record }, { token: '0123456789abcdef0123456789abcdef', record }] },
    { channel: DECK_CHANNELS.editBusy, payloads: [{ edit: true, committing: true }, { edit: 'yes' }, { edit: false, committing: false }] },
  ];
}

/** The overlay's page version and its first run (test builds' __blTestEdit, in the preload's isolated world). */
async function pageFacts(deck: DeckView): Promise<PageFacts> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const raw = await deck.isolated<string>('JSON.stringify(globalThis.__blTestEdit ? globalThis.__blTestEdit.state(true) : null)', 999);
    const st = JSON.parse(raw) as { pageVersion: string | null; map?: { runs: { id: string; stamp: string; value: string }[] } | null } | null;
    const run = st?.map?.runs.find((r) => r.value.trim().length > 0);
    if (st?.pageVersion && run) return { version: st.pageVersion, runId: run.id, text: run.value, stamp: run.stamp };
    await sleep(200);
  }
  throw new Error('the overlay never had its map');
}

/** Sends `payload` on `channel` from the preload's isolated world (world 999), as a compromised page would. */
async function forge(deck: DeckView, channel: string, payload: unknown): Promise<string> {
  return await deck.isolated<string>(
    `(function(){
      try {
        var ipc = globalThis.__blTestIpc;
        if (!ipc || typeof ipc.send !== 'function') return 'no-ipc';
        ipc.send(${JSON.stringify(channel)}, ${JSON.stringify(payload)});
        return 'sent';
      } catch (e) { return 'threw:' + (e && e.name); }
    })()`,
    999,
  );
}

/** Polls a window until its notes satisfy `ok`, and returns it. */
async function waitNotes(app: BlApp, docId: string, ok: (notes: WinInfo['state']['notes']) => boolean, timeout = 10_000): Promise<WinInfo> {
  const end = Date.now() + timeout;
  let w = await app.win(docId);
  while (!ok(w.state.notes) && Date.now() < end) {
    await sleep(100);
    w = await app.win(docId);
  }
  expect(ok(w.state.notes), `notes of ${docId}: ${JSON.stringify(w.state.notes)}`).toBe(true);
  return w;
}

/** Waits until `file` exists and contains `text` (session.json is written asynchronously). */
async function waitFileContains(file: string, text: string, timeout = 10_000): Promise<string> {
  const end = Date.now() + timeout;
  let body = '';
  while (Date.now() < end) {
    try {
      body = fs.readFileSync(file, 'utf8');
      if (body.includes(text)) return body;
    } catch {
      // not written yet
    }
    await sleep(100);
  }
  throw new Error(`${file} never contained ${JSON.stringify(text)}; last: ${body.slice(0, 500)}`);
}

/**
 * Valid arguments for every ShellToMain channel (what the shell's contextBridge API sends). A channel added
 * to ShellToMain without an entry here fails the test, so the deck is always tried on every shell channel.
 */
const SHELL_ARGS: Record<string, unknown[]> = {
  [ShellToMain.getState]: [],
  [ShellToMain.setMode]: ['edit'],
  [ShellToMain.allowNetwork]: [],
  [ShellToMain.enableEditing]: [],
  [ShellToMain.dismissTrustBar]: [],
  [ShellToMain.openInBrowser]: [],
  [ShellToMain.revealFile]: [],
  [ShellToMain.diagState]: [],
  [ShellToMain.diagRecord]: ['bl-forged-step', 'pass', 'forged from a deck'],
  [ShellToMain.diagRunAuto]: [],
  [ShellToMain.diagSave]: [],
  [ShellToMain.dismissBanner]: [],
  [ShellToMain.popupMenu]: ['trust-overflow', 10, 10],
  // Phase 2 (main-wiring): toast buttons, Copy, the name chip, the history list.
  [ShellToMain.toastAction]: ['0123456789abcdef0123456789abcdef', 'make-note'],
  [ShellToMain.copyNote]: ['n-0001'],
  [ShellToMain.setName]: ['Forged Name'],
  [ShellToMain.historyClose]: [],
  [ShellToMain.historyRestore]: ['h-1'],
};

/**
 * Invokes `channel` from the deck's isolated world (world 999) as a compromised renderer would, and returns
 * 'ok' or 'refused: <message>'. Bounded in time: an accepted call can reload the deck under the script (then
 * the answer is 'no answer'), and nothing may hang the test.
 */
async function invokeFromDeck(deck: DeckView, channel: string, args: unknown[], timeoutMs = 5_000): Promise<string> {
  const code = `(async function(){
    var ipc = globalThis.__blTestIpc;
    if (!ipc || typeof ipc.invoke !== 'function') return 'no-ipc';
    try { await ipc.invoke.apply(ipc, ${JSON.stringify([channel, ...args])}); return 'ok'; }
    catch (e) { return 'refused: ' + (e && e.message ? e.message : String(e)); }
  })()`;
  return await deck.app.electronApp.evaluate(
    async ({ webContents }, a) => {
      const wc = webContents.fromId(a.id);
      if (!wc || wc.isDestroyed()) return 'no deck';
      const run = wc.executeJavaScriptInIsolatedWorld(999, [{ code: a.code }]).then(
        (v) => String(v),
        (e) => `script error: ${String(e)}`,
      );
      return await Promise.race([run, new Promise<string>((r) => setTimeout(() => r('no answer'), a.timeoutMs))]);
    },
    { id: deck.wcId, code, timeoutMs },
  );
}

/** The trust state, settings and mode a forged call could change. */
function trustView(w: WinInfo) {
  return {
    trust: w.trust,
    networkAllowed: w.networkAllowed,
    editingAllowed: w.editingAllowed,
    appMode: w.appMode,
    trustBarVisible: w.state.trustBarVisible,
    stateTrust: w.state.trust,
    stateNetwork: w.state.networkAllowed,
    stateEditing: w.state.editingAllowed,
  };
}

test('the preload exposes __blTestIpc only in its isolated world (test build)', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'ipc.html', trust: 'protected' });
  try {
    expect(await session.deck.isolated('typeof globalThis.__blTestIpc', 999)).toBe('object');
    // The page's main world must not see it (no contextBridge, no main-world global).
    expect(await session.deck.eval('typeof window.__blTestIpc')).toBe('undefined');
    expect(await session.deck.eval('typeof window.require')).toBe('undefined');
  } finally {
    await session.close();
    s.cleanup();
  }
});

test('forged payloads on every deck channel write no file and change no state', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'ipc.html', trust: 'protected' });
  try {
    await sleep(600); // let the open settle (session.json created by SessionStore.open)
    const before = await session.app.win(session.docId);
    expect(before.trust).toBe('protected');
    expect(before.editingAllowed).toBe(false);
    // The render products (the slide index and the rail's thumbnails, written under files/<key>/thumbs) are
    // made in the background after the open; the index waits for script-timed content (D-5), so they can land
    // well after the open. Take the userData snapshot only once they are written, so any later change is the
    // forged IPC's.
    await waitProductsWritten(session.app, session.docId);

    const folderSnap = snapshot(session.folder.dir);
    const userDataSnap = snapshot(session.app.userData);

    // Every deck channel main declares has forged payloads here (a new channel without them fails the test).
    const page = await pageFacts(session.deck);
    const payloadSets = forgedPayloads(page);
    const covered = new Set(payloadSets.map((p) => p.channel));
    expect([...Object.values(DeckToMain), ...Object.values(EditDeckToMain)].filter((c) => !covered.has(c)), 'a deck channel has no forged payloads').toEqual([]);

    // Send every forged payload on every channel.
    let sent = 0;
    for (const set of payloadSets) {
      for (const p of set.payloads) {
        const r = await forge(session.deck, set.channel, p);
        expect(r, `forge ${set.channel}: ${r}`).not.toBe('no-ipc');
        sent++;
      }
    }
    expect(sent).toBeGreaterThan(20);

    // A prototype-pollution attempt: build payloads with a genuine own `__proto__` / `constructor` key
    // (defineProperty, so structured clone carries the key) and send them on channels that parse objects.
    // The guard's record() must refuse any poisoned key, so Object.prototype stays clean.
    await session.deck.isolated(
      `(function(){
        var ipc = globalThis.__blTestIpc;
        function poisoned(extra) {
          var o = {};
          Object.defineProperty(o, '__proto__', { value: { blPolluted: true }, enumerable: true, configurable: true, writable: true });
          Object.defineProperty(o, 'constructor', { value: { prototype: { blPolluted2: true } }, enumerable: true, configurable: true, writable: true });
          for (var k in extra) o[k] = extra[k];
          return o;
        }
        ipc.send('bl:deck:focus', poisoned({ textField: true }));
        ipc.send('bl:deck:note', poisoned({ op: 'create', clientId: 'pp', text: 'x', marks: [], slide: 0 }));
        ipc.send('bl:deck:slides', poisoned({ kind: 'generic', count: 1, current: 0, titles: [], navKind: 'index' }));
        return 'poisoned';
      })()`,
      999,
    );
    await sleep(800);

    // No prototype pollution reached main (the validators refuse __proto__/constructor/prototype keys).
    const polluted = await session.app.electronApp.evaluate(() => {
      const o = {} as Record<string, unknown>;
      return { a: (o as { blPolluted?: unknown }).blPolluted, b: (o as { blPolluted2?: unknown }).blPolluted2 };
    });
    expect(polluted.a, 'Object.prototype was polluted via a forged IPC payload').toBeUndefined();
    expect(polluted.b).toBeUndefined();

    // No file in the fixture folder changed, and no document file was written.
    expect(diff(folderSnap, snapshot(session.folder.dir)), 'the fixture folder changed after forged IPC').toHaveLength(0);
    // userData: no note was added to session.json, no config/trust file written or changed.
    expect(diff(userDataSnap, snapshot(session.app.userData)), 'userData changed after forged IPC').toHaveLength(0);

    // Trust, network, editing and app mode are unchanged (a deck cannot flip any of them).
    const after = await session.app.win(session.docId);
    expect(after.trust).toBe('protected');
    expect(after.networkAllowed).toBe(false);
    expect(after.editingAllowed).toBe(false);
    expect(after.appMode).toBe('read');
    expect(after.state.notes, 'a forged note op created a note').toHaveLength(0);

    // The forged note floods and oversized payloads were dropped silently (the test build logs drops).
    const drops = session.app.logsMatching(/ipc drop/);
    expect(drops.length, 'expected the guard to drop the forged payloads').toBeGreaterThan(0);

    // Positive control: a valid note operation from the same deck is accepted, and both the state read and
    // the userData snapshot above see it (a note in session.json), so they would have seen a forged change.
    expect(await forge(session.deck, DECK_CHANNELS.note, { op: 'create', clientId: 'control', text: 'control note', marks: [], slide: 0 })).toBe('sent');
    const created = await waitNotes(session.app, session.docId, (n) => n.length === 1);
    expect(created.state.notes.map((n) => n.text)).toEqual(['control note']);
    await waitFileContains(created.sessionFile, 'control note');
    expect(diff(userDataSnap, snapshot(session.app.userData)).join('\n'), 'the snapshot must see a session.json write').toContain('session.json');
  } finally {
    await session.close();
    s.cleanup();
  }
});

test('a flood is rate-limited, main stays responsive, and the document is never written', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'ipc.html', trust: 'protected' });
  try {
    await sleep(600);
    // The DOCUMENT (and its folder) must never change, whatever the deck sends: notes are app data. A
    // Protected deck may legitimately create notes (Review works in Protected), so session.json may grow —
    // that is not a document write and not a security violation.
    const folderSnap = snapshot(session.folder.dir);
    // 15,000 messages on four channels as fast as the renderer can send them: the rate limiter must drop the great
    // majority, and main must stay alive. Every message counts first against the sender's budget, all its deck
    // channels together (ipc-guard DECK_SENDER_RATE: 9.1's 1,000 a second, a burst of 1,000), then against its
    // channel's bucket (DECK_CHANNEL_RATES: note operations 50 a second with a burst of 100, the others 1,000), each
    // refilled by the clock. The link and mode messages are malformed: they count, and are dropped as invalid.
    const noteRate = DECK_CHANNEL_RATES[DeckToMain.note];
    const admitted = async (): Promise<number> =>
      await session.app.electronApp.evaluate((_e, id) => (globalThis as unknown as { __blTest: { ipcAdmitted(d: string): number } }).__blTest.ipcAdmitted(id), session.docId);
    const admittedBefore = await admitted();
    const t0 = Date.now();
    const result = await session.deck.isolated<string>(
      `(function(){
        var ipc = globalThis.__blTestIpc;
        if (!ipc) return 'no-ipc';
        for (var j = 0; j < 5000; j++) ipc.send('bl:deck:note', { op: 'create', clientId: 'f' + j, text: 'x', marks: [], slide: 0 });
        for (var i = 0; i < 5000; i++) ipc.send('bl:deck:focus', { textField: (i % 2) === 0 });
        for (var k = 0; k < 2500; k++) ipc.send('bl:deck:link', { href: 'not a link ' + k });
        for (var m = 0; m < 2500; m++) ipc.send('bl:deck:mode', { mode: 'nonsense' });
        return 'flooded';
      })()`,
      999,
    );
    expect(result).toBe('flooded');
    // Main got to the whole flood once what it admitted stops growing (a loaded machine may still be on the backlog);
    // `busy` is from the flood's start to the last poll that saw the count grow.
    let count = await admitted();
    let lastGrowth = Date.now();
    for (const end = Date.now() + 20_000; Date.now() < end && Date.now() - lastGrowth < 1500; ) {
      await sleep(100);
      const c = await admitted();
      if (c !== count) {
        count = c;
        lastGrowth = Date.now();
      }
    }
    const busy = (lastGrowth - t0) / 1000;
    // Main is alive and answering.
    let w = await session.app.win(session.docId);
    for (const end = Date.now() + 15_000; w.state.notes.length < noteRate.burst && Date.now() < end; ) {
      await sleep(100);
      w = await session.app.win(session.docId);
    }
    const elapsed = (Date.now() - t0) / 1000;
    expect(w.trust).toBe('protected');
    const total = count - admittedBefore;
    const notes = w.state.notes.length;
    test.info().annotations.push({
      type: 'flood',
      description: `${total} of 15,000 messages within the limits by ${busy.toFixed(2)} s (sender limit ${DECK_SENDER_RATE.burst} + ${DECK_SENDER_RATE.perSecond}/s); ${notes} of 5,000 note creates in ${elapsed.toFixed(2)} s (limit ${noteRate.burst} + ${noteRate.perSecond}/s)`,
    });
    // The sender's whole flood, every channel together, was held to 9.1's figure by the clock, however fast or
    // slowly main got to the messages: at most the burst plus the rate times the time main took (the hardening
    // round's per channel buckets alone let each of the four channels through up to its own limit).
    expect(total, `flood not throttled across channels: ${total} messages by ${busy.toFixed(2)} s`).toBeLessThanOrEqual(Math.floor(DECK_SENDER_RATE.burst + DECK_SENDER_RATE.perSecond * busy));
    expect(total, `flood not throttled: ${total} messages`).toBeLessThan(15_000);
    // Note creates are held to their own channel's limit as well: at most its burst plus its rate times the time since
    // the flood began (main took every create it counted within that time), far fewer than the 5,000 creates and
    // never up to the 2,000-note cap (the limiter before the hardening round, refilled while main fell behind on a
    // push of every note per create, let them through up to the cap in many runs).
    expect(notes, `flood not throttled: ${notes} notes in ${elapsed.toFixed(1)} s`).toBeLessThanOrEqual(Math.floor(noteRate.burst + noteRate.perSecond * elapsed));
    expect(notes, `flood not throttled: ${notes} notes`).toBeLessThan(2000);
    // Positive control: the flood did reach main, and the creates, sent first, found the sender's budget full: the
    // whole burst of creates got through.
    expect(notes, 'the burst of note creates did not reach main').toBeGreaterThanOrEqual(noteRate.burst);
    // The other channels got through too, on what the clock refilled: the creates had spent the sender's burst (a
    // create the note bucket drops still takes the sender's token).
    expect(total, 'only note creates got through').toBeGreaterThan(notes);
    // The document file and its siblings were never written.
    expect(diff(folderSnap, snapshot(session.folder.dir)), 'the document folder changed under a flood').toHaveLength(0);
    expect(session.app.logsMatching(/ipc drop .*rate/).length, 'expected rate-limit drops').toBeGreaterThan(0);
  } finally {
    await session.close();
    s.cleanup();
  }
});

test('every shell channel invoked from a deck is refused and changes nothing (the shell itself is the positive control)', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'ipc.html', trust: 'protected' });
  try {
    await sleep(600);
    const channels = Object.values(ShellToMain) as string[];
    const missing = channels.filter((c) => !(c in SHELL_ARGS));
    expect(missing, 'a ShellToMain channel has no forged call in this test').toHaveLength(0);
    const before = await session.app.win(session.docId);
    expect(before.trust).toBe('protected');
    expect(before.state.trustBarVisible).toBe(true);
    const folderSnap = snapshot(session.folder.dir);

    // From the deck's isolated world, with the arguments the shell would send. allow-network goes last: if it
    // were accepted, the deck would reload under the call.
    const order = [...channels.filter((c) => c !== ShellToMain.allowNetwork), ShellToMain.allowNetwork];
    const outcome: Record<string, string> = {};
    for (const c of order) outcome[c] = await invokeFromDeck(session.deck, c, SHELL_ARGS[c]);
    // Channels declared at startup reject with the router's bare "Refused"; the Diagnostics window's channels
    // exist only while it is open, and otherwise have no handler at all.
    const accepted = channels.filter((c) => !(c.includes(':diag-') ? /Refused|No handler registered/ : /Error: Refused$/).test(outcome[c]));
    expect(
      accepted.map((c) => `${c}: ${outcome[c]}`),
      `shell channels a deck could call: ${JSON.stringify(outcome)}`,
    ).toHaveLength(0);
    await sleep(500);
    // The router saw the calls (test builds log each drop) ...
    for (const c of [ShellToMain.allowNetwork, ShellToMain.enableEditing, ShellToMain.setMode, ShellToMain.revealFile]) {
      expect(session.app.logsMatching(new RegExp(`ipc drop ${c} `)).length, `no drop logged for ${c}`).toBeGreaterThan(0);
    }
    // ... and nothing changed: trust, network, editing, mode, trust bar; nothing opened or revealed; no file.
    const after = await session.app.win(session.docId);
    expect(trustView(after)).toEqual(trustView(before));
    const h = await session.app.harness();
    expect(h.external, `a forged shell call opened something: ${JSON.stringify(h.external)}`).toHaveLength(0);
    expect(diff(folderSnap, snapshot(session.folder.dir)), 'the document folder changed').toHaveLength(0);

    // Positive control: the same calls from the shell (its contextBridge API) are accepted and change exactly
    // what the checks above read, so a deck call that got through would have been seen.
    const shell = await session.app.electronApp.evaluate(async ({ webContents }, id) => {
      const wc = webContents.fromId(id);
      if (!wc) throw new Error('no shell');
      return (await wc.executeJavaScript(`(async function(){
        var b = window.blueline;
        var st = await b.getState();
        await b.setMode('review');
        await b.dismissTrustBar();
        await b.enableEditing();
        await b.allowNetwork();
        return { docName: st.docName };
      })()`)) as { docName: string };
    }, before.shellWebContentsId);
    expect(shell.docName).toBe('ipc.html');
    await sleep(500);
    const changed = await session.app.win(session.docId);
    expect(changed.appMode).toBe('review');
    expect(changed.state.trustBarVisible).toBe(false);
    expect(changed.editingAllowed).toBe(true);
    expect(changed.networkAllowed).toBe(true);
  } finally {
    await session.close();
    s.cleanup();
  }
});

test("note operations naming another open document's notes change nothing there", async () => {
  const s = scratch();
  const dns = await sharedDnsServer();
  const cfg: NetConfig = { uniq: uniqLabel('protected'), zone: dns.zone, port: 0, udp: 0, tcp: 0, sink: dns.sinkIp };
  const folder = prepareFixtureFolder(s, cfg);
  // Two documents in one app (9.1: main "never ... reads another document's data").
  const app = await launchApp({ files: [folder.file('ipc.html'), folder.file('ipc-second.html')], protected: true, scratch: s });
  try {
    const deck = await app.waitForDeck('ipc.html');
    const other = await app.waitForDeck('ipc-second.html');
    expect(other.docId).not.toBe(deck.docId);

    // A real note in the second document, created the way its own card does (its deck's note channel).
    expect(await forge(other, DECK_CHANNELS.note, { op: 'create', clientId: 'second-real', text: 'the second document note', marks: [], slide: 0 })).toBe('sent');
    const w2 = await waitNotes(app, other.docId, (n) => n.length === 1);
    const note = w2.state.notes[0];
    const sessionBefore = await waitFileContains(w2.sessionFile, 'the second document note');
    const notesBefore = JSON.stringify(w2.state.notes);

    // From the FIRST deck: every author transition on that note id, plain and with fields naming the other
    // document (main takes the document from the sender, never from a field).
    const ops: Record<string, unknown>[] = [];
    for (const extra of [{}, { docId: other.docId }, { doc: other.docId, documentId: other.docId, path: w2.realpath }]) {
      ops.push({ op: 'update', id: note.id, text: 'forged from the first document', ...extra });
      ops.push({ op: 'update', id: note.id, marks: [], ...extra });
      ops.push({ op: 'close', id: note.id, ...extra });
      ops.push({ op: 'delete', id: note.id, ...extra });
    }
    for (const op of ops) expect(await forge(deck, DECK_CHANNELS.note, op)).toBe('sent');
    await sleep(1000);

    // The other document's notes and session.json are unchanged; the first document gained nothing either.
    const w2After = await app.win(other.docId);
    expect(JSON.stringify(w2After.state.notes), "a forged op changed the other document's notes").toBe(notesBefore);
    expect(fs.readFileSync(w2.sessionFile, 'utf8'), "the other document's session.json changed").toBe(sessionBefore);
    expect((await app.win(deck.docId)).state.notes, 'the first document gained a note').toHaveLength(0);
    // The ops did reach main, which refused them for the sender's own document (test builds log the refusal).
    expect(app.logsMatching(/note op refused: (update|close|delete) \(no such note\)/).length, 'main never saw the forged note ops').toBeGreaterThan(0);

    // Positive control: the same update from the note's own deck changes the note and its session.json.
    expect(await forge(other, DECK_CHANNELS.note, { op: 'update', id: note.id, text: 'changed by its own deck' })).toBe('sent');
    const changed = await waitNotes(app, other.docId, (n) => n.length === 1 && n[0].text === 'changed by its own deck');
    expect(changed.state.notes[0].id).toBe(note.id);
    await waitFileContains(w2.sessionFile, 'changed by its own deck');
  } finally {
    await app.close();
    s.cleanup();
  }
});
