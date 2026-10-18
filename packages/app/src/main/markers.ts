// Internet markers (6.10 When it applies, D12, 9.9 Writes) and untrusted locations (6.8 Received, 6.10 refused
// trusted folders).
//
// A file opens Protected when it carries an internet marker: macOS quarantine properties
// (`com.apple.quarantine`, read by the native helper) or a Windows `Zone.Identifier` stream with ZoneId 3 or
// more. The marker's whole value is what trust.json remembers a decision against (6.10), so
// readInternetMarker returns it verbatim.
//
// Blueline's own writes keep the marker (9.9 Write protocol addition: copyMarkerToTemp, called by the atomic
// writer before its rename), and files it derives from a document carry that document's marker (9.9 Derived
// files keep the marker: copyMarker, markDerivedFile). A file a deck downloads gets a marker naming the deck
// (writeDownloadMarker). macOS goes through the native helper (native-helper.ts: getxattr, copyfile
// COPYFILE_XATTR, setxattr or the Launch Services quarantine properties; /usr/bin/xattr in development);
// Windows reads and writes `<path>:Zone.Identifier` with fs, through NTFS stream paths; Linux has no marker.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { XattrCopier } from './atomic-write';
import { MAX_MARKER_BYTES, nativeHelper, xattrReadQuarantine, type NativeHelper, type QuarantineRead } from './native-helper';

export interface InternetMarker {
  /** The marker's whole value (macOS quarantine string, Windows Zone.Identifier text), or null. */
  marker: string | null;
  /** The trust bar's reason (6.10), for example "Came from the internet"; null when there is no marker. */
  reason: string | null;
  /**
   * The marker could not be read (the helper failed, the stream exists but cannot be parsed). Callers
   * should open the file Protected: when unsure, refuse.
   */
  uncertain?: boolean;
}

export const REASON_INTERNET = 'Came from the internet';
export const REASON_UNKNOWN = 'Could not check where this file came from';
/** The agent name of the quarantine markers Blueline writes (downloads, derived files of a Protected document). */
export const MARKER_AGENT = 'Blueline';
/** The longest URL a marker Blueline writes records (a download's address, the deck's file URL). */
const MAX_URL = 8 * 1024;

/** The helper operations markers.ts uses (the app's native helper by default; tests pass a fake). */
export type MarkerHelper = Pick<NativeHelper, 'readQuarantine' | 'copyXattrs' | 'setQuarantine'>;

export interface MarkerOptions {
  platform?: NodeJS.Platform;
  /** macOS: the native helper (default: the app's, nativeHelper()). */
  helper?: MarkerHelper;
  /**
   * macOS: read with /usr/bin/xattr through this runner instead of the helper (child_process.execFile, no
   * shell). Tests inject a fake.
   */
  execFile?: (file: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Reads a whole file (default fs.promises.readFile). Tests inject a fake. */
  readFile?: (p: string) => Promise<Uint8Array>;
  /** Writes a whole file (default fs.promises.writeFile). Tests inject a fake. */
  writeFile?: (p: string, bytes: Uint8Array) => Promise<void>;
}

/** The path flavour of the platform being checked (tests run win32 rules on Linux). */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function helperFor(opts: MarkerOptions): MarkerHelper {
  if (opts.helper) return opts.helper;
  if (opts.execFile) {
    const run = opts.execFile;
    return {
      readQuarantine: (p) => xattrReadQuarantine(run, p),
      copyXattrs: () => Promise.reject(new Error('no helper')),
      setQuarantine: () => Promise.reject(new Error('no helper')),
    };
  }
  return nativeHelper();
}

function readerOf(opts: MarkerOptions): (p: string) => Promise<Uint8Array> {
  return opts.readFile ?? ((p) => fs.promises.readFile(p));
}

function writerOf(opts: MarkerOptions): (p: string, b: Uint8Array) => Promise<void> {
  return opts.writeFile ?? ((p, b) => fs.promises.writeFile(p, b));
}

/** `<path>:Zone.Identifier`, the NTFS alternate data stream that carries a Windows internet marker. */
export function zoneStreamPath(p: string): string {
  return `${p}:Zone.Identifier`;
}

/**
 * Reads the internet marker of a file (6.10). `realpath` must be absolute.
 * - macOS: `com.apple.quarantine`, read by the native helper (getxattr; /usr/bin/xattr when the helper is
 *   not built). Any quarantine value is a marker.
 * - Windows: the `<path>:Zone.Identifier` stream, a marker when its ZoneId is 3 (Internet) or more.
 * - Linux and others: no marker.
 */
export async function readInternetMarker(realpath: string, opts: MarkerOptions = {}): Promise<InternetMarker> {
  const platform = opts.platform ?? process.platform;
  if (typeof realpath !== 'string' || !pathFor(platform).isAbsolute(realpath)) return { marker: null, reason: REASON_UNKNOWN, uncertain: true };
  const injected = testMarker(realpath);
  if (injected) return injected;
  if (platform === 'darwin') return quarantineMarker(await safeRead(helperFor(opts), realpath));
  if (platform === 'win32') return readZoneIdentifier(realpath, readerOf(opts));
  return { marker: null, reason: null };
}

/**
 * Test-only: markers injected from a JSON file, `{ "<realpath>": "<marker>" | null | { "uncertain": true } }`,
 * named by BLUELINE_TEST_MARKERS. Linux has no internet markers and a test cannot write a quarantine attribute
 * or an NTFS stream there, so the E2E and security suites use this to open files "from the internet" and to
 * change a file's marker between opens (6.10: a remembered decision does not survive a new marker). Honoured
 * only when BLUELINE_TEST=1 and main does not run from app.asar (a packaged app never reads it), and only for
 * the paths the file names. Read on every call, so a test can change it between opens.
 */
function testMarker(realpath: string): InternetMarker | null {
  const env = process.env;
  if (env.BLUELINE_TEST !== '1' || !env.BLUELINE_TEST_MARKERS) return null;
  if (/[\\/]app\.asar[\\/]/.test(__filename)) return null;
  let map: unknown;
  try {
    const raw = fs.readFileSync(env.BLUELINE_TEST_MARKERS, 'utf8');
    if (raw.length > 4 * 1024 * 1024) return null;
    map = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.prototype.hasOwnProperty.call(map, realpath)) return null;
  const v = (map as Record<string, unknown>)[realpath];
  if (v === null) return { marker: null, reason: null };
  if (typeof v === 'string' && v.length > 0 && Buffer.byteLength(v, 'utf8') <= MAX_MARKER_BYTES) return { marker: v, reason: REASON_INTERNET };
  return { marker: null, reason: REASON_UNKNOWN, uncertain: true };
}

async function safeRead(h: MarkerHelper, p: string): Promise<QuarantineRead> {
  try {
    return await h.readQuarantine(p);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function quarantineMarker(r: QuarantineRead): InternetMarker {
  if (!r.ok) return { marker: null, reason: REASON_UNKNOWN, uncertain: true };
  if (r.value === null) return { marker: null, reason: null };
  if (r.value.length === 0) return { marker: null, reason: REASON_UNKNOWN, uncertain: true };
  return { marker: r.value, reason: REASON_INTERNET };
}

/** Fields of a quarantine value: `flags;hex-timestamp;agent;uuid` (fields after the agent are optional). */
export function parseQuarantine(value: string): { flags: number; time: Date | null; agent: string; eventId: string } | null {
  const parts = value.split(';');
  if (parts.length < 3 || !/^[0-9a-fA-F]{1,8}$/.test(parts[0])) return null;
  const secs = /^[0-9a-fA-F]{1,16}$/.test(parts[1]) ? parseInt(parts[1], 16) : NaN;
  return {
    flags: parseInt(parts[0], 16),
    time: Number.isFinite(secs) ? new Date(secs * 1000) : null,
    agent: parts[2],
    eventId: parts[3] ?? '',
  };
}

/** Decodes Zone.Identifier bytes: UTF-16LE with a BOM (some writers), UTF-8 with or without a BOM. */
export function decodeZoneIdentifier(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * The ZoneId of a Zone.Identifier stream's text (an INI file with a `[ZoneTransfer]` section). Keys and
 * section names compare case-insensitively. Returns null when no ZoneId can be read.
 */
export function parseZoneId(text: string): number | null {
  let section: string | null = null;
  let sawSection = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith(';')) continue;
    const sec = /^\[(.*)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      sawSection = true;
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (!kv || kv[1].trim().toLowerCase() !== 'zoneid') continue;
    if (sawSection && section !== 'zonetransfer') continue;
    const v = kv[2].trim();
    if (!/^[0-9]{1,9}$/.test(v)) return null;
    return Number(v);
  }
  return null;
}

function noStream(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  // No stream, or a volume without streams (FAT, exFAT, a network share that drops them).
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EINVAL';
}

async function readZoneIdentifier(realpath: string, read: (p: string) => Promise<Uint8Array>): Promise<InternetMarker> {
  let bytes: Uint8Array;
  try {
    bytes = await read(zoneStreamPath(realpath));
  } catch (err) {
    if (noStream(err)) return { marker: null, reason: null };
    return { marker: null, reason: REASON_UNKNOWN, uncertain: true };
  }
  if (bytes.byteLength > MAX_MARKER_BYTES) return { marker: null, reason: REASON_UNKNOWN, uncertain: true };
  const text = decodeZoneIdentifier(bytes);
  const zone = parseZoneId(text);
  if (zone === null) return { marker: null, reason: REASON_UNKNOWN, uncertain: true };
  // 6.10: ZoneId 3 (Internet) or more (4, Restricted sites). 0–2 are this computer, intranet and trusted sites.
  if (zone >= 3) return { marker: text, reason: REASON_INTERNET };
  return { marker: null, reason: null };
}

/**
 * Copies the `Zone.Identifier` stream of `from` onto `to`, byte for byte (Windows). No stream: nothing to
 * copy. A stream that cannot be read, or is too large to be a marker, fails: a write that silently dropped
 * the marker would reset trust (6.10, 9.9).
 */
async function copyZoneIdentifier(from: string, to: string, opts: MarkerOptions): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = await readerOf(opts)(zoneStreamPath(from));
  } catch (err) {
    if (noStream(err)) return;
    throw new Error('Could not read the file’s Zone.Identifier');
  }
  if (bytes.byteLength > MAX_MARKER_BYTES) throw new Error('Could not read the file’s Zone.Identifier');
  await writerOf(opts)(zoneStreamPath(to), bytes);
}

// ---------------------------------------------------------------------------------------------------
// Keeping the marker (9.9 Write protocol addition, Derived files keep the marker)
// ---------------------------------------------------------------------------------------------------

/**
 * 9.9 Write protocol addition: the atomic writer calls this with the original and its temp file, after the
 * bytes are in the temp file and before the rename, so a write never drops the marker (a received file keeps
 * its marker after Blueline saves notes into it, and 6.10 trust stays remembered).
 * - macOS: the helper's copyfile(deck, temp, NULL, COPYFILE_XATTR), every extended attribute (in development,
 *   without the helper, com.apple.quarantine through /usr/bin/xattr);
 * - Windows: `<deck>:Zone.Identifier` → `<temp>:Zone.Identifier` with fs;
 * - Linux: nothing.
 * Throws when the marker cannot be copied; the write then fails and the file is unchanged.
 */
export async function copyMarkerToTemp(deck: string, temp: string, opts: MarkerOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const p = pathFor(platform);
  if (!p.isAbsolute(deck) || !p.isAbsolute(temp)) throw new Error('copyMarkerToTemp: paths must be absolute');
  if (platform === 'darwin') return await helperFor(opts).copyXattrs(deck, temp);
  if (platform === 'win32') return await copyZoneIdentifier(deck, temp, opts);
}

/** copyMarkerToTemp as the atomic writer's XattrCopier (atomic-write.ts AtomicWriteOptions.xattrs). */
export function markerXattrCopier(opts: MarkerOptions = {}): XattrCopier {
  return { copy: (from, to) => copyMarkerToTemp(from, to, opts) };
}

/**
 * Copies the internet marker of `from` onto `to` (9.9 Derived files keep the marker): on macOS the same
 * com.apple.quarantine value, set by the native helper; on Windows a copy of the Zone.Identifier stream.
 * A file without a marker gives none. Throws when the marker cannot be read or written: a derived copy that
 * lost the marker would open Trusted.
 */
export async function copyMarker(from: string, to: string, opts: MarkerOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const p = pathFor(platform);
  if (!p.isAbsolute(from) || !p.isAbsolute(to)) throw new Error('copyMarker: paths must be absolute');
  if (platform === 'darwin') {
    const h = helperFor(opts);
    const q = await safeRead(h, from);
    if (!q.ok) throw new Error('Could not read the file’s quarantine marker');
    if (q.value !== null) await h.setQuarantine(to, { value: q.value });
    return;
  }
  if (platform === 'win32') await copyZoneIdentifier(from, to, opts);
}

/** What markDerivedFile needs to know about the document a file is derived from. */
export interface DerivedSource {
  realpath: string;
  /** The marker the document opened with (BlDocument.marker), or null. */
  marker: string | null;
  /** The document opened Protected (a marker, `--protected`, or an untrusted folder). */
  protectedView: boolean;
}

export interface DerivedMarkOptions extends MarkerOptions {
  /**
   * Windows: a target on a volume that keeps no named streams (FAT, exFAT, a share that drops them; the write
   * of `<target>:Zone.Identifier` fails as noStream() reads it, ENOENT for ERROR_INVALID_NAME) is left
   * unmarked and the mark succeeds, as reads already treat such a volume and as Windows drops its own mark of
   * the web there. Only for derived files Blueline never opens: the PDF passes it (review finding 29). An HTML
   * copy (the probe copy, Save a copy) does not, so its save is refused there: a copy that lost the marker
   * would open Trusted. Default false.
   */
  allowStreamlessVolume?: boolean;
}

/**
 * Marks a file Blueline wrote from a document (9.9 Derived files keep the marker: Save a copy for review,
 * Export clean copy, a Cmd+S to a new place, the PDF, the `blueline map` probe copy):
 * - the document's marker, when it opened with one (the same quarantine value; a copy of its Zone.Identifier);
 * - a new marker naming the document, when it opened Protected without one (`--protected`, an untrusted
 *   folder): a copy of a Protected document must not open Trusted (when unsure, refuse);
 * - otherwise whatever marker the document carries now (a Trusted file in a trusted folder may carry one).
 * Throws when the marker cannot be written (see allowStreamlessVolume for the one exception).
 */
export async function markDerivedFile(target: string, source: DerivedSource, options: DerivedMarkOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const p = pathFor(platform);
  if (!p.isAbsolute(target) || !p.isAbsolute(source.realpath)) throw new Error('markDerivedFile: paths must be absolute');
  if (platform !== 'darwin' && platform !== 'win32') return;
  let opts: MarkerOptions = options;
  if (platform === 'win32' && options.allowStreamlessVolume === true) {
    const write = writerOf(options);
    opts = {
      ...options,
      writeFile: async (file, bytes) => {
        try {
          await write(file, bytes);
        } catch (err) {
          if (!noStream(err)) throw err;
        }
      },
    };
  }
  if (source.marker !== null) {
    if (platform === 'darwin') return await helperFor(opts).setQuarantine(target, { value: source.marker });
    if (Buffer.byteLength(source.marker, 'utf8') > MAX_MARKER_BYTES) throw new Error('Could not write the file’s Zone.Identifier');
    return await writerOf(opts)(zoneStreamPath(target), new TextEncoder().encode(source.marker));
  }
  if (source.protectedView) {
    const origin = pathToFileURL(source.realpath).href;
    if (platform === 'darwin') return await helperFor(opts).setQuarantine(target, { properties: { agent: MARKER_AGENT, originUrl: origin } });
    return await writerOf(opts)(zoneStreamPath(target), new TextEncoder().encode(zoneText({ referrerUrl: origin, hostUrl: null })));
  }
  await copyMarker(source.realpath, target, opts);
}

/** A Zone.Identifier stream's text for a file from the internet (ZoneId=3); control characters are dropped. */
function zoneText(info: { referrerUrl: string | null; hostUrl: string | null }): string {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '');
  const lines = ['[ZoneTransfer]', 'ZoneId=3'];
  if (info.referrerUrl) lines.push(`ReferrerUrl=${clean(info.referrerUrl)}`);
  if (info.hostUrl) lines.push(`HostUrl=${clean(info.hostUrl)}`);
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------------------------------
// Download markers (9.9 Derived files keep the marker)
// ---------------------------------------------------------------------------------------------------

/**
 * Marks a file a deck downloaded (Trusted only) as coming from the internet, naming the deck as its
 * source (9.9: "Do not rely on Electron to add one"). Windows: writes `<path>:Zone.Identifier` with ZoneId=3,
 * ReferrerUrl (the deck) and HostUrl (the download). macOS: the helper sets the quarantine properties
 * (agent Blueline, data URL = the download, origin URL = the deck). Returns true when a marker was written.
 */
export async function writeDownloadMarker(
  savePath: string,
  info: { hostUrl: string; sourcePath: string | null },
  opts: { platform?: NodeJS.Platform; helper?: MarkerHelper } = {},
): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  if (!pathFor(platform).isAbsolute(savePath)) return false;
  const referrer = info.sourcePath ? pathToFileURL(info.sourcePath).href : null;
  // The download's own URL is the deck's choice: a data: or blob: URL can be megabytes. Only an http(s) URL of a
  // sane length is recorded; otherwise Windows gets `about:internet` (what browsers write for such downloads)
  // and macOS none, so the marker stays small enough to be read back as one (MAX_MARKER_BYTES).
  const host = /^https?:\/\//i.test(info.hostUrl) && info.hostUrl.length <= MAX_URL ? info.hostUrl : null;
  if (platform === 'win32') {
    await fs.promises.writeFile(zoneStreamPath(savePath), zoneText({ referrerUrl: referrer && referrer.length <= MAX_URL ? referrer : null, hostUrl: host ?? 'about:internet' }), 'utf8');
    return true;
  }
  if (platform === 'darwin') {
    const properties: { agent: string; originUrl?: string; dataUrl?: string } = { agent: MARKER_AGENT };
    if (referrer && referrer.length <= MAX_URL) properties.originUrl = referrer;
    if (host) properties.dataUrl = host;
    await (opts.helper ?? nativeHelper()).setQuarantine(savePath, { properties });
    return true;
  }
  // Linux has no marker.
  return false;
}

// ---------------------------------------------------------------------------------------------------
// Untrusted locations (6.8 Received; 6.10 refused trusted folders)
// ---------------------------------------------------------------------------------------------------

export type UntrustedKind = 'mail' | 'messages' | 'temporary';

export interface UntrustedLocation {
  kind: UntrustedKind;
  /** The folder the file sits in (one of the known mail, messages or temporary folders). */
  folder: string;
}

export interface LocationOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** The Desktop folder (Electron's app.getPath('desktop'): it follows Windows folder redirection). Default <home>/Desktop. */
  desktop?: string;
  /** The Downloads folder (app.getPath('downloads')). Default <home>/Downloads. */
  downloads?: string;
  /** Extra temporary folders (defaults: os.tmpdir() and the platform's usual ones). */
  tmpdirs?: string[];
  env?: Record<string, string | undefined>;
}

function candidateFolders(o: LocationOptions): { kind: UntrustedKind; folder: string }[] {
  const platform = o.platform ?? process.platform;
  const p = pathFor(platform);
  const home = o.home ?? os.homedir();
  const env = o.env ?? process.env;
  const out: { kind: UntrustedKind; folder: string }[] = [];
  const add = (kind: UntrustedKind, folder: string | undefined) => {
    if (folder && p.isAbsolute(folder)) out.push({ kind, folder });
  };
  const tmp = o.tmpdirs ?? [os.tmpdir()];
  for (const t of tmp) add('temporary', t);
  if (platform === 'darwin') {
    const lib = p.join(home, 'Library');
    add('mail', p.join(lib, 'Containers', 'com.apple.mail')); // Mail Downloads and the attachment cache
    add('mail', p.join(lib, 'Mail Downloads')); // older Mail
    add('mail', p.join(lib, 'Mail'));
    add('mail', p.join(lib, 'Containers', 'com.microsoft.Outlook')); // Outlook's attachment cache
    add('mail', p.join(lib, 'Group Containers', 'UBF8T346G9.Office', 'Outlook'));
    add('messages', p.join(lib, 'Messages', 'Attachments'));
    add('messages', p.join(lib, 'Containers', 'com.apple.MobileSMS'));
    for (const t of ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders']) add('temporary', t);
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local');
    add('mail', p.join(local, 'Microsoft', 'Windows', 'INetCache', 'Content.Outlook'));
    add('mail', p.join(local, 'Microsoft', 'Windows', 'Temporary Internet Files', 'Content.Outlook'));
    add('mail', p.join(local, 'Microsoft', 'Olk')); // new Outlook
    add('mail', p.join(local, 'Packages', 'microsoft.windowscommunicationsapps_8wekyb3d8bbwe'));
    add('temporary', p.join(local, 'Temp'));
    add('temporary', env.TEMP);
    add('temporary', env.TMP);
    add('temporary', env.SystemRoot ? p.join(env.SystemRoot, 'Temp') : 'C:\\Windows\\Temp');
  } else {
    // /dev/shm and /run/shm are memory-backed temporary folders anyone may write.
    for (const t of ['/tmp', '/var/tmp', '/dev/shm', '/run/shm']) add('temporary', t);
    add('temporary', env.XDG_RUNTIME_DIR);
  }
  return out;
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** `file` is strictly inside `folder` (path.relative, never a string-prefix test). */
function inside(folder: string, file: string, caseInsensitive: boolean, p: path.PlatformPath): boolean {
  const a = caseInsensitive ? folder.toLowerCase() : folder;
  const b = caseInsensitive ? file.toLowerCase() : file;
  const rel = p.relative(a, b);
  return rel.length > 0 && !rel.startsWith('..') && !p.isAbsolute(rel);
}

function samePath(a: string, b: string, caseInsensitive: boolean, p: path.PlatformPath): boolean {
  return p.relative(caseInsensitive ? a.toLowerCase() : a, caseInsensitive ? b.toLowerCase() : b) === '';
}

/** macOS and Windows volumes are case-insensitive by default (APFS, NTFS); Linux ones are not. */
export function caseInsensitivePaths(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/**
 * Whether a file sits in a mail-attachment, messages-attachment or temporary folder (6.8: such a file is
 * *received*, and Cmd+S first asks where to save it). Compares with path.relative against both the
 * folder as named and its realpath (`/tmp` is `/private/tmp` on macOS). Returns the match, or null.
 */
export function isUntrustedLocation(realpath: string, opts: LocationOptions = {}): UntrustedLocation | null {
  const platform = opts.platform ?? process.platform;
  const p = pathFor(platform);
  if (typeof realpath !== 'string' || !p.isAbsolute(realpath)) return null;
  const ci = caseInsensitivePaths(platform);
  for (const c of candidateFolders(opts)) {
    for (const f of new Set([c.folder, realOrSelf(c.folder)])) {
      if (inside(f, realpath, ci, p)) return { kind: c.kind, folder: f };
    }
  }
  return null;
}

/** Volume roots and mount points other than `/` (6.10: "volume roots"). */
function isVolumeRoot(folder: string, platform: NodeJS.Platform): boolean {
  const p = pathFor(platform);
  const parsed = p.parse(folder);
  if (folder === parsed.root || p.relative(parsed.root, folder) === '') return true;
  if (platform === 'win32') {
    // A share's root (`\\server\share`) parses as its own root above; a device or long-path prefix
    // (`\\?\`, `\\.\`) is not a folder anyone picks from the dialog: when unsure, refuse.
    return /^\\\\[?.]\\/.test(folder);
  }
  const f = folder.replace(/\/+$/, '');
  if (platform === 'darwin') {
    return /^\/Volumes(?:\/[^/]+)?$/i.test(f) || /^\/System\/Volumes(?:\/[^/]+)?$/i.test(f);
  }
  // Linux: removable media and mount points (udisks, fstab conventions).
  return /^\/(?:mnt|media)(?:\/[^/]+)?$/.test(f) || /^\/media\/[^/]+\/[^/]+$/.test(f) || /^\/run\/media(?:\/[^/]+){0,2}$/.test(f);
}

/**
 * Settings › Trust refuses to mark these as trusted folders (6.10): the home folder, Desktop, Downloads,
 * the Mail and Messages attachment folders, temporary folders, and volume roots. A folder that contains one
 * of them is refused too (trusting `/Users` would trust every home folder's Downloads), and so is any folder
 * inside a mail, messages or temporary folder. A folder inside Desktop or Downloads may be trusted: that is a
 * project the user chose, not where downloads land. Returns the reason, or null when the folder may be trusted.
 */
export function refuseAsTrustedFolder(folderReal: string, opts: LocationOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const p = pathFor(platform);
  if (typeof folderReal !== 'string' || !p.isAbsolute(folderReal) || folderReal.includes('\0')) return 'not an absolute path';
  const ci = caseInsensitivePaths(platform);
  const home = opts.home ?? os.homedir();
  if (isVolumeRoot(folderReal, platform)) return 'a volume root';
  const named: [string, string, string][] = [
    ['the home folder', 'a folder that contains your home folder', home],
    ['Desktop', 'a folder that contains Desktop', p.join(home, 'Desktop')],
    ['Downloads', 'a folder that contains Downloads', p.join(home, 'Downloads')],
  ];
  if (opts.desktop) named.push(['Desktop', 'a folder that contains Desktop', opts.desktop]);
  if (opts.downloads) named.push(['Downloads', 'a folder that contains Downloads', opts.downloads]);
  for (const [name, , folder] of named) {
    for (const f of new Set([folder, realOrSelf(folder)])) if (samePath(f, folderReal, ci, p)) return name;
  }
  for (const [, contains, folder] of named) {
    for (const f of new Set([folder, realOrSelf(folder)])) if (inside(folderReal, f, ci, p)) return contains;
  }
  // The folder itself, or anything inside, a mail/messages/temporary folder; or a folder that contains one.
  for (const c of candidateFolders(opts)) {
    for (const f of new Set([c.folder, realOrSelf(c.folder)])) {
      if (samePath(f, folderReal, ci, p) || inside(f, folderReal, ci, p) || inside(folderReal, f, ci, p)) {
        return c.kind === 'temporary' ? 'a temporary folder' : c.kind === 'mail' ? 'a mail attachment folder' : 'a Messages attachment folder';
      }
    }
  }
  return null;
}
