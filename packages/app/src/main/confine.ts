// Path confinement for the blueline:// handler (9.1 Protocol, Refusals steps 2–4). The handler serves a
// document's sibling files from its folder and below, and nothing else: no `..`, no dotfiles (`.ssh`), no
// symlink that leads out of the folder, and no symlink swapped in after the check. Every failure is a
// plain `null`, which the handler turns into a 404 with no details.
//
// This module is "pure-ish": it touches the file system (realpath, lstat, open, fstat) but no Electron, so
// unit tests run it against real temp folders.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Extensions the `-files` host serves (9.1 Serving). Everything else is a 404. */
export const FILES_EXTENSIONS: ReadonlySet<string> = new Set([
  'css', 'js',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp',
  'woff', 'woff2', 'ttf', 'otf',
  'mp3', 'm4a', 'wav', 'ogg', 'webm', 'mp4',
]);

/** A request path deeper than this, or a segment longer than this, is refused before touching the disk. */
export const MAX_SEGMENTS = 64;
export const MAX_SEGMENT_LENGTH = 255;

export interface ConfineOptions {
  /**
   * Which platform's name rules apply to decoded segments (default `process.platform`). `win32` adds the
   * reserved device names and the trailing dot/space rule (9.1 Refusals step 2). Tests pass `win32` on
   * Linux to exercise those rules; file-system calls always use the host's own semantics.
   */
  platform?: NodeJS.Platform;
  /**
   * When set, the request's last segment and the resolved file must both have one of these extensions
   * (lowercase, no dot). The `-files` host passes FILES_EXTENSIONS.
   */
  allowedExtensions?: ReadonlySet<string>;
  /** Overrides case-sensitivity detection for the folder's volume (tests). */
  caseInsensitive?: boolean;
}

/** An open, verified regular file inside the folder. The caller owns `fd` and must close it. */
export interface ConfinedFile {
  fd: number;
  size: number;
  /** The file's realpath (inside folderReal). */
  realpath: string;
  /** Lowercase extension of the realpath, without the dot ('' if none). */
  ext: string;
}

// POSIX: O_NOFOLLOW refuses a symlink swapped into the final component after realpath; O_NONBLOCK keeps
// a FIFO swapped in after the lstat from blocking main's thread in open(2). Both are 0 on Windows.
const OPEN_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

// 9.1 Refusals step 2: reserved device names on Windows. The stem is the part before the first dot, with
// trailing spaces removed (`CON .txt` and `nul.png` are devices too). COM0/LPT0 and the superscript
// digits are included because some Windows versions reserve them; refusing extra names is harmless.
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i;
// Characters Windows never allows in a file name (`/`, `\` and `:` are refused on every platform).
const WIN_INVALID = /[<>"|?*]/;

/** Lowercase extension of a file name, without the dot; '' when there is none. */
export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * 9.1 Refusals step 2, for one decoded segment. Refuses an empty segment, one that starts with `.`
 * (`.`, `..`, `.ssh`), and one that contains `/`, `\`, `:`, NUL or any other control character (C0, DEL,
 * C1). On Windows, also reserved device names, names ending in a dot or a space, and `<>"|?*`.
 */
export function segmentAllowed(seg: string, platform: NodeJS.Platform = process.platform): boolean {
  if (seg.length === 0 || seg.length > MAX_SEGMENT_LENGTH) return false;
  if (seg.charCodeAt(0) === 0x2e /* . */) return false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return false;
    if (c === 0x2f /* / */ || c === 0x5c /* \ */ || c === 0x3a /* : */) return false;
  }
  if (platform === 'win32') {
    const last = seg.charCodeAt(seg.length - 1);
    if (last === 0x2e || last === 0x20) return false;
    if (WIN_INVALID.test(seg)) return false;
    const dot = seg.indexOf('.');
    const stem = (dot === -1 ? seg : seg.slice(0, dot)).replace(/ +$/, '');
    if (WIN_RESERVED.test(stem)) return false;
  }
  return true;
}

/**
 * 9.1 Refusals step 2: splits a URL `pathname` on `/` BEFORE decoding, percent-decodes each segment exactly
 * once, and checks each with segmentAllowed. Returns the decoded segments, or null to refuse. Splitting
 * first means an encoded `%2F` can never create a separator, and decoding once means `%252e` stays `%2e`.
 */
export function decodePathSegments(pathname: string, platform: NodeJS.Platform = process.platform): string[] | null {
  if (typeof pathname !== 'string' || pathname.charCodeAt(0) !== 0x2f) return null;
  const raw = pathname.slice(1).split('/');
  if (raw.length > MAX_SEGMENTS) return null;
  const out: string[] = [];
  for (const r of raw) {
    if (r.length === 0) return null; // `//`, a trailing `/`, or the bare root
    let seg: string;
    try {
      seg = decodeURIComponent(r); // throws on a malformed escape or invalid UTF-8: refuse
    } catch {
      return null;
    }
    if (!segmentAllowed(seg, platform)) return null;
    out.push(seg);
  }
  return out;
}

const caseCache = new Map<string, boolean>();

/**
 * Whether the volume that holds `dirReal` compares names case-insensitively (9.1 Refusals step 3). It
 * flips the case of the deepest path component that has a cased letter and checks whether the flipped
 * path names the same directory (same dev and inode). With no cased letter anywhere, it falls back to the
 * platform default (macOS and Windows volumes are case-insensitive by default). Cached per path.
 */
export function isCaseInsensitiveVolume(dirReal: string): boolean {
  const cached = caseCache.get(dirReal);
  if (cached !== undefined) return cached;
  let result = process.platform === 'darwin' || process.platform === 'win32';
  const parsed = path.parse(dirReal);
  const parts = dirReal.slice(parsed.root.length).split(path.sep).filter((p) => p.length > 0);
  for (let i = parts.length - 1; i >= 0; i--) {
    const flipped = flipCase(parts[i]);
    if (flipped === parts[i]) continue;
    const original = path.join(parsed.root, ...parts.slice(0, i + 1));
    const other = path.join(parsed.root, ...parts.slice(0, i), flipped);
    try {
      const a = fs.statSync(original, { bigint: true });
      const b = fs.statSync(other, { bigint: true, throwIfNoEntry: false });
      result = b !== undefined && a.dev === b.dev && a.ino === b.ino;
    } catch {
      // Unreadable: keep the platform default.
    }
    break;
  }
  if (caseCache.size > 256) caseCache.clear();
  caseCache.set(dirReal, result);
  return result;
}

function flipCase(s: string): string {
  let out = '';
  for (const ch of s) {
    const lo = ch.toLowerCase();
    out += ch === lo ? ch.toUpperCase() : lo;
  }
  return out;
}

/**
 * 9.1 Refusals step 3: true when `fileReal` is strictly inside `folderReal`, by `path.relative` (never a
 * string-prefix test). On a case-insensitive volume both sides are compared lowercased. On macOS both
 * sides are NFC-normalized first, because APFS and HFS+ treat NFC and NFD spellings as the same name.
 */
export function isInsideFolder(folderReal: string, fileReal: string, caseInsensitive: boolean): boolean {
  let a = folderReal;
  let b = fileReal;
  if (process.platform === 'darwin') {
    a = a.normalize('NFC');
    b = b.normalize('NFC');
  }
  if (caseInsensitive) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  const rel = path.relative(a, b);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolves a URL pathname to an open regular file inside `folderReal` (9.1 Refusals steps 2–4), or null.
 *
 * 2. Split before decoding, decode each segment once, refuse bad segments (decodePathSegments).
 * 3. Join onto folderReal, take `fs.realpathSync.native`, and accept only a path inside the folder
 *    (isInsideFolder, case-insensitive on a case-insensitive volume).
 * 4. lstat the realpath (a regular file, not a symlink), open it with O_NOFOLLOW, fstat the descriptor,
 *    and require a regular file with the same device and inode, so a file swapped in after the check is
 *    not served. On Linux it also reads the descriptor's path back from /proc and re-checks containment,
 *    which catches a directory component swapped for a symlink between the realpath and the open.
 *
 * `folderReal` must itself be a realpath (the document's folder, resolved at open). The caller owns the
 * returned descriptor.
 */
export function resolveConfined(folderReal: string, pathname: string, opts: ConfineOptions = {}): ConfinedFile | null {
  const platform = opts.platform ?? process.platform;
  if (typeof folderReal !== 'string' || !path.isAbsolute(folderReal)) return null;
  const segs = decodePathSegments(pathname, platform);
  if (!segs) return null;
  const allowed = opts.allowedExtensions;
  // Refuse a disallowed extension before touching the disk at all.
  if (allowed && !allowed.has(extOf(segs[segs.length - 1]))) return null;

  let fileReal: string;
  try {
    fileReal = fs.realpathSync.native(path.join(folderReal, ...segs));
  } catch {
    return null;
  }
  const ci = opts.caseInsensitive ?? isCaseInsensitiveVolume(folderReal);
  if (!isInsideFolder(folderReal, fileReal, ci)) return null;
  const ext = extOf(path.basename(fileReal));
  // The realpath's own extension decides the MIME type, so it must be allowed too (a symlink `a.png`
  // pointing at `notes.txt` inside the folder is refused).
  if (allowed && !allowed.has(ext)) return null;

  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(fileReal, { bigint: true });
  } catch {
    return null;
  }
  if (!before.isFile()) return null;

  let fd: number;
  try {
    fd = fs.openSync(fileReal, OPEN_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) {
      fs.closeSync(fd);
      return null;
    }
    if (process.platform === 'linux') {
      let viaProc: string | null = null;
      try {
        viaProc = fs.readlinkSync(`/proc/self/fd/${fd}`);
      } catch {
        viaProc = null; // no /proc: the dev+ino check above still holds
      }
      if (viaProc !== null && !isInsideFolder(folderReal, viaProc, ci)) {
        fs.closeSync(fd);
        return null;
      }
    }
    return { fd, size: Number(st.size), realpath: fileReal, ext };
  } catch {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    return null;
  }
}

/** Like resolveConfined, but only returns the realpath (the descriptor is closed). For link targets. */
export function resolveConfinedPath(folderReal: string, pathname: string, opts: ConfineOptions = {}): string | null {
  const f = resolveConfined(folderReal, pathname, opts);
  if (!f) return null;
  try {
    fs.closeSync(f.fd);
  } catch {
    // ignore
  }
  return f.realpath;
}
