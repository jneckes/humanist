// Trusted and untrusted folders, Settings › Trust and the 6.10 decision (When it applies; What changes; 9.9 the
// strict option and the user-editable allowlist).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore } from '../../../packages/app/src/main/config';
import { REASON_REQUESTED as DOC_REASON_REQUESTED } from '../../../packages/app/src/main/documents';
import {
  REASON_REQUESTED,
  REASON_UNTRUSTED_FOLDER,
  TrustSettings,
  folderFor,
  resolveOpenTrust,
  toTrustDecision,
  trustFor,
  type FolderLists,
} from '../../../packages/app/src/main/folders';
import { REASON_INTERNET, REASON_UNKNOWN, refuseAsTrustedFolder, type InternetMarker } from '../../../packages/app/src/main/markers';
import { DEFAULT_ALLOWLIST } from '../../../packages/app/src/main/network-policy';
import { TrustStore, type RememberedTrust } from '../../../packages/app/src/main/trust-store';

const Q = '0083;65f1c2a3;Safari;6E1F6E7C-1C1B-4B8E-9D2E-123456789ABC';
const Q2 = '0083;65f1c2b9;Safari;0A0B0C0D-1C1B-4B8E-9D2E-123456789ABC';
const at = '2026-10-17T10:00:00.000Z';
const none: InternetMarker = { marker: null, reason: null };
const marked: InternetMarker = { marker: Q, reason: REASON_INTERNET };
const unreadable: InternetMarker = { marker: null, reason: REASON_UNKNOWN, uncertain: true };
const remembered = (marker: string | null, o: Partial<RememberedTrust> = {}): RememberedTrust => ({ marker, allowNetwork: true, editing: true, received: true, at, ...o });

const lists: FolderLists = {
  trusted: ['/Users/j/Decks', '/Users/j/Inbox/mine'],
  untrusted: ['/Users/j/Inbox', '/Users/j/Decks/from-clients'],
};
const IN_TRUSTED = '/Users/j/Decks/q4.html';
const IN_UNTRUSTED = '/Users/j/Inbox/q4.html';
const ELSEWHERE = '/Users/j/Projects/q4.html';
const o = { platform: 'linux' as const };

describe('trustFor: 6.10 When it applies, every case', () => {
  type Row = [string, string, InternetMarker, boolean, RememberedTrust | null, Partial<ReturnType<typeof trustFor>>];
  const rows: Row[] = [
    // file, marker, --protected, remembered → expected
    ['no marker, nowhere special → Trusted', ELSEWHERE, none, false, null, { state: 'trusted', reason: null, rule: 'none', editing: true, allowNetwork: false, received: false }],
    ['a marker → Protected, came from the internet', ELSEWHERE, marked, false, null, { state: 'protected', reason: REASON_INTERNET, rule: 'marker', allowNetwork: false, editing: false, received: true }],
    ['an unreadable marker → Protected (when unsure, refuse)', ELSEWHERE, unreadable, false, null, { state: 'protected', reason: REASON_UNKNOWN, rule: 'marker' }],
    ['requested Protected, no marker → Protected', ELSEWHERE, none, true, null, { state: 'protected', reason: REASON_REQUESTED, rule: 'requested' }],
    ['requested Protected wins over a trusted folder', IN_TRUSTED, none, true, null, { state: 'protected', reason: REASON_REQUESTED, rule: 'requested' }],
    ['requested Protected wins over a trusted folder with a marker', IN_TRUSTED, marked, true, null, { state: 'protected', rule: 'requested' }],
    ['requested Protected ignores remembered switches', ELSEWHERE, marked, true, remembered(Q), { state: 'protected', allowNetwork: false, editing: false, rule: 'requested' }],
    ['a trusted folder makes a marked file Trusted', IN_TRUSTED, marked, false, null, { state: 'trusted', reason: null, rule: 'trusted-folder', folder: '/Users/j/Decks' }],
    ['a trusted folder makes a file with an unreadable marker Trusted', IN_TRUSTED, unreadable, false, null, { state: 'trusted', rule: 'trusted-folder' }],
    ['a trusted folder, no marker → Trusted', IN_TRUSTED, none, false, null, { state: 'trusted', rule: 'trusted-folder' }],
    ['an untrusted folder makes an unmarked file Protected', IN_UNTRUSTED, none, false, null, { state: 'protected', reason: REASON_UNTRUSTED_FOLDER, rule: 'untrusted-folder', folder: '/Users/j/Inbox' }],
    ['an untrusted folder with a marker → Protected, the marker is the reason', IN_UNTRUSTED, marked, false, null, { state: 'protected', reason: REASON_INTERNET, rule: 'untrusted-folder' }],
    ['an untrusted folder with an unreadable marker → Protected', IN_UNTRUSTED, unreadable, false, null, { state: 'protected', reason: REASON_UNTRUSTED_FOLDER, rule: 'untrusted-folder' }],
    ['remembered Allow network and Enable editing apply on the same marker', ELSEWHERE, marked, false, remembered(Q), { state: 'protected', allowNetwork: true, editing: true }],
    ['remembered Allow network alone', ELSEWHERE, marked, false, remembered(Q, { editing: false }), { state: 'protected', allowNetwork: true, editing: false }],
    ['remembered Enable editing alone (network keeps its policy)', ELSEWHERE, marked, false, remembered(Q, { allowNetwork: false }), { state: 'protected', allowNetwork: false, editing: true }],
    ['a remembered decision on another marker does not apply', ELSEWHERE, marked, false, remembered(Q2), { state: 'protected', allowNetwork: false, editing: false, received: true }],
    ['a remembered decision does not apply when the marker cannot be read', ELSEWHERE, unreadable, false, remembered(null), { state: 'protected', allowNetwork: false, editing: false }],
    ['remembered switches apply in an untrusted folder (marker null = null)', IN_UNTRUSTED, none, false, remembered(null), { state: 'protected', allowNetwork: true, editing: true }],
    ['remembered "yours" (received false) is kept', ELSEWHERE, marked, false, remembered(Q, { received: false }), { state: 'protected', received: false }],
    ['a remembered received file stays received when Trusted (trusted folder)', IN_TRUSTED, marked, false, remembered(Q, { received: true }), { state: 'trusted', received: true }],
    ['nested: an untrusted folder inside a trusted one wins (deepest)', '/Users/j/Decks/from-clients/acme.html', none, false, null, { state: 'protected', rule: 'untrusted-folder', folder: '/Users/j/Decks/from-clients' }],
    ['nested: a trusted folder inside an untrusted one wins (deepest)', '/Users/j/Inbox/mine/q4.html', marked, false, null, { state: 'trusted', rule: 'trusted-folder', folder: '/Users/j/Inbox/mine' }],
    ['a sibling with a shared prefix is not inside (no string-prefix test)', '/Users/j/Decks-old/q4.html', none, false, null, { state: 'trusted', rule: 'none' }],
    ['the folder itself is not a file inside, but counts as within', '/Users/j/Inbox', none, false, null, { state: 'protected', rule: 'untrusted-folder' }],
  ];
  it.each(rows)('%s', (_name, file, marker, requested, mem, expected) => {
    expect(trustFor(file, marker, requested, mem, lists, o)).toMatchObject(expected);
  });

  it('the marker is reported as read (null when it could not be read, and then flagged)', () => {
    expect(trustFor(ELSEWHERE, marked, false, null, lists, o)).toMatchObject({ marker: Q, markerUncertain: false });
    expect(trustFor(ELSEWHERE, unreadable, false, null, lists, o)).toMatchObject({ marker: null, markerUncertain: true });
    expect(trustFor(IN_TRUSTED, marked, false, null, lists, o)).toMatchObject({ marker: Q, markerUncertain: false });
    expect(trustFor(IN_TRUSTED, unreadable, false, null, lists, o)).toMatchObject({ state: 'trusted', markerUncertain: true });
  });

  it('the same folder in both lists: untrusted wins', () => {
    expect(folderFor('/x/a.html', { trusted: ['/x'], untrusted: ['/x'] }, 'linux')).toEqual({ kind: 'untrusted', folder: '/x' });
  });

  it('a trusted folder matches only exactly; an untrusted one also case-insensitively on macOS and Windows', () => {
    // Realpaths carry the on-disk case; on a case-sensitive volume `decks` is another folder than a trusted `Decks`.
    expect(folderFor('/Users/j/Decks/q4.html', { trusted: ['/Users/j/Decks'], untrusted: [] }, 'darwin')?.kind).toBe('trusted');
    expect(folderFor('/users/J/decks/q4.html', { trusted: ['/Users/j/Decks'], untrusted: [] }, 'darwin')).toBeNull();
    expect(folderFor('c:\\users\\j\\decks\\q4.html', { trusted: ['C:\\Users\\j\\Decks'], untrusted: [] }, 'win32')).toBeNull();
    expect(folderFor('C:\\Users\\j\\Decks\\q4.html', { trusted: ['C:\\Users\\j\\Decks'], untrusted: [] }, 'win32')?.kind).toBe('trusted');
    // A wrong match of an untrusted folder only makes a file Protected.
    expect(folderFor('/users/J/inbox/q4.html', { trusted: [], untrusted: ['/Users/j/Inbox'] }, 'darwin')?.kind).toBe('untrusted');
    expect(folderFor('c:\\users\\j\\inbox\\q4.html', { trusted: [], untrusted: ['C:\\Users\\j\\Inbox'] }, 'win32')?.kind).toBe('untrusted');
    expect(folderFor('/users/J/inbox/q4.html', { trusted: [], untrusted: ['/Users/j/Inbox'] }, 'linux')).toBeNull();
    expect(folderFor('C:\\Users\\j\\Decks2\\q4.html', { trusted: ['C:\\Users\\j\\Decks'], untrusted: [] }, 'win32')).toBeNull();
    // Mixed case on a case-insensitive volume, nested: the untrusted folder inside still wins.
    expect(trustFor('/Users/j/Decks/FROM-CLIENTS/a.html', none, false, null, lists, { platform: 'darwin' })).toMatchObject({ state: 'protected', rule: 'untrusted-folder' });
  });

  it('receivedRemembered says whether received came from trust.json (6.8: then the location rule does not apply)', () => {
    expect(trustFor(ELSEWHERE, marked, false, remembered(Q, { received: false }), lists, o)).toMatchObject({ received: false, receivedRemembered: true });
    expect(trustFor(ELSEWHERE, marked, false, null, lists, o)).toMatchObject({ received: true, receivedRemembered: false });
    expect(trustFor(ELSEWHERE, none, false, null, lists, o)).toMatchObject({ received: false, receivedRemembered: false });
    expect(trustFor(ELSEWHERE, none, false, remembered(null, { received: true }), lists, o)).toMatchObject({ received: true, receivedRemembered: true });
  });

  it('the reasons match documents.ts, and toTrustDecision keeps state, reason and marker', () => {
    expect(REASON_REQUESTED).toBe(DOC_REASON_REQUESTED);
    expect(toTrustDecision(trustFor(ELSEWHERE, marked, false, null, lists, o))).toEqual({ trust: 'protected', reason: REASON_INTERNET, marker: Q });
  });
});

describe('resolveOpenTrust: the marker, trust.json and trustFor together', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-resolve-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a remembered decision does not survive a marker change (6.10: a new download opens Protected again)', async () => {
    const store = new TrustStore(path.join(dir, 'trust-a.json')).load();
    let current: InternetMarker = marked;
    const deps = { store, lists: () => ({ trusted: [], untrusted: [] }), readMarker: async () => current, platform: 'linux' as const };
    const first = await resolveOpenTrust('/d/q4.html', false, deps);
    expect(first).toMatchObject({ state: 'protected', allowNetwork: false, editing: false, received: true });
    // The first Protected open is remembered as received (6.8).
    expect(store.get('/d/q4.html', Q)).toMatchObject({ received: true, allowNetwork: false });
    // The user presses Allow network and Enable editing.
    await store.remember('/d/q4.html', Q, { allowNetwork: true });
    await store.remember('/d/q4.html', Q, { editing: true });
    expect(await resolveOpenTrust('/d/q4.html', false, deps)).toMatchObject({ state: 'protected', allowNetwork: true, editing: true });
    // A new download is saved over the same path: new marker.
    current = { marker: Q2, reason: REASON_INTERNET };
    expect(await resolveOpenTrust('/d/q4.html', false, deps)).toMatchObject({ state: 'protected', allowNetwork: false, editing: false });
    await store.idle();
    const onDisk = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    expect(onDisk.files['/d/q4.html'].marker).toBe(Q2);
    expect(onDisk.files['/d/q4.html'].allowNetwork).toBe(false);
  });

  it('an unreadable marker neither applies nor drops a decision', async () => {
    const store = new TrustStore(path.join(dir, 'trust-b.json')).load();
    await store.set('/d/q4.html', { marker: Q, allowNetwork: true, editing: true, received: true, at });
    const r = await resolveOpenTrust('/d/q4.html', false, { store, lists: () => ({ trusted: [], untrusted: [] }), readMarker: async () => unreadable, platform: 'linux' });
    expect(r).toMatchObject({ state: 'protected', allowNetwork: false, editing: false });
    expect(store.get('/d/q4.html', Q)?.allowNetwork).toBe(true);
  });

  it('a marker reader that throws counts as unreadable', async () => {
    const store = new TrustStore(path.join(dir, 'trust-c.json')).load();
    const r = await resolveOpenTrust('/d/x.html', false, { store, lists: () => ({ trusted: [], untrusted: [] }), readMarker: async () => Promise.reject(new Error('boom')), platform: 'linux' });
    expect(r).toMatchObject({ state: 'protected', reason: REASON_UNKNOWN });
  });

  it('a Trusted open writes nothing to trust.json', async () => {
    const store = new TrustStore(path.join(dir, 'trust-d.json')).load();
    await resolveOpenTrust('/d/mine.html', false, { store, lists: () => ({ trusted: [], untrusted: [] }), readMarker: async () => none, platform: 'linux' });
    await store.idle();
    expect(fs.existsSync(store.file)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- refused folders

describe('refused trusted folders (6.10), per platform', () => {
  const mac = { platform: 'darwin' as const, home: '/Users/anna', tmpdirs: ['/var/folders/xy/abc/T'] };
  it.each([
    ['/', 'a volume root'],
    ['/Volumes', 'a volume root'],
    ['/Volumes/Backup', 'a volume root'],
    ['/System/Volumes/Data', 'a volume root'],
    ['/Users/anna', 'the home folder'],
    ['/users/ANNA', 'the home folder'],
    ['/Users', 'a folder that contains your home folder'],
    ['/Users/anna/Desktop', 'Desktop'],
    ['/Users/anna/Downloads', 'Downloads'],
    ['/Users/anna/Library/Containers/com.apple.mail/Data/Library/Mail Downloads', 'a mail attachment folder'],
    ['/Users/anna/Library/Mail', 'a mail attachment folder'],
    ['/Users/anna/Library/Containers/com.microsoft.Outlook/Data', 'a mail attachment folder'],
    ['/Users/anna/Library/Messages/Attachments', 'a Messages attachment folder'],
    ['/Users/anna/Library', 'a mail attachment folder'],
    ['/tmp', 'a temporary folder'],
    ['/private/tmp/work', 'a temporary folder'],
    ['/var/folders/xy/abc/T/zip', 'a temporary folder'],
    ['/private', 'a temporary folder'],
  ])('macOS %s → %s', (folder, why) => {
    expect(refuseAsTrustedFolder(folder, mac)).toBe(why);
  });
  it.each(['/Users/anna/Decks', '/Users/anna/Desktop/project', '/Users/anna/Downloads/unzipped-deck', '/Volumes/Backup/Decks', '/Users/anna/Library-notes'])('macOS %s may be trusted', (folder) => {
    expect(refuseAsTrustedFolder(folder, mac)).toBeNull();
  });

  const win = {
    platform: 'win32' as const,
    home: 'C:\\Users\\anna',
    tmpdirs: ['C:\\Users\\anna\\AppData\\Local\\Temp'],
    env: { LOCALAPPDATA: 'C:\\Users\\anna\\AppData\\Local', TEMP: 'C:\\Users\\anna\\AppData\\Local\\Temp', SystemRoot: 'C:\\Windows' },
    desktop: 'C:\\Users\\anna\\OneDrive\\Desktop',
    downloads: 'D:\\Downloads',
  };
  it.each([
    ['C:\\', 'a volume root'],
    ['D:\\', 'a volume root'],
    ['\\\\server\\share', 'a volume root'],
    ['\\\\server\\share\\', 'a volume root'],
    ['\\\\?\\C:\\Decks', 'a volume root'],
    ['C:\\Users\\anna', 'the home folder'],
    ['c:\\users\\ANNA', 'the home folder'],
    ['C:\\Users', 'a folder that contains your home folder'],
    ['C:\\Users\\anna\\Desktop', 'Desktop'],
    ['C:\\Users\\anna\\OneDrive\\Desktop', 'Desktop'],
    ['C:\\Users\\anna\\OneDrive', 'a folder that contains Desktop'],
    ['C:\\Users\\anna\\Downloads', 'Downloads'],
    ['D:\\Downloads', 'Downloads'],
    ['C:\\Users\\anna\\AppData\\Local\\Microsoft\\Windows\\INetCache\\Content.Outlook', 'a mail attachment folder'],
    ['C:\\Users\\anna\\AppData\\Local\\Microsoft\\Olk\\Attachments', 'a mail attachment folder'],
    ['C:\\Users\\anna\\AppData\\Local\\Temp', 'a temporary folder'],
    ['C:\\Users\\anna\\AppData\\Local\\Temp\\7z', 'a temporary folder'],
    ['C:\\Windows\\Temp', 'a temporary folder'],
    ['C:\\Users\\anna\\AppData', 'a temporary folder'],
  ])('Windows %s → %s', (folder, why) => {
    expect(refuseAsTrustedFolder(folder, win)).toBe(why);
  });
  it.each(['C:\\Users\\anna\\Documents\\Decks', 'D:\\Work\\Decks', '\\\\server\\share\\Decks'])('Windows %s may be trusted', (folder) => {
    expect(refuseAsTrustedFolder(folder, win)).toBeNull();
  });

  const linux = { platform: 'linux' as const, home: '/home/anna', tmpdirs: ['/tmp'], env: { XDG_RUNTIME_DIR: '/run/user/1000' } };
  it.each([
    ['/', 'a volume root'],
    ['/mnt', 'a volume root'],
    ['/mnt/usb', 'a volume root'],
    ['/media/anna', 'a volume root'],
    ['/media/anna/USB STICK', 'a volume root'],
    ['/run/media/anna/USB', 'a volume root'],
    ['/home/anna', 'the home folder'],
    ['/home', 'a folder that contains your home folder'],
    ['/home/anna/Desktop', 'Desktop'],
    ['/home/anna/Downloads', 'Downloads'],
    ['/tmp', 'a temporary folder'],
    ['/tmp/x', 'a temporary folder'],
    ['/var/tmp/x', 'a temporary folder'],
    ['/dev/shm', 'a temporary folder'],
    ['/run/user/1000/doc', 'a temporary folder'],
  ])('Linux %s → %s', (folder, why) => {
    expect(refuseAsTrustedFolder(folder, linux)).toBe(why);
  });
  it.each(['/home/anna/decks', '/mnt/usb/decks', '/srv/decks', '/home/Anna'])('Linux %s may be trusted (case-sensitive)', (folder) => {
    expect(refuseAsTrustedFolder(folder, linux)).toBeNull();
  });

  it('a relative path or one with NUL is refused', () => {
    expect(refuseAsTrustedFolder('decks', linux)).toBe('not an absolute path');
    expect(refuseAsTrustedFolder('/home/anna/de\0cks', linux)).toBe('not an absolute path');
  });
});

// ------------------------------------------------------------------------------------------- TrustSettings

describe('TrustSettings (Settings › Trust over config.json)', () => {
  let root: string;
  let userData: string;
  let home: string;
  let decks: string;
  let link: string;
  beforeAll(() => {
    // Not under /tmp: every temporary folder is refused as a trusted folder, so the test folders live in the
    // repo's (gitignored) test-results.
    const base = path.resolve(__dirname, '../../../test-results');
    fs.mkdirSync(base, { recursive: true });
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'unit-folders-')));
    userData = path.join(root, 'userData');
    home = path.join(root, 'home');
    decks = path.join(home, 'Decks');
    fs.mkdirSync(path.join(decks, 'nested'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(home, 'file.txt'), 'x');
    link = path.join(root, 'decks-link');
    fs.symlinkSync(decks, link);
    fs.symlinkSync(path.join(home, 'Downloads'), path.join(root, 'downloads-link'));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const make = () => {
    const config = ConfigStore.forUserData(userData);
    config.load();
    const s = new TrustSettings(config, { platform: 'linux', home, tmpdirs: ['/nonexistent-tmp'], env: {} });
    return { config, s };
  };
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));

  it('adds a trusted folder as its realpath (a symlink is resolved), persists it, and notifies', async () => {
    const { s } = make();
    const changes: string[] = [];
    s.onChange((c) => changes.push(c));
    const r = await s.addFolder('trusted', link);
    expect(r).toEqual({ ok: true, folder: decks });
    expect(s.trustedFolders()).toEqual([decks]);
    expect(onDisk().trustedFolders).toEqual([decks]);
    expect(changes).toEqual(['folders']);
    // Adding it again (by either name) changes nothing.
    expect(await s.addFolder('trusted', decks)).toEqual({ ok: true, folder: decks });
    expect(s.trustedFolders()).toEqual([decks]);
  });

  it('refuses the home folder and a symlink to Downloads, with the reason', async () => {
    const { s } = make();
    expect(await s.addFolder('trusted', home)).toMatchObject({ ok: false, reason: 'The home folder cannot be a trusted folder.' });
    expect(await s.addFolder('trusted', path.join(root, 'downloads-link'))).toMatchObject({ ok: false, reason: 'Downloads cannot be a trusted folder.' });
    expect(await s.addFolder('trusted', path.dirname(home))).toMatchObject({ ok: false, reason: 'A folder that contains your home folder cannot be a trusted folder.' });
  });

  it('refuses a folder whose path has control characters (config.json could not keep it)', async () => {
    const odd = path.join(home, 'odd\nname');
    fs.mkdirSync(odd, { recursive: true });
    const { s } = make();
    expect(await s.addFolder('untrusted', odd)).toEqual({ ok: false, reason: 'That folder’s path has control characters Blueline cannot store.' });
    fs.rmSync(odd, { recursive: true, force: true });
  });

  it('refuses what is not a folder', async () => {
    const { s } = make();
    expect(await s.addFolder('trusted', path.join(home, 'file.txt'))).toEqual({ ok: false, reason: 'That is not a folder.' });
    expect(await s.addFolder('trusted', path.join(home, 'missing'))).toEqual({ ok: false, reason: 'That folder could not be found.' });
    expect(await s.addFolder('trusted', 'relative/dir')).toEqual({ ok: false, reason: 'That is not a folder path.' });
    expect(await s.addFolder('untrusted', '/x\0y')).toEqual({ ok: false, reason: 'That is not a folder path.' });
  });

  it('an untrusted folder may be anything that exists (the home folder too); a folder is in one list only', async () => {
    const { s } = make();
    expect(await s.addFolder('untrusted', home)).toEqual({ ok: true, folder: home });
    expect(await s.addFolder('untrusted', decks)).toEqual({ ok: true, folder: decks });
    expect(s.trustedFolders()).not.toContain(decks); // moved out of the trusted list
    expect(s.untrustedFolders()).toEqual([home, decks]);
    expect(await s.addFolder('trusted', decks)).toEqual({ ok: true, folder: decks });
    expect(s.untrustedFolders()).toEqual([home]);
    expect(s.trustedFolders()).toEqual([decks]);
    expect(s.lists()).toEqual({ trusted: [decks], untrusted: [home] });
    // The nested decision through the lists: Decks is trusted inside the untrusted home folder.
    expect(trustFor(path.join(decks, 'a.html'), marked, false, null, s.lists(), o).state).toBe('trusted');
    expect(trustFor(path.join(home, 'a.html'), none, false, null, s.lists(), o).state).toBe('protected');
  });

  it('removes only an exact entry', async () => {
    const { s } = make();
    expect(await s.removeFolder('trusted', `${decks}/`)).toBe(false);
    expect(await s.removeFolder('untrusted', decks)).toBe(false);
    expect(await s.removeFolder('trusted', decks)).toBe(true);
    expect(s.trustedFolders()).toEqual([]);
    expect(await s.removeFolder('untrusted', home)).toBe(true);
    expect(onDisk().untrustedFolders).toEqual([]);
  });

  it('a refused folder in a hand-edited config.json never makes files Trusted', async () => {
    const f = path.join(userData, 'config.json');
    const raw = onDisk();
    raw.trustedFolders = ['/', home, decks];
    fs.writeFileSync(f, JSON.stringify(raw));
    const { s } = make();
    expect(s.trustedFolders()).toEqual(['/', home, decks]);
    expect(s.lists().trusted).toEqual([decks]);
    expect(trustFor('/etc/x.html', marked, false, null, s.lists(), o).state).toBe('protected');
    raw.trustedFolders = [];
    fs.writeFileSync(f, JSON.stringify(raw));
  });

  it('strict: "Block all network in Protected view"', async () => {
    const { s } = make();
    const changes: string[] = [];
    s.onChange((c) => changes.push(c));
    expect(s.strict()).toBe(false);
    await s.setStrict(true);
    expect(s.strict()).toBe(true);
    expect(onDisk().strictProtected).toBe(true);
    await s.setStrict(true);
    await s.setStrict(false);
    expect(onDisk().strictProtected).toBe(false);
    expect(changes).toEqual(['strict', 'strict']);
  });

  it('the CDN allowlist: the 9.9 list by default, user-editable, normalized, reset', async () => {
    const { s } = make();
    expect(s.allowlist()).toEqual(DEFAULT_ALLOWLIST);
    expect(s.allowlistIsDefault()).toBe(true);
    expect(await s.addAllowlistHost('  Fonts.Example.COM ')).toEqual({ ok: true, host: 'fonts.example.com' });
    expect(s.allowlist()).toEqual([...DEFAULT_ALLOWLIST, 'fonts.example.com']);
    expect(onDisk().cdnAllowlist).toEqual([...DEFAULT_ALLOWLIST, 'fonts.example.com']);
    for (const bad of ['https://evil.example/', 'evil.example:8080', '*.example.com', '127.0.0.1', 'localhost', 'a.localhost', '10.0.0.1', 'bad host', 'x'.repeat(300), '', 'evil.example,<-loopback>']) {
      const r = await s.addAllowlistHost(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.reason).toMatch(/host name/);
    }
    expect(await s.removeAllowlistHost('unpkg.com')).toBe(true);
    expect(s.allowlist()).not.toContain('unpkg.com');
    expect(await s.removeAllowlistHost('not-there.example')).toBe(false);
    expect(s.allowlistIsDefault()).toBe(false);
    await s.resetAllowlist();
    expect(s.allowlistIsDefault()).toBe(true);
    expect(s.allowlist()).toEqual(DEFAULT_ALLOWLIST);
    await new Promise((r) => setTimeout(r, 20));
    expect(onDisk().cdnAllowlist).toBeUndefined();
    // A reread keeps the default (the reset removed the key from the file).
    expect(make().s.allowlistIsDefault()).toBe(true);
  });

  it('an emptied allowlist stays empty (Protected view then loads nothing)', async () => {
    const { s } = make();
    for (const h of DEFAULT_ALLOWLIST) await s.removeAllowlistHost(h);
    expect(s.allowlist()).toEqual([]);
    expect(make().s.allowlist()).toEqual([]);
    await s.resetAllowlist();
  });
});
