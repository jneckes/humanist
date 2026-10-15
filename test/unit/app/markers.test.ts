// Internet markers (6.10, D12) and untrusted locations (6.8 Received, 6.10 Settings › Trust).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  REASON_INTERNET,
  decodeZoneIdentifier,
  isUntrustedLocation,
  parseQuarantine,
  parseZoneId,
  readInternetMarker,
  refuseAsTrustedFolder,
  writeDownloadMarker,
} from '../../../packages/app/src/main/markers';

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
  it('is a no-op elsewhere until the Phase 1 helper', async () => {
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
