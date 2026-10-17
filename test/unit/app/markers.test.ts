// Internet markers (6.10, D12), keeping them on writes and derived files (9.9), and untrusted locations (6.8
// Received, 6.10 Settings › Trust). The per-platform refused trusted folders are tabled in folders.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MARKER_AGENT,
  REASON_INTERNET,
  REASON_UNKNOWN,
  copyMarker,
  copyMarkerToTemp,
  decodeZoneIdentifier,
  isUntrustedLocation,
  markDerivedFile,
  markerXattrCopier,
  parseQuarantine,
  parseZoneId,
  readInternetMarker,
  refuseAsTrustedFolder,
  writeDownloadMarker,
  zoneStreamPath,
  type MarkerHelper,
} from '../../../packages/app/src/main/markers';
import type { QuarantineSpec } from '../../../packages/app/src/main/native-helper';

const enoent = () => Object.assign(new Error('nope'), { code: 'ENOENT' });

describe('Windows Zone.Identifier', () => {
  it('parses ZoneId from the ZoneTransfer section', () => {
    expect(parseZoneId('[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://mail.example/\r\nHostUrl=https://x/\r\n')).toBe(3);
    expect(parseZoneId('[zonetransfer]\nzoneid = 4\n')).toBe(4);
    expect(parseZoneId('ZoneId=2')).toBe(2);
    expect(parseZoneId('[Other]\nZoneId=3\n[ZoneTransfer]\nZoneId=1\n')).toBe(1);
    expect(parseZoneId('[ZoneTransfer]\nZoneId=three\n')).toBeNull();
    expect(parseZoneId('')).toBeNull();
    expect(parseZoneId('; comment\n[ZoneTransfer]\nHostUrl=x\n')).toBeNull();
  });

  it('decodes UTF-8 and UTF-16LE streams', () => {
    const text = '[ZoneTransfer]\r\nZoneId=3\r\n';
    expect(decodeZoneIdentifier(new TextEncoder().encode(text))).toBe(text);
    expect(decodeZoneIdentifier(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]))).toBe(text);
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(decodeZoneIdentifier(u16)).toBe(text);
  });

  it('ZoneId 3 or more is a marker carrying the whole stream', async () => {
    const reads: string[] = [];
    const text = '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.com/deck.html\r\n';
    const m = await readInternetMarker('C:\\Users\\a\\Downloads\\deck.html', {
      platform: 'win32',
      readFile: async (p) => {
        reads.push(p);
        return new TextEncoder().encode(text);
      },
    });
    expect(reads).toEqual(['C:\\Users\\a\\Downloads\\deck.html:Zone.Identifier']);
    expect(m).toEqual({ marker: text, reason: REASON_INTERNET });
  });

  it.each([
    ['ZoneId=0', null],
    ['ZoneId=1', null],
    ['ZoneId=2', null],
    ['ZoneId=4', 'marker'],
  ])('%s', async (line, expected) => {
    const m = await readInternetMarker('/x/deck.html', { platform: 'win32', readFile: async () => new TextEncoder().encode(`[ZoneTransfer]\n${line}\n`) });
    expect(m.marker === null ? null : 'marker').toBe(expected);
    expect(m.uncertain).toBeUndefined();
  });

  it('no stream is no marker; an unreadable or unparseable one is uncertain', async () => {
    expect(await readInternetMarker('/x/a.html', { platform: 'win32', readFile: async () => Promise.reject(enoent()) })).toEqual({ marker: null, reason: null });
    const eacces = await readInternetMarker('/x/a.html', { platform: 'win32', readFile: async () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })) });
    expect(eacces.uncertain).toBe(true);
    const garbage = await readInternetMarker('/x/a.html', { platform: 'win32', readFile: async () => new TextEncoder().encode('garbage') });
    expect(garbage.uncertain).toBe(true);
    const huge = await readInternetMarker('/x/a.html', { platform: 'win32', readFile: async () => new Uint8Array(70 * 1024) });
    expect(huge.uncertain).toBe(true);
  });
});

describe('macOS quarantine', () => {
  const q = '0083;65f1c2a3;Safari;6E1F6E7C-1C1B-4B8E-9D2E-123456789ABC';
  it('reads the whole value with xattr -p, without a shell', async () => {
    const calls: [string, string[]][] = [];
    const m = await readInternetMarker('/Users/a/Downloads/deck.html', {
      platform: 'darwin',
      execFile: async (file, args) => {
        calls.push([file, args]);
        return { code: 0, stdout: q + '\n', stderr: '' };
      },
    });
    expect(calls).toEqual([['/usr/bin/xattr', ['-p', 'com.apple.quarantine', '/Users/a/Downloads/deck.html']]]);
    expect(m).toEqual({ marker: q, reason: REASON_INTERNET });
  });
  it('no attribute is no marker; a helper failure is uncertain', async () => {
    const none = await readInternetMarker('/a.html', { platform: 'darwin', execFile: async () => ({ code: 1, stdout: '', stderr: 'xattr: /a.html: No such xattr: com.apple.quarantine' }) });
    expect(none).toEqual({ marker: null, reason: null });
    const broken = await readInternetMarker('/a.html', { platform: 'darwin', execFile: async () => ({ code: 127, stdout: '', stderr: 'not found' }) });
    expect(broken.uncertain).toBe(true);
    const empty = await readInternetMarker('/a.html', { platform: 'darwin', execFile: async () => ({ code: 0, stdout: '', stderr: '' }) });
    expect(empty.uncertain).toBe(true);
  });
  it('parses quarantine fields', () => {
    const p = parseQuarantine(q)!;
    expect(p.flags).toBe(0x83);
    expect(p.agent).toBe('Safari');
    expect(p.time?.toISOString()).toBe(new Date(0x65f1c2a3 * 1000).toISOString());
    expect(parseQuarantine('0081;5e8b1234;Mail')!.eventId).toBe('');
    expect(parseQuarantine('nonsense')).toBeNull();
  });
});

describe('other platforms', () => {
  it('Linux has no marker', async () => {
    expect(await readInternetMarker('/home/a/deck.html', { platform: 'linux' })).toEqual({ marker: null, reason: null });
  });
  it('a relative path is uncertain', async () => {
    expect((await readInternetMarker('deck.html', { platform: 'linux' })).uncertain).toBe(true);
  });
});

describe('download markers', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-markers-')));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes a Zone.Identifier with ZoneId=3 naming the deck and the download (win32)', async () => {
    // On Linux `<path>:Zone.Identifier` is an ordinary file name, which is enough to check the content.
    const saved = path.join(dir, 'data.csv');
    fs.writeFileSync(saved, 'a,b');
    const wrote = await writeDownloadMarker(saved, { hostUrl: 'https://cdn.example/data.csv\r\nZoneId=0', sourcePath: path.join(dir, 'deck.html') }, { platform: 'win32' });
    expect(wrote).toBe(true);
    const text = fs.readFileSync(`${saved}:Zone.Identifier`, 'utf8');
    expect(parseZoneId(text)).toBe(3);
    expect(text).toContain('ReferrerUrl=file://');
    expect(text.split('\r\n').filter((l) => l.startsWith('ZoneId='))).toEqual(['ZoneId=3']);
    const m = await readInternetMarker(saved, { platform: 'win32' });
    expect(m.marker).toBe(text);
  });
  it('a data: download gets HostUrl=about:internet (the stream stays a readable marker)', async () => {
    const saved = path.join(dir, 'blob.bin');
    fs.writeFileSync(saved, 'x');
    await writeDownloadMarker(saved, { hostUrl: `data:text/plain,${'A'.repeat(100_000)}`, sourcePath: path.join(dir, 'deck.html') }, { platform: 'win32' });
    const text = fs.readFileSync(`${saved}:Zone.Identifier`, 'utf8');
    expect(text).toContain('HostUrl=about:internet');
    expect(text.length).toBeLessThan(2048);
    expect((await readInternetMarker(saved, { platform: 'win32' })).marker).toBe(text);
  });

  it('Linux writes no download marker; a relative path gets none', async () => {
    expect(await writeDownloadMarker(path.join(dir, 'x'), { hostUrl: 'https://x/', sourcePath: null }, { platform: 'linux' })).toBe(false);
    expect(await writeDownloadMarker('relative', { hostUrl: 'https://x/', sourcePath: null }, { platform: 'win32' })).toBe(false);
  });
});

describe('untrusted locations', () => {
  const home = '/Users/anna';
  it('mail, messages and temporary folders (macOS)', () => {
    const o = { platform: 'darwin' as const, home, tmpdirs: ['/var/folders/xy/abc/T'] };
    expect(isUntrustedLocation(`${home}/Library/Containers/com.apple.mail/Data/Library/Mail Downloads/1A2B/q4.html`, o)?.kind).toBe('mail');
    expect(isUntrustedLocation(`${home}/Library/Containers/com.microsoft.Outlook/Data/tmp/q4.html`, o)?.kind).toBe('mail');
    expect(isUntrustedLocation(`${home}/Library/Messages/Attachments/ab/01/q4.html`, o)?.kind).toBe('messages');
    expect(isUntrustedLocation('/var/folders/xy/abc/T/q4.html', o)?.kind).toBe('temporary');
    expect(isUntrustedLocation('/private/tmp/q4.html', o)?.kind).toBe('temporary');
    expect(isUntrustedLocation(`${home}/LIBRARY/messages/attachments/q4.html`, o)?.kind).toBe('messages'); // case-insensitive volume
    expect(isUntrustedLocation(`${home}/Decks/q4.html`, o)).toBeNull();
    expect(isUntrustedLocation(`${home}/Library/Messages/Attachments-not/q4.html`, o)).toBeNull();
    expect(isUntrustedLocation('relative/q4.html', o)).toBeNull();
  });
  it('the real temp folder on this machine', () => {
    const f = path.join(fs.realpathSync.native(os.tmpdir()), 'x', 'q4.html');
    expect(isUntrustedLocation(f)?.kind).toBe('temporary');
  });
  it('refused trusted folders (6.10)', () => {
    const o = { platform: 'darwin' as const, home, tmpdirs: ['/var/folders/xy/abc/T'] };
    expect(refuseAsTrustedFolder('/', o)).toBe('a volume root');
    expect(refuseAsTrustedFolder('/Volumes/Backup', o)).toBe('a volume root');
    expect(refuseAsTrustedFolder(home, o)).toBe('the home folder');
    expect(refuseAsTrustedFolder(`${home}/Desktop`, o)).toBe('Desktop');
    expect(refuseAsTrustedFolder(`${home}/downloads`, o)).toBe('Downloads');
    expect(refuseAsTrustedFolder(`${home}/Library/Containers/com.apple.mail/Data/Library/Mail Downloads`, o)).toBe('a mail attachment folder');
    expect(refuseAsTrustedFolder(`${home}/Library/Messages/Attachments`, o)).toBe('a Messages attachment folder');
    expect(refuseAsTrustedFolder('/private/tmp/work', o)).toBe('a temporary folder');
    expect(refuseAsTrustedFolder('/private', o)).toBe('a temporary folder'); // contains /private/tmp
    expect(refuseAsTrustedFolder(`${home}/Decks`, o)).toBeNull();
    expect(refuseAsTrustedFolder(`${home}/Projects/site`, o)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------- the native helper

/** A fake macOS helper over an in-memory attribute table. */
function fakeHelper(attrs: Map<string, string>, o: { failRead?: boolean; failWrite?: boolean } = {}) {
  const calls: (string | QuarantineSpec)[][] = [];
  const h: MarkerHelper = {
    async readQuarantine(p) {
      calls.push(['read', p]);
      if (o.failRead) return { ok: false, error: 'getxattr: Operation not permitted' };
      return { ok: true, value: attrs.get(p) ?? null };
    },
    async copyXattrs(from, to) {
      calls.push(['copy', from, to]);
      if (o.failWrite) throw new Error('copyfile failed');
      const v = attrs.get(from);
      if (v) attrs.set(to, v);
    },
    async setQuarantine(p, q) {
      calls.push(['set', p, q]);
      if (o.failWrite) throw new Error('setxattr failed');
      attrs.set(p, 'value' in q ? q.value : `0081;00000000;${q.properties.agent};`);
    },
  };
  return { h, calls };
}

describe('macOS markers through the native helper (9.9)', () => {
  const Q = '0083;65f1c2a3;Safari;6E1F6E7C-1C1B-4B8E-9D2E-123456789ABC';

  it('readInternetMarker uses the helper when one is given: the whole value, none, or uncertain', async () => {
    const { h, calls } = fakeHelper(new Map([['/Users/a/Downloads/q4.html', Q]]));
    expect(await readInternetMarker('/Users/a/Downloads/q4.html', { platform: 'darwin', helper: h })).toEqual({ marker: Q, reason: REASON_INTERNET });
    expect(await readInternetMarker('/Users/a/mine.html', { platform: 'darwin', helper: h })).toEqual({ marker: null, reason: null });
    expect(calls).toEqual([
      ['read', '/Users/a/Downloads/q4.html'],
      ['read', '/Users/a/mine.html'],
    ]);
    const broken = fakeHelper(new Map(), { failRead: true });
    expect(await readInternetMarker('/a.html', { platform: 'darwin', helper: broken.h })).toEqual({ marker: null, reason: REASON_UNKNOWN, uncertain: true });
    const throwing: MarkerHelper = { ...broken.h, readQuarantine: () => Promise.reject(new Error('helper exited')) };
    expect((await readInternetMarker('/a.html', { platform: 'darwin', helper: throwing })).uncertain).toBe(true);
  });

  it('copyMarkerToTemp: copyfile(COPYFILE_XATTR) through the helper; a failure fails the write', async () => {
    const attrs = new Map([['/d/deck.html', Q]]);
    const { h, calls } = fakeHelper(attrs);
    await copyMarkerToTemp('/d/deck.html', '/d/.bl-write-1.tmp', { platform: 'darwin', helper: h });
    expect(calls).toEqual([['copy', '/d/deck.html', '/d/.bl-write-1.tmp']]);
    expect(attrs.get('/d/.bl-write-1.tmp')).toBe(Q);
    const bad = fakeHelper(attrs, { failWrite: true });
    await expect(copyMarkerToTemp('/d/deck.html', '/d/.bl-write-2.tmp', { platform: 'darwin', helper: bad.h })).rejects.toThrow();
    await expect(copyMarkerToTemp('deck.html', '/d/t', { platform: 'darwin', helper: h })).rejects.toThrow(/absolute/);
    // As the atomic writer's XattrCopier.
    await markerXattrCopier({ platform: 'darwin', helper: h }).copy('/d/deck.html', '/d/.bl-write-3.tmp');
    expect(attrs.get('/d/.bl-write-3.tmp')).toBe(Q);
  });

  it('copyMarker: the same quarantine value on the derived file; none when the source has none', async () => {
    const attrs = new Map([['/d/q4.html', Q]]);
    const { h, calls } = fakeHelper(attrs);
    await copyMarker('/d/q4.html', '/d/q4 for review.html', { platform: 'darwin', helper: h });
    expect(attrs.get('/d/q4 for review.html')).toBe(Q);
    await copyMarker('/d/mine.html', '/d/mine.pdf', { platform: 'darwin', helper: h });
    expect(attrs.has('/d/mine.pdf')).toBe(false);
    expect(calls).toContainEqual(['set', '/d/q4 for review.html', { value: Q }]);
    await expect(copyMarker('/d/q4.html', '/d/x', { platform: 'darwin', helper: fakeHelper(attrs, { failRead: true }).h })).rejects.toThrow(/quarantine/);
  });

  it('markDerivedFile: the document’s marker; a new one naming it when it opened Protected without one', async () => {
    const attrs = new Map<string, string>();
    const { h, calls } = fakeHelper(attrs);
    await markDerivedFile('/d/copy.html', { realpath: '/d/q4.html', marker: Q, protectedView: true }, { platform: 'darwin', helper: h });
    expect(attrs.get('/d/copy.html')).toBe(Q);
    await markDerivedFile('/d/asked.pdf', { realpath: '/d/q 4.html', marker: null, protectedView: true }, { platform: 'darwin', helper: h });
    expect(calls).toContainEqual(['set', '/d/asked.pdf', { properties: { agent: MARKER_AGENT, originUrl: pathToFileURL('/d/q 4.html').href } }]);
    attrs.set('/d/trusted-folder.html', Q);
    await markDerivedFile('/d/tf.pdf', { realpath: '/d/trusted-folder.html', marker: null, protectedView: false }, { platform: 'darwin', helper: h });
    expect(attrs.get('/d/tf.pdf')).toBe(Q);
    await markDerivedFile('/d/plain.pdf', { realpath: '/d/plain.html', marker: null, protectedView: false }, { platform: 'darwin', helper: h });
    expect(attrs.has('/d/plain.pdf')).toBe(false);
    // Linux: no markers at all.
    await markDerivedFile('/d/x.pdf', { realpath: '/d/x.html', marker: 'm', protectedView: true }, { platform: 'linux', helper: h });
    expect(attrs.has('/d/x.pdf')).toBe(false);
  });

  it('writeDownloadMarker: quarantine properties naming the deck and the download', async () => {
    const { h, calls } = fakeHelper(new Map());
    expect(await writeDownloadMarker('/Users/a/Downloads/data.csv', { hostUrl: 'https://cdn.example/data.csv', sourcePath: '/Users/a/Decks/q4.html' }, { platform: 'darwin', helper: h })).toBe(true);
    expect(calls).toEqual([
      ['set', '/Users/a/Downloads/data.csv', { properties: { agent: 'Blueline', originUrl: 'file:///Users/a/Decks/q4.html', dataUrl: 'https://cdn.example/data.csv' } }],
    ]);
  });

  it('writeDownloadMarker records only an http(s) download URL of a sane length', async () => {
    const { h, calls } = fakeHelper(new Map());
    await writeDownloadMarker('/Users/a/Downloads/x.bin', { hostUrl: `data:application/octet-stream;base64,${'A'.repeat(100_000)}`, sourcePath: '/Users/a/Decks/q4.html' }, { platform: 'darwin', helper: h });
    await writeDownloadMarker('/Users/a/Downloads/y.bin', { hostUrl: `https://x.example/${'a'.repeat(9000)}`, sourcePath: null }, { platform: 'darwin', helper: h });
    expect(calls).toEqual([
      ['set', '/Users/a/Downloads/x.bin', { properties: { agent: 'Blueline', originUrl: 'file:///Users/a/Decks/q4.html' } }],
      ['set', '/Users/a/Downloads/y.bin', { properties: { agent: 'Blueline' } }],
    ]);
  });

  it('without a helper: /usr/bin/xattr through the given runner (development)', async () => {
    const m = await readInternetMarker('/a.html', { platform: 'darwin', execFile: async () => ({ code: 0, stdout: `${Q}\n`, stderr: '' }) });
    expect(m).toEqual({ marker: Q, reason: REASON_INTERNET });
  });
});

describe('Windows markers with fs and NTFS stream paths (9.9)', () => {
  const text = '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://mail.example/\r\n';
  const fsFake = (files: Map<string, Uint8Array>) => ({
    readFile: async (p: string) => {
      const b = files.get(p);
      if (!b) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return b;
    },
    writeFile: async (p: string, b: Uint8Array) => void files.set(p, b),
  });

  it('copyMarkerToTemp copies <deck>:Zone.Identifier to <temp>:Zone.Identifier byte for byte', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const files = new Map<string, Uint8Array>([['C:\\d\\deck.html:Zone.Identifier', utf16]]);
    await copyMarkerToTemp('C:\\d\\deck.html', 'C:\\d\\.bl-write-1.tmp', { platform: 'win32', ...fsFake(files) });
    expect(Buffer.from(files.get('C:\\d\\.bl-write-1.tmp:Zone.Identifier')!)).toEqual(utf16);
    // No stream: nothing to copy, and no error.
    await copyMarkerToTemp('C:\\d\\mine.html', 'C:\\d\\.bl-write-2.tmp', { platform: 'win32', ...fsFake(files) });
    expect(files.has('C:\\d\\.bl-write-2.tmp:Zone.Identifier')).toBe(false);
    // An unreadable or oversized stream fails the write.
    const denied = { platform: 'win32' as const, readFile: async () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) };
    await expect(copyMarkerToTemp('C:\\d\\deck.html', 'C:\\d\\t', denied)).rejects.toThrow(/Zone.Identifier/);
    await expect(copyMarkerToTemp('C:\\d\\deck.html', 'C:\\d\\t', { platform: 'win32', readFile: async () => new Uint8Array(65 * 1024 + 1) })).rejects.toThrow();
  });

  it('copyMarker and markDerivedFile write the derived file’s stream', async () => {
    const files = new Map<string, Uint8Array>([['C:\\d\\q4.html:Zone.Identifier', new TextEncoder().encode(text)]]);
    const io = { platform: 'win32' as const, ...fsFake(files) };
    await copyMarker('C:\\d\\q4.html', 'C:\\d\\q4 copy.html', io);
    expect(new TextDecoder().decode(files.get('C:\\d\\q4 copy.html:Zone.Identifier')!)).toBe(text);
    await markDerivedFile('C:\\d\\q4.pdf', { realpath: 'C:\\d\\q4.html', marker: text, protectedView: true }, io);
    const m = await readInternetMarker('C:\\d\\q4.pdf', io);
    expect(m.marker).toBe(text); // the same marker: decoded text equal to the document's
    await markDerivedFile('C:\\d\\asked.pdf', { realpath: 'C:\\d\\asked.html', marker: null, protectedView: true }, io);
    const made = new TextDecoder().decode(files.get('C:\\d\\asked.pdf:Zone.Identifier')!);
    expect(parseZoneId(made)).toBe(3);
    expect(made).toContain('ReferrerUrl=file:///');
  });

  it('zoneStreamPath', () => {
    expect(zoneStreamPath('C:\\d\\deck.html')).toBe('C:\\d\\deck.html:Zone.Identifier');
  });
});

describe('the test-only marker switch (BLUELINE_TEST=1, BLUELINE_TEST_MARKERS)', () => {
  let dir: string;
  const saved = { test: process.env.BLUELINE_TEST, markers: process.env.BLUELINE_TEST_MARKERS };
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-test-markers-'));
  });
  afterEach(() => {
    if (saved.test === undefined) delete process.env.BLUELINE_TEST;
    else process.env.BLUELINE_TEST = saved.test;
    if (saved.markers === undefined) delete process.env.BLUELINE_TEST_MARKERS;
    else process.env.BLUELINE_TEST_MARKERS = saved.markers;
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('injects markers for the named paths only, read on every call, and only with BLUELINE_TEST=1', async () => {
    const file = path.join(dir, 'markers.json');
    fs.writeFileSync(file, JSON.stringify({ '/d/q4.html': 'm-1', '/d/none.html': null, '/d/odd.html': { uncertain: true } }));
    process.env.BLUELINE_TEST_MARKERS = file;
    delete process.env.BLUELINE_TEST;
    expect(await readInternetMarker('/d/q4.html', { platform: 'linux' })).toEqual({ marker: null, reason: null });
    process.env.BLUELINE_TEST = '1';
    expect(await readInternetMarker('/d/q4.html', { platform: 'linux' })).toEqual({ marker: 'm-1', reason: REASON_INTERNET });
    expect(await readInternetMarker('/d/none.html', { platform: 'linux' })).toEqual({ marker: null, reason: null });
    expect((await readInternetMarker('/d/odd.html', { platform: 'linux' })).uncertain).toBe(true);
    expect(await readInternetMarker('/d/other.html', { platform: 'linux' })).toEqual({ marker: null, reason: null });
    fs.writeFileSync(file, JSON.stringify({ '/d/q4.html': 'm-2' }));
    expect((await readInternetMarker('/d/q4.html', { platform: 'linux' })).marker).toBe('m-2');
    fs.writeFileSync(file, 'not json');
    expect(await readInternetMarker('/d/q4.html', { platform: 'linux' })).toEqual({ marker: null, reason: null });
  });
});

describe('more untrusted locations (Linux)', () => {
  it('/dev/shm and XDG_RUNTIME_DIR are temporary', () => {
    const o = { platform: 'linux' as const, home: '/home/a', tmpdirs: [], env: { XDG_RUNTIME_DIR: '/run/user/1000' } };
    expect(isUntrustedLocation('/dev/shm/x.html', o)?.kind).toBe('temporary');
    expect(isUntrustedLocation('/run/user/1000/doc/x.html', o)?.kind).toBe('temporary');
    expect(isUntrustedLocation('/home/a/x.html', o)).toBeNull();
  });
  it('Windows paths compare with win32 rules on any host', () => {
    const o = { platform: 'win32' as const, home: 'C:\\Users\\a', tmpdirs: [], env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } };
    expect(isUntrustedLocation('C:\\Users\\a\\AppData\\Local\\Microsoft\\Windows\\INetCache\\Content.Outlook\\X1\\q4.html', o)?.kind).toBe('mail');
    expect(isUntrustedLocation('c:\\users\\A\\appdata\\local\\temp\\q4.html', o)?.kind).toBe('temporary');
    expect(refuseAsTrustedFolder('C:\\Users\\a\\Projects', o)).toBeNull();
  });
});
