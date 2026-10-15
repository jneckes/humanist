// Internet markers (6.10 When it applies, D12, 9.9 Writes) and untrusted locations (6.8 Received).
//
// A file opens Protected when it carries an internet marker: macOS quarantine properties
// (`com.apple.quarantine`) or a Windows `Zone.Identifier` stream with ZoneId 3 or more. The marker's whole
// value is what trust.json remembers a decision against (6.10), so readInternetMarker returns it verbatim.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

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

export interface MarkerOptions {
  platform?: NodeJS.Platform;
  /** Runs a program without a shell (default child_process.execFile). Tests inject a fake. */
  execFile?: (file: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Reads a whole file (default fs.promises.readFile). Tests inject a fake. */
  readFile?: (p: string) => Promise<Uint8Array>;
}

const XATTR = '/usr/bin/xattr';

/** The path flavour of the platform being checked (tests run win32 rules on Linux). */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}
const QUARANTINE = 'com.apple.quarantine';
const MAX_MARKER_BYTES = 64 * 1024;

function defaultExecFile(file: string, args: string[], opts: { timeout: number; maxBuffer: number }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(file, args, { ...opts, encoding: 'utf8', windowsHide: true, shell: false }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * Reads the internet marker of a file (6.10). `realpath` must be absolute.
 * - macOS: `com.apple.quarantine`, read with `/usr/bin/xattr -p` (interim; the Phase 1 native helper
 *   replaces it). Any quarantine value is a marker.
 * - Windows: the `<path>:Zone.Identifier` stream, a marker when its ZoneId is 3 (Internet) or more.
 * - Linux and others: no marker.
 */
export async function readInternetMarker(realpath: string, opts: MarkerOptions = {}): Promise<InternetMarker> {
  const platform = opts.platform ?? process.platform;
  if (typeof realpath !== 'string' || !pathFor(platform).isAbsolute(realpath)) return { marker: null, reason: REASON_UNKNOWN, uncertain: true };
  if (platform === 'darwin') return readQuarantine(realpath, opts.execFile ?? defaultExecFile);
  if (platform === 'win32') return readZoneIdentifier(realpath, opts.readFile ?? ((p) => fs.promises.readFile(p)));
  return { marker: null, reason: null };
}

async function readQuarantine(realpath: string, run: NonNullable<MarkerOptions['execFile']>): Promise<InternetMarker> {
  // Phase 1: the native helper reads quarantine properties in-process; xattr is the Phase 0 stand-in. The
  // path is absolute, so it can never be read as an option.
  const r = await run(XATTR, ['-p', QUARANTINE, realpath], { timeout: 5000, maxBuffer: MAX_MARKER_BYTES });
  if (r.code === 0) {
    const value = r.stdout.replace(/\r?\n$/, '');
    if (value.length === 0) return { marker: null, reason: REASON_UNKNOWN, uncertain: true };
    return { marker: value, reason: REASON_INTERNET };
  }
  // xattr exits 1 with "No such xattr" when the file has no quarantine attribute.
  if (r.code === 1 && /no such xattr/i.test(r.stderr)) return { marker: null, reason: null };
  return { marker: null, reason: REASON_UNKNOWN, uncertain: true };
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

async function readZoneIdentifier(realpath: string, read: (p: string) => Promise<Uint8Array>): Promise<InternetMarker> {
  let bytes: Uint8Array;
  try {
    bytes = await read(`${realpath}:Zone.Identifier`);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    // No stream (or a volume without streams, such as FAT): no marker.
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EINVAL') return { marker: null, reason: null };
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

// ---------------------------------------------------------------------------------------------------
// Download markers (9.9 Derived files keep the marker)
// ---------------------------------------------------------------------------------------------------

/**
 * Marks a file a deck downloaded (Trusted only) as coming from the internet, naming the deck as its
 * source (9.9). Windows: writes `<path>:Zone.Identifier` with ZoneId=3, ReferrerUrl (the deck) and HostUrl
 * (the download). Returns true when a marker was written.
 */
export async function writeDownloadMarker(
  savePath: string,
  info: { hostUrl: string; sourcePath: string | null },
  opts: { platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  if (!pathFor(platform).isAbsolute(savePath)) return false;
  if (platform === 'win32') {
    const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '');
    const lines = ['[ZoneTransfer]', 'ZoneId=3'];
    if (info.sourcePath) lines.push(`ReferrerUrl=${clean(pathToFileURL(info.sourcePath).href)}`);
    if (info.hostUrl) lines.push(`HostUrl=${clean(info.hostUrl)}`);
    await fs.promises.writeFile(`${savePath}:Zone.Identifier`, lines.join('\r\n') + '\r\n', 'utf8');
    return true;
  }
  // Phase 1: on macOS the native helper sets quarantine properties (LSQuarantine type, data URL and origin
  // URL = the deck) on the saved file. Linux has no marker.
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
  /** Extra temporary folders (defaults: os.tmpdir() and the platform's usual ones). */
  tmpdirs?: string[];
  env?: Record<string, string | undefined>;
}

function candidateFolders(o: LocationOptions): { kind: UntrustedKind; folder: string }[] {
  const platform = o.platform ?? process.platform;
  const home = o.home ?? os.homedir();
  const env = o.env ?? process.env;
  const out: { kind: UntrustedKind; folder: string }[] = [];
  const add = (kind: UntrustedKind, folder: string | undefined) => {
    if (folder) out.push({ kind, folder });
  };
  const tmp = o.tmpdirs ?? [os.tmpdir()];
  for (const t of tmp) add('temporary', t);
  if (platform === 'darwin') {
    const lib = path.join(home, 'Library');
    add('mail', path.join(lib, 'Containers', 'com.apple.mail')); // Mail Downloads and the attachment cache
    add('mail', path.join(lib, 'Mail Downloads')); // older Mail
    add('mail', path.join(lib, 'Mail'));
    add('mail', path.join(lib, 'Containers', 'com.microsoft.Outlook')); // Outlook's attachment cache
    add('mail', path.join(lib, 'Group Containers', 'UBF8T346G9.Office', 'Outlook'));
    add('messages', path.join(lib, 'Messages', 'Attachments'));
    add('messages', path.join(lib, 'Containers', 'com.apple.MobileSMS'));
    for (const t of ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders']) add('temporary', t);
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    add('mail', path.join(local, 'Microsoft', 'Windows', 'INetCache', 'Content.Outlook'));
    add('mail', path.join(local, 'Microsoft', 'Windows', 'Temporary Internet Files', 'Content.Outlook'));
    add('mail', path.join(local, 'Microsoft', 'Olk')); // new Outlook
    add('mail', path.join(local, 'Packages', 'microsoft.windowscommunicationsapps_8wekyb3d8bbwe'));
    add('temporary', path.join(local, 'Temp'));
    add('temporary', env.TEMP);
    add('temporary', env.TMP);
    add('temporary', env.SystemRoot ? path.join(env.SystemRoot, 'Temp') : 'C:\\Windows\\Temp');
  } else {
    for (const t of ['/tmp', '/var/tmp']) add('temporary', t);
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

function inside(folder: string, file: string, caseInsensitive: boolean): boolean {
  const a = caseInsensitive ? folder.toLowerCase() : folder;
  const b = caseInsensitive ? file.toLowerCase() : file;
  const rel = path.relative(a, b);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Whether a file sits in a mail-attachment, messages-attachment or temporary folder (6.8: such a file is
 * *received*, and Cmd+S first asks where to save it). Compares with path.relative against both the
 * folder as named and its realpath (`/tmp` is `/private/tmp` on macOS). Returns the match, or null.
 */
export function isUntrustedLocation(realpath: string, opts: LocationOptions = {}): UntrustedLocation | null {
  if (typeof realpath !== 'string' || !path.isAbsolute(realpath)) return null;
  const platform = opts.platform ?? process.platform;
  const ci = platform === 'darwin' || platform === 'win32';
  for (const c of candidateFolders(opts)) {
    for (const f of new Set([c.folder, realOrSelf(c.folder)])) {
      if (inside(f, realpath, ci)) return { kind: c.kind, folder: f };
    }
  }
  return null;
}

/**
 * Settings › Trust refuses to mark these as trusted folders (6.10): the home folder, Desktop, Downloads,
 * the Mail and Messages attachment folders, temporary folders, and volume roots. Returns the reason, or
 * null when the folder may be trusted. (Settings › Trust ships in Phase 1; the rule lives here with the
 * folder lists.)
 */
export function refuseAsTrustedFolder(folderReal: string, opts: LocationOptions = {}): string | null {
  if (typeof folderReal !== 'string' || !path.isAbsolute(folderReal)) return 'not an absolute path';
  const platform = opts.platform ?? process.platform;
  const ci = platform === 'darwin' || platform === 'win32';
  const home = opts.home ?? os.homedir();
  const same = (a: string, b: string) => {
    const rel = path.relative(ci ? a.toLowerCase() : a, ci ? b.toLowerCase() : b);
    return rel === '';
  };
  const parsed = path.parse(folderReal);
  if (folderReal === parsed.root || same(folderReal, parsed.root)) return 'a volume root';
  if (platform === 'darwin' && /^\/Volumes\/[^/]+\/?$/.test(folderReal)) return 'a volume root';
  for (const [name, p] of [
    ['the home folder', home],
    ['Desktop', path.join(home, 'Desktop')],
    ['Downloads', path.join(home, 'Downloads')],
  ] as const) {
    if (same(p, folderReal) || same(realOrSelf(p), folderReal)) return name;
  }
  // The folder itself, or anything inside, a mail/messages/temporary folder; or a folder that contains one.
  for (const c of candidateFolders(opts)) {
    for (const f of new Set([c.folder, realOrSelf(c.folder)])) {
      if (same(f, folderReal) || inside(f, folderReal, ci) || inside(folderReal, f, ci)) {
        return c.kind === 'temporary' ? 'a temporary folder' : c.kind === 'mail' ? 'a mail attachment folder' : 'a Messages attachment folder';
      }
    }
  }
  return null;
}
