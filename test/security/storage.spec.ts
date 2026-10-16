// Storage persistence across reopen (SPEC 6.10 Storage; section 10 "document.cookie … persistence across
// reopen"). Protected clears storage when the window closes; Trusted keeps it per file. The fixture writes a
// value on first open; the suite reopens the SAME file (same userData) and reads what the second open found.
//
// A Protected reopen always gets a fresh docId, so a fresh origin: "the second open found nothing" alone
// cannot fail (finding 39). So the Protected test also checks what the clearing rests on: the partition is
// the non-persistent deck-<docId> (9.1), nothing of it is on disk, and the partition itself holds nothing
// once the window has closed. Positive controls: a reload in the same window reads the values back (the
// fixture's read-back works), the same probe reads the value while the document is open, and a Trusted
// file's persistent partition does appear on disk.
//
// document.cookie and Cache Storage do not work on blueline:// at all (the cookie reads back '' and Cache
// Storage rejects the scheme); the fixture records them as blocked with the reason, and the suite checks
// them like the other channels only if that ever changes.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scratch, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';
import { openFixture, prepareFixtureFolder, uniqLabel, type NetConfig, type ProbeResult, type SecuritySession } from '../helpers/security';
import { sharedDnsServer } from '../helpers/servers';

test.describe.configure({ mode: 'serial' });

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
}

interface Found {
  cookie: string;
  local: string | null;
  session: string | null;
  idb: string | null;
  cache: string | null;
}

const WRITES = ['cookie', 'localStorage', 'sessionStorage', 'indexeddb', 'cache'];

/** Waits for the fixture's load phase and every write result (IndexedDB and Cache Storage are async). */
async function settled(session: SecuritySession): Promise<{ found: Found; results: Record<string, ProbeResult> }> {
  await session.waitPhase('load');
  const cond = WRITES.map((n) => `window.__bl.results[${JSON.stringify(n)}]`).join(' && ');
  await session.deck.waitFor(cond, 10_000);
  return {
    found: (await session.deck.eval('window.__bl.found')) as Found,
    results: (await session.results()) as Record<string, ProbeResult>,
  };
}

/**
 * The cookie and Cache Storage channels: either they work (then the caller checks them like the others), or
 * the fixture recorded why not. Returns whether each works.
 */
function channelState(results: Record<string, ProbeResult>): { cookie: boolean; cache: boolean } {
  const cookie = results.cookie;
  const cache = results.cache;
  if (cookie?.status !== 'ok') expect(cookie?.detail, `cookie: ${JSON.stringify(cookie)}`).toBe('document.cookie does not stick on blueline://');
  if (cache?.status !== 'ok') expect(cache?.detail, `cache: ${JSON.stringify(cache)}`).toMatch(/scheme 'blueline' is unsupported|caches unavailable/);
  return { cookie: cookie?.status === 'ok', cache: cache?.status === 'ok' };
}

/** Reloads the deck in its window (webContents.reload from main) and waits for the fixture to run again. */
async function reloadDeck(app: BlApp, deck: DeckView): Promise<void> {
  const before = (await app.win(deck.docId)).handshakes;
  await app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)?.reload(), deck.wcId);
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const w = await app.win(deck.docId).catch(() => null);
    if (w && w.handshakes > before && (await deck.loaded())) break;
    await sleep(100);
  }
}

/** userData/Partitions entries of deck partitions (a persistent partition `persist:deck-…` is stored as `deck-…`). */
function deckPartitionDirs(userData: string): string[] {
  try {
    return fs.readdirSync(path.join(userData, 'Partitions')).filter((n) => n.startsWith('deck-'));
  } catch {
    return [];
  }
}

/** Every file under `dir`, relative. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

/** What probePartition read: localStorage['bl-store'], ['bl-probe'], and IndexedDB bl-db/kv 'bl' and 'probe'. */
interface Probed {
  local: string | null;
  localProbe: string | null;
  idb: string | null;
  idbProbe: string | null;
  error?: string;
}

/**
 * Reads the storage of origin blueline://<docId> in `partition` from a hidden probe window in the same
 * process. While the document is open, the probe loads the document itself (the app's handler serves it; its
 * script touches only 'bl-store' and 'bl', so the 'bl-probe'/'probe' values the test wrote through the deck
 * show that the probe sees the deck's own storage). Once the window closed, the app has unhandled the scheme
 * in that partition, so the probe serves itself a blank page at the same URL.
 */
async function probePartition(app: BlApp, partition: string, url: string): Promise<Probed> {
  return await app.electronApp.evaluate(
    async ({ BrowserWindow, session }, a) => {
      const ses = session.fromPartition(a.partition);
      let own = false;
      if (!ses.protocol.isProtocolHandled('blueline')) {
        ses.protocol.handle('blueline', () => new Response('<!doctype html><title>probe</title>', { headers: { 'content-type': 'text/html' } }));
        own = true;
      }
      const w = new BrowserWindow({ show: false, webPreferences: { partition: a.partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await w.loadURL(a.url);
        return (await w.webContents.executeJavaScript(`new Promise(function (done) {
          var out = { local: null, localProbe: null, idb: null, idbProbe: null };
          try { out.local = localStorage.getItem('bl-store'); out.localProbe = localStorage.getItem('bl-probe'); } catch (e) { out.error = 'local ' + e; }
          try {
            var created = false;
            var req = indexedDB.open('bl-db');
            req.onupgradeneeded = function () { created = true; };
            req.onsuccess = function () {
              var db = req.result;
              if (created || !db.objectStoreNames.contains('kv')) { db.close(); done(out); return; }
              var st = db.transaction('kv', 'readonly').objectStore('kv');
              var g1 = st.get('bl');
              var g2 = st.get('probe');
              g2.onsuccess = function () {
                out.idb = g1.result == null ? null : String(g1.result);
                out.idbProbe = g2.result == null ? null : String(g2.result);
                db.close();
                done(out);
              };
              g2.onerror = function () { out.error = 'idb get'; db.close(); done(out); };
            };
            req.onerror = function () { out.error = 'idb open'; done(out); };
          } catch (e) { out.error = 'idb ' + e; done(out); }
        })`)) as Probed;
      } catch (e) {
        return { local: null, localProbe: null, idb: null, idbProbe: null, error: String(e) };
      } finally {
        if (!w.isDestroyed()) w.destroy();
        if (own) {
          try {
            ses.protocol.unhandle('blueline');
          } catch {
            // gone
          }
        }
      }
    },
    { partition, url },
  );
}

/** Writes a value the fixture never writes, through the deck itself (localStorage 'bl-probe', IndexedDB 'probe'). */
async function writeProbeValue(deck: DeckView, value: string): Promise<void> {
  const ok = await deck.eval<string>(`new Promise(function (done) {
    try { localStorage.setItem('bl-probe', ${JSON.stringify(value)}); } catch (e) { done('local ' + e); return; }
    var req = indexedDB.open('bl-db');
    req.onsuccess = function () {
      var db = req.result;
      var t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(${JSON.stringify(value)}, 'probe');
      t.oncomplete = function () { db.close(); done('ok'); };
      t.onerror = function () { db.close(); done('idb put'); };
    };
    req.onerror = function () { done('idb open'); };
  })`);
  expect(ok, 'writing the probe value through the deck').toBe('ok');
}

test('protected: storage is cleared when the window closes', async () => {
  const s = scratch();
  const dns = await sharedDnsServer();
  // One prepared folder and userData, reused across the close/reopen so the file key matches.
  const cfg: NetConfig = { uniq: uniqLabel('protected'), zone: dns.zone, port: 0, udp: 0, tcp: 0, sink: dns.sinkIp };
  const folder = prepareFixtureFolder(s, cfg);
  const userData = s.dir('ud');
  const token = cfg.uniq;

  const first = await openFixture({ scratch: s, fixture: 'storage.html', trust: 'protected', folder, cfg, userData });
  let channels = { cookie: false, cache: false };
  try {
    const { found: found1, results } = await settled(first);
    // First open sees nothing stored.
    expect(found1.local, JSON.stringify(found1)).toBeNull();
    expect(found1.idb, JSON.stringify(found1)).toBeNull();
    expect(found1.cookie).toBe('');
    // The writes happened.
    expect(results.localStorage?.status, JSON.stringify(results)).toBe('ok');
    expect(results.indexeddb?.status, JSON.stringify(results)).toBe('ok');
    expect(await first.deck.eval('window.localStorage.getItem("bl-store")')).toBe(token);
    channels = channelState(results);

    // 9.1: a Protected deck runs in the non-persistent partition deck-<docId>, never a persist: one.
    const w = await first.app.win(first.docId);
    expect(w.partition, 'a Protected deck must not use a persistent partition').not.toMatch(/^persist:/);
    expect(w.partition).toBe(`deck-${first.docId}`);

    // Positive control for the read-back: a reload in the same window (same origin, same partition) finds
    // every value the first load wrote.
    await reloadDeck(first.app, first.deck);
    const { found: again } = await settled(first);
    expect(again.local, `reload: ${JSON.stringify(again)}`).toBe(token);
    expect(again.idb, `reload: ${JSON.stringify(again)}`).toBe(token);
    expect(again.session, `reload: ${JSON.stringify(again)}`).toBe(token);
    if (channels.cookie) expect(again.cookie).toContain(`bl-store=${token}`);
    if (channels.cache) expect(again.cache).toBe(token);

    // In the same process: the partition holds the values while the document is open (positive control for
    // the probe) and nothing once its window has closed (6.10: cleared when the window closes). A second
    // document keeps the app running.
    const docUrl = w.deckUrl;
    const mark = `probe-${token}`;
    await writeProbeValue(first.deck, mark);
    const open = await probePartition(first.app, w.partition, docUrl);
    expect(open, `probe while open: ${JSON.stringify(open)}`).toEqual({ local: token, localProbe: mark, idb: token, idbProbe: mark });
    const keeper = await first.app.open(folder.file('ipc.html'), true);
    expect(keeper, 'the second document did not open').toBeTruthy();
    await first.app.waitForDeck('ipc.html');
    await first.app.closeDoc(first.docId);
    await sleep(800); // clearStorageData runs on 'closed'
    const closed = await probePartition(first.app, w.partition, docUrl);
    expect(closed, `the Protected partition kept storage after its window closed: ${JSON.stringify(closed)}`).toEqual({ local: null, localProbe: null, idb: null, idbProbe: null });
  } finally {
    await first.close();
  }
  // Nothing of a Protected deck's partition was ever on disk.
  expect(deckPartitionDirs(userData), 'a Protected deck left a partition on disk').toHaveLength(0);

  // Reopen the same file. A Protected partition is non-persistent and was cleared on close, so the second
  // open must find nothing.
  const second = await openFixture({ scratch: s, fixture: 'storage.html', trust: 'protected', folder, cfg, userData });
  try {
    const { found: found2 } = await settled(second);
    expect(found2.local, `localStorage survived a Protected reopen: ${JSON.stringify(found2)}`).toBeNull();
    expect(found2.idb, `IndexedDB survived a Protected reopen: ${JSON.stringify(found2)}`).toBeNull();
    expect(found2.session, `sessionStorage survived a Protected reopen: ${JSON.stringify(found2)}`).toBeNull();
    if (channels.cookie) expect(found2.cookie, `cookie survived a Protected reopen: ${JSON.stringify(found2)}`).toBe('');
    if (channels.cache) expect(found2.cache, `Cache Storage survived a Protected reopen: ${JSON.stringify(found2)}`).toBeNull();
  } finally {
    await second.close();
  }
  expect(deckPartitionDirs(userData), 'a Protected deck left a partition on disk').toHaveLength(0);
  s.cleanup();
});

test('trusted: a deck writes storage and runs in a persistent partition', async () => {
  const s = scratch();
  const dns = await sharedDnsServer();
  const cfg: NetConfig = { uniq: uniqLabel('trusted'), zone: dns.zone, port: 0, udp: 0, tcp: 0, sink: dns.sinkIp };
  const folder = prepareFixtureFolder(s, cfg);
  const userData = s.dir('ud');
  const token = cfg.uniq;
  const session = await openFixture({ scratch: s, fixture: 'storage.html', trust: 'trusted', folder, cfg, userData });
  try {
    const { results } = await settled(session);
    expect(results.localStorage?.status).toBe('ok');
    expect(await session.deck.eval('window.localStorage.getItem("bl-store")')).toBe(token);
    channelState(results);
    // A Trusted file runs in a persistent partition (9.1), the disk half of "kept per file".
    expect((await session.app.win(session.docId)).partition).toMatch(/^persist:deck-/);
    // Positive control for the Protected "nothing on disk" check: this partition is on disk, with its storage.
    await session.app.flushStorage(session.deck);
    await sleep(400);
    const dirs = deckPartitionDirs(userData);
    expect(dirs, 'the Trusted partition is not on disk').toHaveLength(1);
    const files = filesUnder(path.join(userData, 'Partitions', dirs[0]));
    expect(files.some((f) => f.startsWith('Local Storage/')), `no Local Storage in ${dirs[0]}: ${files.join(', ')}`).toBe(true);
    expect(files.some((f) => f.startsWith('IndexedDB/')), `no IndexedDB in ${dirs[0]}: ${files.join(', ')}`).toBe(true);
  } finally {
    await session.close();
    s.cleanup();
  }
});

// 6.10 says a Trusted file keeps storage "per file", and 9.1 gives it a persistent partition
// (persist:deck-<fileKey>). localStorage and IndexedDB are also keyed by ORIGIN (blueline://<docId>), so the
// Trusted docId is kept per file too (documents.ts trustedDocumentId: random, generated once, stored in
// <userData>/files/<fileKey>/origin). Protected opens never reuse it. sessionStorage belongs to the window,
// so a reopen starts without it; document.cookie and Cache Storage do not work on blueline:// at all.
test('trusted: storage is kept per file across reopen', async () => {
  const s = scratch();
  const dns = await sharedDnsServer();
  const cfg: NetConfig = { uniq: uniqLabel('trusted'), zone: dns.zone, port: 0, udp: 0, tcp: 0, sink: dns.sinkIp };
  const folder = prepareFixtureFolder(s, cfg);
  const userData = s.dir('ud');
  const token = cfg.uniq;

  const first = await openFixture({ scratch: s, fixture: 'storage.html', trust: 'trusted', folder, cfg, userData });
  let channels = { cookie: false, cache: false };
  try {
    const { results } = await settled(first);
    expect(results.localStorage?.status).toBe('ok');
    expect(results.indexeddb?.status).toBe('ok');
    channels = channelState(results);
    expect(await first.deck.eval('window.localStorage.getItem("bl-store")')).toBe(token);
    await first.app.flushStorage(first.deck);
    await sleep(400);
  } finally {
    await first.app.closeDoc(first.docId).catch(() => undefined);
    await first.close();
  }

  const second = await openFixture({ scratch: s, fixture: 'storage.html', trust: 'trusted', folder, cfg, userData });
  try {
    const { found: found2 } = await settled(second);
    expect(found2.local, `localStorage should survive a Trusted reopen: ${JSON.stringify(found2)}`).toBe(token);
    expect(found2.idb, `IndexedDB should survive a Trusted reopen: ${JSON.stringify(found2)}`).toBe(token);
    if (channels.cookie) expect(found2.cookie).toContain(`bl-store=${token}`);
    if (channels.cache) expect(found2.cache).toBe(token);
  } finally {
    await second.close();
    s.cleanup();
  }
});
