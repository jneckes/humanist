// trust.json (6.10 What changes, 6.8 Received, 9.7): decisions per realpath, applied only while the file carries
// the same marker and, where the marker cannot tell two files apart (no marker; Windows), while it is the same
// file; Blueline's own writes re-bind; malformed files are never trusted; unknown fields kept; size limits.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_TRUST_BYTES,
  MAX_TRUST_ENTRIES,
  TRUST_WRITE_BUDGET,
  TrustStore,
  bindsToFile,
  readFileIdentity,
  rebindAfterOwnWrite,
  sameIdentity,
  sanitizeEntry,
  type FileIdentity,
} from '../../../packages/app/src/main/trust-store';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-trust-'));
  file = path.join(dir, 'trust.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const Q1 = '0083;65f1c2a3;Safari;6E1F6E7C-1C1B-4B8E-9D2E-123456789ABC';
const Q2 = '0083;65f1c2b9;Safari;0A0B0C0D-1C1B-4B8E-9D2E-123456789ABC';
const ZONE = '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://mail.example/a\r\n';
const at = '2026-10-17T10:00:00.000Z';
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const ID1: FileIdentity = { dev: '2049', ino: '1851480' };
const ID2: FileIdentity = { dev: '2049', ino: '1851417' };

/** A real file and its identity. */
async function realFile(name: string, text: string): Promise<{ p: string; id: FileIdentity }> {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return { p: fs.realpathSync(p), id: (await readFileIdentity(p))! };
}

/** Another program saves a different file at `p` (temp file + rename, as browsers, mail and sync clients do). */
async function replaceByRename(p: string, text: string): Promise<FileIdentity> {
  const tmp = `${p}.partial`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
  return (await readFileIdentity(p))!;
}

describe('TrustStore', () => {
  it('remembers a decision per realpath with its marker, atomically (0600), and reads it back', async () => {
    const s = new TrustStore(file).load();
    await s.set('/Users/a/Downloads/deck.html', { marker: Q1, allowNetwork: true, editing: false, received: true, at });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(read()).toEqual({ version: 1, files: { '/Users/a/Downloads/deck.html': { marker: Q1, allowNetwork: true, editing: false, received: true, at } } });
    const again = new TrustStore(file).load();
    expect(again.get('/Users/a/Downloads/deck.html', Q1)).toEqual({ marker: Q1, allowNetwork: true, editing: false, received: true, at });
  });

  it('applies a decision only while the file carries the same marker (the whole value)', async () => {
    const s = new TrustStore(file).load();
    await s.set('/d/deck.html', { marker: Q1, allowNetwork: true, editing: true, received: true, at });
    expect(s.get('/d/deck.html', Q1)?.allowNetwork).toBe(true);
    // Same agent and flags, other time and event id: a new download. Not even a prefix counts.
    expect(s.get('/d/deck.html', Q1.slice(0, -1))).toBeNull();
    // ... and the old decision is gone, from memory and from the file.
    expect(s.get('/d/deck.html', Q1)).toBeNull();
    await s.idle();
    expect(read().files).toEqual({});
  });

  it('a new marker drops the decision; so does losing the marker, and gaining one', async () => {
    const s = new TrustStore(file).load();
    await s.set('/d/a.html', { marker: Q1, allowNetwork: true, editing: false, received: true, at });
    await s.set('/d/b.html', { marker: null, allowNetwork: false, editing: true, received: true, at });
    await s.set('/d/c.html', { marker: ZONE, allowNetwork: true, editing: true, received: false, at });
    expect(s.get('/d/a.html', Q2)).toBeNull();
    expect(s.get('/d/b.html', Q1)).toBeNull(); // the file gained a marker
    expect(s.get('/d/c.html', null)).toBeNull(); // the file lost its marker
    await s.idle();
    expect(Object.keys(read().files)).toEqual([]);
    expect(s.size).toBe(0);
  });

  it('no marker: a decision applies only to the same file (its identity), never to another file at the path (findings 5, 28)', async () => {
    const s = new TrustStore(file, undefined, undefined, { platform: 'linux' }).load();
    await s.set('/d/b.html', { marker: null, identity: ID1, allowNetwork: true, editing: false, received: true, at });
    expect(read().files['/d/b.html'].identity).toEqual(ID1);
    expect(s.get('/d/b.html', null, { identity: ID1 })).toMatchObject({ marker: null, identity: ID1, allowNetwork: true });
    // An identity that could not be read: nothing to compare, so nothing applies and nothing is dropped.
    expect(s.get('/d/b.html', null)).toBeNull();
    expect(s.get('/d/b.html', null, { identity: null })).toBeNull();
    expect(s.size).toBe(1);
    // Another file at the path: the decision is dropped, from memory and from the file.
    expect(s.get('/d/b.html', null, { identity: ID2 })).toBeNull();
    expect(s.get('/d/b.html', null, { identity: ID1 })).toBeNull();
    await s.idle();
    expect(read().files).toEqual({});
  });

  it('an unmarked decision from before identities (no identity stored) applies to no file and is dropped', async () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, files: { '/d/old.html': { marker: null, allowNetwork: true, editing: true, received: true, at } } }));
    const s = new TrustStore(file, undefined, undefined, { platform: 'darwin' }).load();
    expect(s.size).toBe(1);
    expect(s.get('/d/old.html', null, { identity: ID1 })).toBeNull();
    expect(s.size).toBe(0);
  });

  it('which decisions are bound to the file: no marker anywhere; every Zone.Identifier on Windows; never a macOS quarantine value', () => {
    expect(bindsToFile(null, 'darwin')).toBe(true);
    expect(bindsToFile(null, 'linux')).toBe(true);
    expect(bindsToFile(null, 'win32')).toBe(true);
    expect(bindsToFile(ZONE, 'win32')).toBe(true);
    expect(bindsToFile(Q1, 'darwin')).toBe(false);
  });

  it('Windows markers compare as the whole Zone.Identifier text, and the decision is bound to the file', async () => {
    const s = new TrustStore(file, undefined, undefined, { platform: 'win32' }).load();
    const p = 'C:\\Users\\a\\Downloads\\deck.html';
    await s.set(p, { marker: ZONE, identity: ID1, allowNetwork: false, editing: true, received: true, at });
    expect(s.get(p, ZONE, { identity: ID1 })?.editing).toBe(true);
    // A second download of the same link: byte-identical text, another file.
    expect(s.get(p, ZONE, { identity: ID2 })).toBeNull();
    await s.set(p, { marker: ZONE, identity: ID1, allowNetwork: false, editing: true, received: true, at });
    expect(s.get(p, ZONE.replace('a\r\n', 'b\r\n'), { identity: ID1 })).toBeNull();
  });

  it('macOS: the quarantine value binds the decision by itself (unchanged): another file with the same value keeps it, a new value drops it', async () => {
    const s = new TrustStore(file, undefined, undefined, { platform: 'darwin' }).load();
    await s.set('/Users/a/Downloads/deck.html', { marker: Q1, allowNetwork: true, editing: true, received: true, at });
    expect(read().files['/Users/a/Downloads/deck.html'].identity).toBeUndefined();
    expect(s.get('/Users/a/Downloads/deck.html', Q1, { identity: ID1 })).toMatchObject({ allowNetwork: true, editing: true });
    expect(s.get('/Users/a/Downloads/deck.html', Q1, { identity: ID2 })).toMatchObject({ allowNetwork: true, editing: true });
    expect(s.get('/Users/a/Downloads/deck.html', Q2)).toBeNull();
  });

  it('remember() binds a decision on an unmarked file to the file recorded at open, else to the file there now', async () => {
    const s = new TrustStore(file, undefined, undefined, { platform: 'linux' }).load();
    const a = await realFile('a.html', '<h1>A</h1>');
    // No record yet: the file at the path now.
    await s.remember(a.p, null, { allowNetwork: true });
    expect(read().files[a.p]).toMatchObject({ marker: null, identity: a.id, allowNetwork: true, editing: false, received: true });
    await s.remember(a.p, null, { editing: true });
    expect(s.get(a.p, null, { identity: a.id })).toMatchObject({ allowNetwork: true, editing: true });
    // Recorded at open (resolveOpenTrust), then replaced before the click: the switch binds to the file the user saw.
    const b = await realFile('b.html', '<h1>B</h1>');
    await s.set(b.p, { marker: null, identity: b.id, allowNetwork: false, editing: false, received: true });
    const replaced = await replaceByRename(b.p, '<h1>Not what the user saw</h1>');
    await s.remember(b.p, null, { allowNetwork: true });
    expect(read().files[b.p].identity).toEqual(b.id);
    expect(s.get(b.p, null, { identity: replaced })).toBeNull();
  });

  it('remember() remembers nothing when the file cannot be told apart (no identity): the switch applies to the window only', async () => {
    const s = new TrustStore(file, undefined, undefined, { platform: 'linux', identityOf: async () => null }).load();
    await expect(s.remember('/d/gone.html', null, { allowNetwork: true })).rejects.toThrow(/cannot be told apart/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("Blueline's own write re-binds the decision to the new file; a re-bind from another file changes nothing", async () => {
    const s = new TrustStore(file, undefined, undefined, { platform: 'linux' }).load();
    await s.set('/d/r.html', { marker: null, identity: ID1, allowNetwork: true, editing: true, received: true, at });
    await s.rebind('/d/r.html', ID2, { dev: '2049', ino: '99' });
    expect(read().files['/d/r.html'].identity).toEqual(ID1);
    await s.rebind('/d/r.html', ID1, ID2);
    expect(read().files['/d/r.html']).toMatchObject({ identity: ID2, allowNetwork: true, editing: true, at });
    expect(s.get('/d/r.html', null, { identity: ID2 })).toMatchObject({ allowNetwork: true, editing: true });
  });

  it("rebindAfterOwnWrite re-binds in the app's store (forUserData) after an atomic write (a new inode)", async () => {
    const ud = path.join(dir, 'ud');
    const s = TrustStore.forUserData(ud).load();
    const f = await realFile('own.html', '<h1>Mine</h1>');
    await s.remember(f.p, null, { allowNetwork: true, editing: true });
    const after = await replaceByRename(f.p, '<h1>Mine, saved by Blueline</h1>');
    expect(after).not.toEqual(f.id);
    await rebindAfterOwnWrite(f.p, f.id);
    await s.idle();
    expect(s.get(f.p, null, { identity: after })).toMatchObject({ allowNetwork: true, editing: true });
    expect(JSON.parse(fs.readFileSync(path.join(ud, 'trust.json'), 'utf8')).files[f.p].identity).toEqual(after);
  });

  it('a freed inode number given to the next new file (ext4 does so at once) is another file: the birth time tells them apart', async () => {
    const a = await realFile('reuse.html', '<h1>A</h1>');
    fs.unlinkSync(a.p);
    // Past the file-system clock's tick (a coarse clock can give two files made within a few ms the same time).
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(a.p, '<h1>B</h1>');
    const b = (await readFileIdentity(a.p))!;
    expect(sameIdentity(a.id, b), JSON.stringify({ a: a.id, b })).toBe(false);
    expect(sameIdentity(a.id, (await readFileIdentity(fs.realpathSync(path.join(dir, 'reuse.html'))))!)).toBe(false);
    expect(sameIdentity(b, (await readFileIdentity(a.p))!)).toBe(true);
    expect(sameIdentity({ dev: '1', ino: '2', birth: '3' }, { dev: '1', ino: '2' })).toBe(false);
    expect(sameIdentity({ dev: '1', ino: '2' }, { dev: '1', ino: '2' })).toBe(true);
  });

  it('keys are realpaths exactly as given: never case-folded', async () => {
    const s = new TrustStore(file).load();
    await s.set('/d/Deck.html', { marker: Q1, allowNetwork: true, editing: false, received: true, at });
    expect(s.get('/d/deck.html', Q1)).toBeNull();
    expect(s.get('/d/Deck.html', Q1)).not.toBeNull();
  });

  it('remember() merges switches for the same marker and starts over for another', async () => {
    let t = 0;
    const s = new TrustStore(file, undefined, () => new Date(Date.UTC(2026, 9, 17, 10, 0, t++))).load();
    await s.remember('/d/a.html', Q1, { allowNetwork: true });
    expect(s.get('/d/a.html', Q1)).toMatchObject({ allowNetwork: true, editing: false, received: true });
    await s.remember('/d/a.html', Q1, { editing: true });
    expect(s.get('/d/a.html', Q1)).toMatchObject({ allowNetwork: true, editing: true, received: true });
    await s.remember('/d/a.html', Q1, { received: false });
    expect(s.get('/d/a.html', Q1)).toMatchObject({ allowNetwork: true, editing: true, received: false });
    await s.remember('/d/a.html', Q2, { editing: true });
    expect(s.get('/d/a.html', Q2)).toMatchObject({ allowNetwork: false, editing: true, received: true });
  });

  it('clear() forgets one file', async () => {
    const s = new TrustStore(file).load();
    await s.set('/d/a.html', { marker: null, allowNetwork: true, editing: false, received: true, at });
    await s.set('/d/b.html', { marker: null, allowNetwork: true, editing: false, received: true, at });
    await s.clear('/d/a.html');
    expect(Object.keys(read().files)).toEqual(['/d/b.html']);
    await s.clear('/d/nothing.html');
  });

  it('refuses a relative path or an invalid decision', async () => {
    const s = new TrustStore(file).load();
    await expect(s.set('deck.html', { marker: null, allowNetwork: true, editing: false, received: true })).rejects.toThrow();
    await expect(s.set('/d/a.html', { marker: '', allowNetwork: true, editing: false, received: true })).rejects.toThrow();
    await expect(s.set('/d/a.html', { marker: 'x'.repeat(70 * 1024), allowNetwork: true, editing: false, received: true })).rejects.toThrow();
    await expect(s.set('/d/a.html', { marker: null, allowNetwork: 'yes' as unknown as boolean, editing: false, received: true })).rejects.toThrow();
    await expect(s.set('/d/a.html', { marker: null, identity: { dev: '1', ino: 'x' }, allowNetwork: true, editing: false, received: true })).rejects.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('an in-memory store (blueline pdf and map) never reads or writes trust.json', async () => {
    await new TrustStore(file).set('/d/a.html', { marker: Q1, allowNetwork: true, editing: true, received: true, at });
    const before = fs.readFileSync(file, 'utf8');
    const m = TrustStore.inMemory().load();
    expect(m.get('/d/a.html', Q1)).toBeNull();
    await m.set('/d/b.html', { marker: Q1, allowNetwork: false, editing: false, received: true });
    await m.remember('/d/a.html', Q1, { allowNetwork: true });
    await m.idle();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(['trust.json']);
  });
});

describe('reading trust.json defensively', () => {
  const write = (v: unknown) => fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v));

  it.each([
    ['not JSON', '{"files": {'],
    ['an array', [1, 2]],
    ['a string', '"hello"'],
    ['files is an array', { version: 1, files: [{ marker: null }] }],
    ['files is a string', { version: 1, files: '/d/a.html' }],
  ])('a malformed file (%s) is ignored: nothing is remembered', (_why, v) => {
    write(v);
    const s = new TrustStore(file).load();
    expect(s.size).toBe(0);
    expect(s.get('/d/a.html', null)).toBeNull();
  });

  it('a file over the size limit is ignored', () => {
    const big = { version: 1, files: { '/d/a.html': { marker: null, allowNetwork: true, editing: true, received: true, at } }, pad: 'x'.repeat(MAX_TRUST_BYTES) };
    write(big);
    expect(new TrustStore(file).load().size).toBe(0);
  });

  it('a directory or missing file reads as empty', () => {
    expect(new TrustStore(path.join(dir, 'missing.json')).load().size).toBe(0);
    fs.mkdirSync(path.join(dir, 'adir'));
    expect(new TrustStore(path.join(dir, 'adir')).load().size).toBe(0);
  });

  it('an entry with a bad field is ignored (never trusted), the others are read', () => {
    write({
      version: 1,
      files: {
        '/d/good.html': { marker: Q1, allowNetwork: true, editing: false, received: true, at },
        '/d/bad-bool.html': { marker: Q1, allowNetwork: 'true', editing: false, received: true, at },
        '/d/bad-marker.html': { marker: 42, allowNetwork: true, editing: false, received: true, at },
        '/d/empty-marker.html': { marker: '', allowNetwork: true, editing: false, received: true, at },
        '/d/huge-marker.html': { marker: 'q'.repeat(65 * 1024), allowNetwork: true, editing: false, received: true, at },
        '/d/no-at.html': { marker: null, allowNetwork: true, editing: false, received: true },
        '/d/bad-at.html': { marker: null, allowNetwork: true, editing: false, received: true, at: 'yesterday' },
        '/d/missing.html': { marker: null, allowNetwork: true },
        'relative.html': { marker: null, allowNetwork: true, editing: false, received: true, at },
        '/d/array.html': [true],
      },
    });
    const s = new TrustStore(file).load();
    expect(s.size).toBe(1);
    expect(s.get('/d/good.html', Q1)?.allowNetwork).toBe(true);
    for (const k of ['/d/bad-bool.html', '/d/bad-marker.html', '/d/empty-marker.html', '/d/huge-marker.html', '/d/no-at.html', '/d/bad-at.html', '/d/missing.html', '/d/array.html']) {
      expect(s.get(k, Q1), k).toBeNull();
      expect(s.get(k, null), k).toBeNull();
    }
  });

  it('prototype-pollution keys are refused', () => {
    fs.writeFileSync(file, `{"__proto__": {"polluted": true}, "files": {"__proto__": {"marker": null, "allowNetwork": true, "editing": true, "received": true, "at": "${at}"}, "/d/a.html": {"marker": null, "allowNetwork": true, "editing": true, "received": true, "at": "${at}", "__proto__": {"x": 1}}}}`);
    const s = new TrustStore(file).load();
    expect(s.size).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps unknown fields, top-level and per entry, when it rewrites the file', async () => {
    write({
      version: 1,
      newerSetting: { a: 1 },
      files: { '/d/a.html': { marker: Q1, allowNetwork: false, editing: false, received: true, at, sharedWith: ['anna'] } },
    });
    const s = new TrustStore(file).load();
    await s.set('/d/a.html', { marker: Q1, allowNetwork: true, editing: false, received: true, at });
    const out = read();
    expect(out.newerSetting).toEqual({ a: 1 });
    expect(out.files['/d/a.html']).toEqual({ marker: Q1, allowNetwork: true, editing: false, received: true, at, sharedWith: ['anna'] });
    // A new marker is a new file: its old unknown fields do not carry over.
    await s.set('/d/a.html', { marker: Q2, allowNetwork: false, editing: false, received: true, at });
    expect(read().files['/d/a.html'].sharedWith).toBeUndefined();
  });

  it('keeps at most MAX_TRUST_ENTRIES, dropping the oldest', async () => {
    const files: Record<string, unknown> = {};
    for (let i = 0; i < MAX_TRUST_ENTRIES + 5; i++) {
      const t = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
      files[`/d/f${i}.html`] = { marker: Q1, allowNetwork: true, editing: false, received: true, at: t };
    }
    write({ version: 1, files });
    const s = new TrustStore(file).load();
    expect(s.size).toBe(MAX_TRUST_ENTRIES);
    expect(s.get('/d/f0.html', Q1)).toBeNull();
    expect(s.get('/d/f4.html', Q1)).toBeNull();
    expect(s.get('/d/f5.html', Q1)).not.toBeNull();
  });

  it('never writes a file its next launch would ignore: 10,000 decisions with ~1 KB markers and a few near 64 KiB stay under the cap, reload, and the newest survive (finding 8)', async () => {
    let t = 0;
    const s = new TrustStore(file, undefined, () => new Date(Date.UTC(2026, 0, 1) + t++ * 1000), { platform: 'darwin' }).load();
    const zone = (i: number, n: number) => `[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://share.example/folder\r\nHostUrl=https://share.example/${String(i).padStart(6, '0')}/${'x'.repeat(n)}\r\n`;
    let last: Promise<void> = Promise.resolve();
    for (let i = 0; i < MAX_TRUST_ENTRIES; i++) last = s.set(`/d/f${i}.html`, { marker: zone(i, 1000), allowNetwork: i % 2 === 0, editing: false, received: true });
    for (let i = 0; i < 4; i++) last = s.set(`/d/big${i}.html`, { marker: zone(i, 64 * 1024 - 200), allowNetwork: true, editing: true, received: true });
    await last;
    await s.idle();
    const size = fs.statSync(file).size;
    expect(size, 'a file over MAX_TRUST_BYTES is ignored as a whole at the next launch').toBeLessThan(MAX_TRUST_BYTES);
    expect(size).toBeLessThanOrEqual(TRUST_WRITE_BUDGET);
    const again = new TrustStore(file, undefined, undefined, { platform: 'darwin' }).load();
    expect(again.size).toBe(s.size);
    expect(again.size).toBeGreaterThan(1000);
    // The newest are kept, the oldest went.
    for (let i = 0; i < 4; i++) expect(again.get(`/d/big${i}.html`, zone(i, 64 * 1024 - 200)), `big${i}`).toMatchObject({ allowNetwork: true, editing: true });
    expect(again.get(`/d/f${MAX_TRUST_ENTRIES - 2}.html`, zone(MAX_TRUST_ENTRIES - 2, 1000))).toMatchObject({ allowNetwork: true });
    expect(again.get('/d/f0.html', zone(0, 1000))).toBeNull();
  });

  it('sanitizeEntry rebuilds the entry field by field', () => {
    expect(sanitizeEntry({ marker: null, allowNetwork: false, editing: true, received: false, at, extra: 1 })).toEqual({
      trust: { marker: null, allowNetwork: false, editing: true, received: false, at },
      extra: { extra: 1 },
    });
    expect(sanitizeEntry({ marker: null, identity: { dev: '2049', ino: '1851480', birth: '1792259571658582028', extra: 1 }, allowNetwork: false, editing: true, received: false, at })).toEqual({
      trust: { marker: null, identity: { dev: '2049', ino: '1851480', birth: '1792259571658582028' }, allowNetwork: false, editing: true, received: false, at },
      extra: {},
    });
    // An identity that is not decimal strings (or ino 0: a file system without file numbers) is refused.
    for (const identity of [null, 'x', { dev: 1, ino: 2 }, { dev: '1' }, { dev: '1', ino: '0' }, { dev: '-1', ino: '2' }, { dev: '1', ino: '9'.repeat(41) }, { dev: '1', ino: '2', birth: 3 }, { dev: '1', ino: '2', birth: '0' }]) {
      expect(sanitizeEntry({ marker: null, identity, allowNetwork: false, editing: true, received: false, at }), JSON.stringify(identity)).toBeNull();
    }
    expect(sanitizeEntry(Object.create({ marker: null }))).toBeNull();
    expect(sanitizeEntry(null)).toBeNull();
  });
});
