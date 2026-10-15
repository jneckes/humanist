// Forged IPC from a compromised renderer (SPEC 9.1 Preload: "Main treats every message from a deck view as
// written by the page"; section 10; work item 4). From a Protected deck, send forged payloads on every
// DeckToMain channel through __blTestIpc (the ipcRenderer the preload puts on its isolated world in test
// builds). Assert that no file is written, and no trust state, setting, app mode or other document changes,
// and that main survives floods and prototype-pollution attempts.

import { expect, test } from '@playwright/test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scratch, resolveRunAs, sleep, type DeckView } from '../helpers/app';
import { openFixture } from '../helpers/security';

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

const DECK_CHANNELS = {
  ready: 'bl:deck:ready',
  focus: 'bl:deck:focus',
  link: 'bl:deck:link',
  slides: 'bl:deck:slides',
  mode: 'bl:deck:mode',
  note: 'bl:deck:note',
  diag: 'bl:deck:diag',
  renderReply: 'bl:render:reply',
} as const;

/** The forged payloads for one channel: wrong types, oversized, poisoned keys, and other-document claims. */
function forgedPayloads(): { channel: string; payloads: unknown[] }[] {
  const big = 'x'.repeat(2_000_000);
  const bigArray = (n: number) => Array.from({ length: n }, (_, i) => i);
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
  ];
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

    const folderSnap = snapshot(session.folder.dir);
    const userDataSnap = snapshot(session.app.userData);

    // Send every forged payload on every channel.
    const payloadSets = forgedPayloads();
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
    // 10,000 messages as fast as the renderer can send them (the limit is 1,000/s): the rate limiter must
    // drop the great majority, and main must stay alive.
    const result = await session.deck.isolated<string>(
      `(function(){
        var ipc = globalThis.__blTestIpc;
        if (!ipc) return 'no-ipc';
        for (var i = 0; i < 5000; i++) ipc.send('bl:deck:focus', { textField: (i % 2) === 0 });
        for (var j = 0; j < 5000; j++) ipc.send('bl:deck:note', { op: 'create', clientId: 'f' + j, text: 'x', marks: [], slide: 0 });
        return 'flooded';
      })()`,
      999,
    );
    expect(result).toBe('flooded');
    await sleep(1000);
    // Main is alive and answering.
    const w = await session.app.win(session.docId);
    expect(w.trust).toBe('protected');
    // Far fewer than the 5,000 note creates got through (the token bucket is ~1,000/s, shared with the
    // focus flood): the flood was throttled, not accepted wholesale.
    expect(w.state.notes.length, `flood not throttled: ${w.state.notes.length} notes`).toBeLessThan(2000);
    // The document file and its siblings were never written.
    expect(diff(folderSnap, snapshot(session.folder.dir)), 'the document folder changed under a flood').toHaveLength(0);
    expect(session.app.logsMatching(/ipc drop .*rate/).length, 'expected rate-limit drops').toBeGreaterThan(0);
  } finally {
    await session.close();
    s.cleanup();
  }
});
