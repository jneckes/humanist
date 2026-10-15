// Documents (9.1, 9.2 rule 1, 6.10 When it applies): identity, trust, served copy, partition registry.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BlDocument,
  DocumentRegistry,
  OpenError,
  REASON_REQUESTED,
  contentHashOf,
  decideTrust,
  extractTitle,
  fileKeyOf,
  loadDocument,
  newDocumentId,
  originFileFor,
  partitionFor,
  trustedDocumentId,
} from '../../../packages/app/src/main/documents';
import { sha256Hex } from '../../../packages/app/src/main/atomic-write';
import { handleDeckRequest } from '../../../packages/app/src/main/protocol';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/decks');
let dir: string;
const noMarker = async () => ({ marker: null, reason: null });
const internet = async () => ({ marker: '0083;6720f2a1;Safari;0F2E', reason: 'Came from the internet' });
const opts = { protectedRequested: false, readMarker: noMarker, untrustedLocation: () => false };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-docs-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: string | Uint8Array): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('decideTrust (6.10)', () => {
  it('requested Protected wins; a marker or an unreadable marker means Protected; otherwise Trusted', async () => {
    expect(await decideTrust('/a', true, noMarker)).toEqual({ trust: 'protected', reason: REASON_REQUESTED, marker: null });
    expect(await decideTrust('/a', false, internet)).toEqual({ trust: 'protected', reason: 'Came from the internet', marker: '0083;6720f2a1;Safari;0F2E' });
    expect(await decideTrust('/a', false, async () => ({ marker: null, reason: 'Could not check where this file came from', uncertain: true }))).toMatchObject({ trust: 'protected' });
    expect(await decideTrust('/a', false, async () => Promise.reject(new Error('x')))).toMatchObject({ trust: 'protected' });
    expect(await decideTrust('/a', false, noMarker)).toEqual({ trust: 'trusted', reason: null, marker: null });
  });
});

describe('identity helpers', () => {
  it('docId: 16 lowercase hex; fileKey: first 16 hex of sha256(realpath); partitions (9.1)', () => {
    expect(newDocumentId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newDocumentId()).not.toBe(newDocumentId());
    expect(fileKeyOf('/a/b.html')).toBe(sha256Hex(new TextEncoder().encode('/a/b.html')).slice(0, 16));
    expect(partitionFor('protected', '0123456789abcdef', 'ffffffffffffffff')).toBe('deck-0123456789abcdef');
    expect(partitionFor('trusted', '0123456789abcdef', 'ffffffffffffffff')).toBe('persist:deck-ffffffffffffffff');
  });

  it('extractTitle', () => {
    expect(extractTitle('<html><head><title>Q4 &amp; beyond\n  plan&#x2014;draft</title>')).toBe('Q4 & beyond plan—draft');
    expect(extractTitle('<p>none</p>')).toBe('');
  });
});

describe('loadDocument', () => {
  it('opens a UTF-8 deck Trusted: realpath, map, version, served copy with stamps', async () => {
    const p = write('deck.html', '<!doctype html><title>T</title><h1>Hello</h1><p>World</p>');
    const d = await loadDocument(p, opts);
    expect(d.realpath).toBe(fs.realpathSync(p));
    expect(d.fileName).toBe('deck.html');
    expect(d.folderReal).toBe(fs.realpathSync(dir));
    expect(d.trust()).toBe('trusted');
    expect(d.partition).toBe(`persist:deck-${d.fileKey}`);
    expect(d.editingAllowed()).toBe(true);
    expect(d.editable()).toBe(true);
    expect(d.networkAllowed()).toBe(false);
    expect(d.readOnlyReason).toBeNull();
    expect(d.version).toBe(sha256Hex(fs.readFileSync(p)));
    expect(d.knownHash).toBe(d.version);
    expect(d.map.version).toBe(d.version);
    expect(d.title).toBe('T');
    const body = new TextDecoder().decode((await d.documentBody()).body);
    expect(body).toMatch(/<h1 data-bl-e="bl-\d+">Hello<\/h1>/);
    expect(new Uint8Array(fs.readFileSync(p))).toEqual(d.bytes); // the file itself is never touched
  });

  it('--protected: Protected partition, network and editing off until allowed (6.10)', async () => {
    const p = write('prot.html', '<link rel="dns-prefetch" href="//x.example"><p>hi</p>');
    const d = await loadDocument(p, { ...opts, protectedRequested: true });
    expect(d.trust()).toBe('protected');
    expect(d.trustReason).toBe(REASON_REQUESTED);
    expect(d.partition).toBe(`deck-${d.docId}`);
    expect(d.received).toBe(true);
    expect(d.editingAllowed()).toBe(false);
    expect(d.servedProtected()).toBe(true);
    const prot = new TextDecoder().decode((await d.documentBody()).body);
    expect(prot).not.toMatch(/dns-prefetch/); // 9.9: resource hints removed in Protected view
    d.allowNetwork();
    expect(d.networkAllowed()).toBe(true);
    expect(d.servedProtected()).toBe(false);
    expect(new TextDecoder().decode((await d.documentBody()).body)).toMatch(/dns-prefetch/);
    d.enableEditing();
    expect(d.editingAllowed()).toBe(true);
    expect(d.trust()).toBe('protected'); // trust itself never changes while open
  });

  it('a file with an internet marker opens Protected with the marker kept', async () => {
    const p = write('dl.html', '<p>x</p>');
    const d = await loadDocument(p, { ...opts, readMarker: internet });
    expect(d.trust()).toBe('protected');
    expect(d.marker).toBe('0083;6720f2a1;Safari;0F2E');
  });

  it('windows-1252: read-only reason, no stamps, served byte for byte through latin1 (9.2 rule 1, 9.1 Charset)', async () => {
    const src = path.join(FIXTURES, 'windows-1252.html');
    const d = await loadDocument(src, opts);
    expect(d.utf8).toBe(false);
    expect(d.readOnlyReason).toBe('windows-1252.html is not UTF-8; direct edits are off');
    expect(d.editable()).toBe(false);
    const { body, utf8 } = await d.documentBody();
    expect(utf8).toBe(false);
    expect(new Uint8Array(body)).toEqual(new Uint8Array(fs.readFileSync(src)));
  });

  it('the notes block is removed from the served copy and from Session.deck.sha256 (section 8)', async () => {
    const src = path.join(FIXTURES, 'notes-block.html');
    const d = await loadDocument(src, opts);
    expect(d.map.notesBlock).not.toBeNull();
    const body = new TextDecoder().decode((await d.documentBody()).body);
    const nb = d.map.notesBlock!;
    expect(body).not.toContain(d.decoded.src.slice(nb.start, nb.end));
    const stripped = d.decoded.src.slice(0, nb.start) + d.decoded.src.slice(nb.end);
    expect(d.contentHash).toBe(sha256Hex(new TextEncoder().encode(stripped)));
    expect(contentHashOf(d.decoded, { ...d.map, notesBlock: null }, d.version)).toBe(d.version);
  });

  it('refuses what it should not open, with a message for the user', async () => {
    await expect(loadDocument(path.join(dir, 'missing.html'), opts)).rejects.toThrow(/not found/);
    await expect(loadDocument(write('notes.txt', 'x'), opts)).rejects.toThrow(/not an HTML file/);
    fs.mkdirSync(path.join(dir, 'folder.html'));
    await expect(loadDocument(path.join(dir, 'folder.html'), opts)).rejects.toThrow(/not a regular file/);
    await expect(loadDocument('a\0b.html', opts)).rejects.toBeInstanceOf(OpenError);
  });

  it('follows a symlink to its realpath (always written there, 9.2 step 4.1)', async () => {
    const target = write('real.html', '<p>r</p>');
    const link = path.join(dir, 'link.html');
    fs.symlinkSync(target, link);
    const d = await loadDocument(link, opts);
    expect(d.realpath).toBe(fs.realpathSync(target));
    expect(d.path).toBe(link);
    expect(d.fileName).toBe('real.html');
  });

  it('accepts .HTM in any case', async () => {
    const d = await loadDocument(write('UPPER.HTM', '<p>x</p>'), opts);
    expect(d.fileName).toBe('UPPER.HTM');
  });
});

describe('DocumentRegistry: a partition sees only its own documents (9.1 Refusals step 1)', () => {
  it('lookupIn / lookupFor', async () => {
    const a = await loadDocument(write('a.html', '<p>a</p>'), { ...opts, protectedRequested: true });
    const b = await loadDocument(write('b.html', '<p>b</p>'), opts);
    const r = new DocumentRegistry();
    r.add(a);
    r.add(b);
    expect(() => r.add(a)).toThrow();
    expect(r.lookupIn(a.partition, a.docId)).toBe(a);
    expect(r.lookupIn(a.partition, b.docId)).toBeUndefined();
    expect(r.lookupIn(b.partition, a.docId)).toBeUndefined();
    expect(r.lookupFor(b.partition)(b.docId)).toBe(b);
    // Through the real handler: another partition's document is a 404.
    const req = (url: string) => ({ url, method: 'GET', headers: { get: () => null } });
    expect((await handleDeckRequest(req(`blueline://${b.docId}/b.html`), r.lookupFor(b.partition))).status).toBe(200);
    expect((await handleDeckRequest(req(`blueline://${a.docId}/a.html`), r.lookupFor(b.partition))).status).toBe(404);
    r.remove(a);
    expect(r.get(a.docId)).toBeUndefined();
    expect(r.lookupIn(a.partition, a.docId)).toBeUndefined();
    expect(r.all()).toEqual([b]);
  });

  it('BlDocument refuses a docId that is not 16 lowercase hex', () => {
    expect(
      () =>
        new BlDocument({
          docId: 'ABC',
          path: '/x.html',
          realpath: '/x.html',
          bytes: new Uint8Array(),
          trust: { trust: 'trusted', reason: null, marker: null },
          received: false,
        }),
    ).toThrow();
  });
});

describe('BlDocument.io (DeckIO with the 9.1 write-time checks)', () => {
  it('refuses without the Edit capability, for a non-UTF-8 file, and in Protected view until Enable editing; sets knownHash', async () => {
    const p = write('io.html', '<p>one</p>');
    const d = await loadDocument(p, { ...opts, protectedRequested: true });
    let cap = false;
    const io = d.io(() => cap);
    const two = new TextEncoder().encode('<p>two</p>');
    await expect(io.atomicWrite(two, d.version)).rejects.toThrow(/not available/);
    cap = true;
    await expect(io.atomicWrite(two, d.version)).rejects.toThrow(/enable editing/);
    d.enableEditing();
    await io.atomicWrite(two, d.version);
    expect(fs.readFileSync(p, 'utf8')).toBe('<p>two</p>');
    expect(d.knownHash).toBe(sha256Hex(two));
    const w = await loadDocument(path.join(FIXTURES, 'windows-1252.html'), opts);
    await expect(w.io(() => true).atomicWrite(two, w.version)).rejects.toThrow(/not UTF-8/);
  });
});

describe('trustedDocumentId: a Trusted file keeps its origin across opens (6.10 Storage: kept per file)', () => {
  it('is random, kept in <userData>/files/<fileKey>/origin (0600), and the same on every call', async () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-origin-'));
    try {
      const key = fileKeyOf('/a/deck.html');
      const a = await trustedDocumentId(ud, key);
      expect(a).toMatch(/^[0-9a-f]{16}$/);
      expect(a).not.toBe(key); // never derived from the path
      expect(await trustedDocumentId(ud, key)).toBe(a);
      const file = originFileFor(ud, key);
      expect(fs.readFileSync(file, 'utf8')).toBe(`${a}\n`);
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      // Another file gets its own id; two first opens of one file at once agree on one id.
      expect(await trustedDocumentId(ud, fileKeyOf('/a/other.html'))).not.toBe(a);
      const k3 = fileKeyOf('/a/third.html');
      const [x, y] = await Promise.all([trustedDocumentId(ud, k3), trustedDocumentId(ud, k3)]);
      expect(x).toBe(y);
      expect(await trustedDocumentId(ud, k3)).toBe(x);
      // A damaged file is replaced, never trusted.
      fs.writeFileSync(file, '../../etc\n');
      const b = await trustedDocumentId(ud, key);
      expect(b).toMatch(/^[0-9a-f]{16}$/);
      expect(await trustedDocumentId(ud, key)).toBe(b);
    } finally {
      fs.rmSync(ud, { recursive: true, force: true });
    }
  });

  it('refuses a fileKey that is not 16 hex digits (it becomes a path)', () => {
    expect(() => originFileFor('/ud', '../x')).toThrow();
  });

  it('loadDocument asks docIdFor once trust is known', async () => {
    const p = write('origin.html', '<!doctype html><title>t</title><p>x</p>');
    const seen: [string, string][] = [];
    const docIdFor = async (trust: string, fileKey: string) => {
      seen.push([trust, fileKey]);
      return trust === 'trusted' ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb';
    };
    const t = await loadDocument(p, { ...opts, docIdFor });
    expect(t.docId).toBe('aaaaaaaaaaaaaaaa');
    expect(t.partition).toBe(`persist:deck-${t.fileKey}`);
    const pr = await loadDocument(p, { ...opts, protectedRequested: true, docIdFor });
    expect(pr.docId).toBe('bbbbbbbbbbbbbbbb');
    expect(pr.partition).toBe('deck-bbbbbbbbbbbbbbbb');
    expect(seen).toEqual([
      ['trusted', t.fileKey],
      ['protected', t.fileKey],
    ]);
  });
});
