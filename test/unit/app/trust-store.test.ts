// trust.json (6.10 What changes, 6.8 Received, 9.7): decisions per realpath, applied only while the file carries
// the same marker; malformed files are never trusted; unknown fields kept; size limits.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_TRUST_BYTES, MAX_TRUST_ENTRIES, TrustStore, sanitizeEntry } from '../../../packages/app/src/main/trust-store';

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

  it('null equals null: a decision on an unmarked file applies while it stays unmarked', async () => {
    const s = new TrustStore(file).load();
    await s.set('/d/b.html', { marker: null, allowNetwork: true, editing: false, received: true, at });
    expect(s.get('/d/b.html', null)).toMatchObject({ marker: null, allowNetwork: true });
  });

  it('Windows markers compare as the whole Zone.Identifier text', async () => {
    const s = new TrustStore(file).load();
    await s.set('C:\\Users\\a\\Downloads\\deck.html', { marker: ZONE, allowNetwork: false, editing: true, received: true, at });
    expect(s.get('C:\\Users\\a\\Downloads\\deck.html', ZONE)?.editing).toBe(true);
    expect(s.get('C:\\Users\\a\\Downloads\\deck.html', ZONE.replace('a\r\n', 'b\r\n'))).toBeNull();
  });

  it('keys are realpaths exactly as given: never case-folded', async () => {
    const s = new TrustStore(file).load();
    await s.set('/d/Deck.html', { marker: null, allowNetwork: true, editing: false, received: true, at });
    expect(s.get('/d/deck.html', null)).toBeNull();
    expect(s.get('/d/Deck.html', null)).not.toBeNull();
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
    expect(fs.existsSync(file)).toBe(false);
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
      files[`/d/f${i}.html`] = { marker: null, allowNetwork: true, editing: false, received: true, at: t };
    }
    write({ version: 1, files });
    const s = new TrustStore(file).load();
    expect(s.size).toBe(MAX_TRUST_ENTRIES);
    expect(s.get('/d/f0.html', null)).toBeNull();
    expect(s.get('/d/f4.html', null)).toBeNull();
    expect(s.get('/d/f5.html', null)).not.toBeNull();
  });

  it('sanitizeEntry rebuilds the entry field by field', () => {
    expect(sanitizeEntry({ marker: null, allowNetwork: false, editing: true, received: false, at, extra: 1 })).toEqual({
      trust: { marker: null, allowNetwork: false, editing: true, received: false, at },
      extra: { extra: 1 },
    });
    expect(sanitizeEntry(Object.create({ marker: null }))).toBeNull();
    expect(sanitizeEntry(null)).toBeNull();
  });
});
