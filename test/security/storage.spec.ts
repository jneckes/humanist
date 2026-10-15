// Storage persistence across reopen (SPEC 6.10 Storage; section 10 "document.cookie … persistence across
// reopen"). Protected clears storage when the window closes; Trusted keeps it per file. The fixture writes a
// value on first open; the suite reopens the SAME file (same userData) and reads what the second open found.

import { expect, test } from '@playwright/test';
import { Scratch, resolveRunAs, sleep } from '../helpers/app';
import { openFixture, prepareFixtureFolder, uniqLabel, type NetConfig } from '../helpers/security';
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

test('protected: storage is cleared when the window closes', async () => {
  const s = scratch();
  const dns = await sharedDnsServer();
  // One prepared folder and userData, reused across the close/reopen so the file key and partition match.
  const cfg: NetConfig = { uniq: uniqLabel('protected'), zone: dns.zone, port: 0, udp: 0, tcp: 0, sink: dns.sinkIp };
  const folder = prepareFixtureFolder(s, cfg);
  const userData = s.dir('ud');
  const token = cfg.uniq;

  const first = await openFixture({ scratch: s, fixture: 'storage.html', trust: 'protected', folder, cfg, userData });
  try {
    await first.waitPhase('load');
    await sleep(600);
    const found1 = (await first.deck.eval('window.__bl.found')) as Found;
    // First open sees nothing stored.
    expect(found1.local, JSON.stringify(found1)).toBeNull();
    expect(found1.cookie).toBe('');
    // The write happened (localStorage set to the token).
    expect(await first.deck.eval('window.localStorage.getItem("bl-store")')).toBe(token);
  } finally {
    await first.app.closeDoc(first.docId).catch(() => undefined);
    await first.close();
  }

  // Reopen the same file. A Protected partition is non-persistent and was cleared on close, so the second
  // open must find nothing.
  const second = await openFixture({ scratch: s, fixture: 'storage.html', trust: 'protected', folder, cfg, userData });
  try {
    await second.waitPhase('load');
    await sleep(600);
    const found2 = (await second.deck.eval('window.__bl.found')) as Found;
    expect(found2.cookie, `cookie survived a Protected reopen: ${JSON.stringify(found2)}`).toBe('');
    expect(found2.local, `localStorage survived a Protected reopen: ${JSON.stringify(found2)}`).toBeNull();
    expect(found2.idb, `IndexedDB survived a Protected reopen: ${JSON.stringify(found2)}`).toBeNull();
  } finally {
    await second.close();
    s.cleanup();
  }
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
    await session.waitPhase('load');
    await sleep(600);
    expect(await session.deck.eval('window.localStorage.getItem("bl-store")')).toBe(token);
    // A Trusted file runs in a persistent partition (9.1), the disk half of "kept per file".
    expect((await session.app.win(session.docId)).partition).toMatch(/^persist:deck-/);
  } finally {
    await session.close();
    s.cleanup();
  }
});

// 6.10 says a Trusted file keeps storage "per file", and 9.1 gives it a persistent partition
// (persist:deck-<fileKey>). localStorage, document.cookie and IndexedDB are also keyed by ORIGIN
// (blueline://<docId>), so the Trusted docId is kept per file too (documents.ts trustedDocumentId: random,
// generated once, stored in <userData>/files/<fileKey>/origin). Protected opens never reuse it.
test('trusted: storage is kept per file across reopen', async () => {
  const s = scratch();
  const dns = await sharedDnsServer();
  const cfg: NetConfig = { uniq: uniqLabel('trusted'), zone: dns.zone, port: 0, udp: 0, tcp: 0, sink: dns.sinkIp };
  const folder = prepareFixtureFolder(s, cfg);
  const userData = s.dir('ud');
  const token = cfg.uniq;

  const first = await openFixture({ scratch: s, fixture: 'storage.html', trust: 'trusted', folder, cfg, userData });
  try {
    await first.waitPhase('load');
    await sleep(600);
    expect(await first.deck.eval('window.localStorage.getItem("bl-store")')).toBe(token);
    await first.app.flushStorage(first.deck);
    await sleep(400);
  } finally {
    await first.app.closeDoc(first.docId).catch(() => undefined);
    await first.close();
  }

  const second = await openFixture({ scratch: s, fixture: 'storage.html', trust: 'trusted', folder, cfg, userData });
  try {
    await second.waitPhase('load');
    await sleep(800);
    const found2 = (await second.deck.eval('window.__bl.found')) as Found;
    expect(found2.local, `localStorage should survive a Trusted reopen: ${JSON.stringify(found2)}`).toBe(token);
  } finally {
    await second.close();
    s.cleanup();
  }
});
