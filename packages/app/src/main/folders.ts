// Trusted and untrusted folders, the Trust settings, and the trust state a file opens in (6.10 When it applies,
// What changes; Settings › Trust; 9.9 Network policy: the strict option and the user-editable allowlist).
//
// The settings live in config.json (config.ts stores them; TrustSettings owns their rules). trustFor is the
// one decision of 6.10 When it applies, as a pure function, with the remembered decision from trust.json
// (trust-store.ts); resolveOpenTrust reads the marker and the store and calls it, for opening a file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TrustState } from '@blueline/core/ipc';
import type { FolderKind, FolderResult, HostResult } from '@blueline/core/ipc-trust';
import { MAX_FOLDER_PATH, MAX_FOLDERS, MAX_HOSTS, type ConfigStore } from './config';
import type { TrustDecision } from './documents';
import { REASON_INTERNET, REASON_UNKNOWN, caseInsensitivePaths, readInternetMarker, refuseAsTrustedFolder, type InternetMarker, type LocationOptions } from './markers';
import { DEFAULT_ALLOWLIST, normalizeAllowlistHost } from './network-policy';
import type { RememberedTrust, TrustStore } from './trust-store';

/** The trust bar's reasons (6.10: "The yellow trust bar states the reason"). Same text as documents.ts. */
export const REASON_REQUESTED = 'Opened at your request';
export const REASON_UNTRUSTED_FOLDER = 'In a folder you marked as untrusted';

export interface FolderLists {
  trusted: readonly string[];
  untrusted: readonly string[];
}

/** The trust state a file opens in, and the switches to turn on at open (6.10). */
export interface OpenTrust {
  state: TrustState;
  /** The trust bar's reason; null when Trusted. */
  reason: string | null;
  /** Turn **Allow network** on at open (remembered for this file and marker). Always false when Trusted. */
  allowNetwork: boolean;
  /** Editing is allowed: Trusted, or **Enable editing** remembered for this file and marker. */
  editing: boolean;
  /** 6.8 Received: remembered, or this open is the file's first in Protected view. */
  received: boolean;
  /**
   * `received` comes from trust.json (the file's first Protected open, or the user's switch on the file name),
   * so it decides alone; otherwise the caller also counts 6.8's location rule (a mail-attachment or temporary
   * folder, markers.ts isUntrustedLocation).
   */
  receivedRemembered: boolean;
  /** The marker's whole value, or null (what trust.json remembers a decision against). */
  marker: string | null;
  /**
   * The marker could not be read. Nothing is remembered for such an open (there is no marker to remember it
   * against): the trust bar's switches then apply to this window only.
   */
  markerUncertain: boolean;
  /** Which 6.10 rule decided (logs, tests). */
  rule: 'requested' | 'trusted-folder' | 'untrusted-folder' | 'marker' | 'none';
  /** The trusted or untrusted folder that decided, when one did. */
  folder: string | null;
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** The path's segments after resolving `.` and `..` (Windows: either separator; the drive or share first). */
function segments(x: string, p: path.PlatformPath): string[] {
  return p
    .resolve(x)
    .split(p === path.win32 ? /[\\/]+/ : /\/+/)
    .filter((s) => s.length > 0);
}

/**
 * `file` equals `folder` or is inside it, segment by segment (never a string-prefix test). Case-sensitive unless
 * `ci`: path.win32.relative ignores case by itself, so it cannot be used for an exact comparison.
 */
function within(folder: string, file: string, ci: boolean, p: path.PlatformPath): boolean {
  const a = segments(folder, p);
  const b = segments(file, p);
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (ci ? a[i].toLowerCase() !== b[i].toLowerCase() : a[i] !== b[i]) return false;
  }
  return true;
}

function depth(folder: string, p: path.PlatformPath): number {
  return segments(folder, p).length;
}

/**
 * The trusted or untrusted folder that applies to `realpath`: the deepest folder that contains it, whichever
 * list it is in. So an untrusted folder inside a trusted one (`~/Projects` trusted, `~/Projects/inbox`
 * untrusted) makes the files under it Protected, and a trusted folder inside an untrusted one makes its files
 * Trusted: the more specific choice is the one the user made last about those files. If the same folder is in
 * both lists (a hand-edited config.json), untrusted wins: when unsure, refuse.
 *
 * Both sides are realpaths, which macOS and Windows return in the case stored on disk, so a trusted folder
 * matches only exactly: on a case-sensitive volume `decks` must not count as inside a trusted `Decks`. An
 * untrusted folder also matches case-insensitively on macOS and Windows: a wrong match there only makes a file
 * Protected.
 */
export function folderFor(realpath: string, lists: FolderLists, platform: NodeJS.Platform = process.platform): { kind: FolderKind; folder: string } | null {
  const p = pathFor(platform);
  const ciUntrusted = caseInsensitivePaths(platform);
  let best: { kind: FolderKind; folder: string; depth: number } | null = null;
  const consider = (kind: FolderKind, folder: string) => {
    const ci = kind === 'untrusted' && ciUntrusted;
    if (typeof folder !== 'string' || !p.isAbsolute(folder) || !within(folder, realpath, ci, p)) return;
    const d = depth(folder, p);
    if (!best || d > best.depth || (d === best.depth && kind === 'untrusted')) best = { kind, folder, depth: d };
  };
  for (const f of lists.trusted) consider('trusted', f);
  for (const f of lists.untrusted) consider('untrusted', f);
  const b = best as { kind: FolderKind; folder: string; depth: number } | null;
  return b ? { kind: b.kind, folder: b.folder } : null;
}

/**
 * 6.10 When it applies, exactly:
 * 1. Protected when the user asked for it (`--protected`, File › Open in Protected View), always. The
 *    remembered switches do not apply then: the user asked to see the file with network and editing off.
 * 2. A file in a trusted folder opens Trusted, even when it carries an internet marker (or one that cannot be
 *    read).
 * 3. A file in an untrusted folder opens Protected, even without a marker.
 * 4. A file with an internet marker, or whose marker cannot be read, opens Protected.
 * 5. Otherwise Trusted.
 * (2 and 3: the deepest folder decides, folderFor.)
 *
 * In Protected view a remembered **Allow network** and **Enable editing** apply while the file carries the
 * same marker the decision was made on (`remembered.marker`, the whole value; a marker that cannot be read
 * matches nothing). The caller passes the decision trust.json holds for this realpath (TrustStore.get).
 */
export function trustFor(
  realpath: string,
  marker: InternetMarker,
  requestedProtected: boolean,
  remembered: RememberedTrust | null,
  lists: FolderLists,
  opts: { platform?: NodeJS.Platform } = {},
): OpenTrust {
  const platform = opts.platform ?? process.platform;
  const value = marker.uncertain ? null : marker.marker;
  const applies = remembered !== null && !marker.uncertain && remembered.marker === marker.marker;
  const mem = applies ? remembered : null;
  const markerReason = marker.uncertain ? (marker.reason ?? REASON_UNKNOWN) : marker.marker !== null ? (marker.reason ?? REASON_INTERNET) : null;
  const protectedOpen = (reason: string, rule: OpenTrust['rule'], folder: string | null, switches: boolean): OpenTrust => ({
    state: 'protected',
    reason,
    allowNetwork: switches && mem !== null && mem.allowNetwork,
    editing: switches && mem !== null && mem.editing,
    received: mem ? mem.received : true,
    receivedRemembered: mem !== null,
    marker: value,
    markerUncertain: marker.uncertain === true,
    rule,
    folder,
  });
  const trustedOpen = (rule: OpenTrust['rule'], folder: string | null, m: string | null): OpenTrust => ({
    state: 'trusted',
    reason: null,
    allowNetwork: false,
    editing: true,
    received: mem ? mem.received : false,
    receivedRemembered: mem !== null,
    marker: m,
    markerUncertain: marker.uncertain === true,
    rule,
    folder,
  });
  if (requestedProtected) return protectedOpen(REASON_REQUESTED, 'requested', null, false);
  const f = folderFor(realpath, lists, platform);
  if (f?.kind === 'trusted') return trustedOpen('trusted-folder', f.folder, value);
  if (f?.kind === 'untrusted') return protectedOpen(marker.marker !== null && !marker.uncertain ? (markerReason ?? REASON_INTERNET) : REASON_UNTRUSTED_FOLDER, 'untrusted-folder', f.folder, true);
  if (markerReason !== null) return protectedOpen(markerReason, 'marker', null, true);
  return trustedOpen('none', null, null);
}

/** OpenTrust as documents.ts's TrustDecision (BlDocument's constructor input). */
export function toTrustDecision(t: OpenTrust): TrustDecision {
  return { trust: t.state, reason: t.reason, marker: t.marker };
}

export interface ResolveDeps {
  store: TrustStore;
  lists(): FolderLists;
  /** Default readInternetMarker (the native helper on macOS, Zone.Identifier on Windows). */
  readMarker?: (realpath: string) => Promise<InternetMarker>;
  platform?: NodeJS.Platform;
}

/**
 * Decides the trust a file opens in (6.10): reads its marker, looks up the decision trust.json holds for it on
 * that marker (a decision on another marker is dropped there), and applies trustFor. A file that opens
 * Protected for the first time is remembered as received (6.8: "A file is received when it first opened in
 * Protected view … The state and any switch are remembered in trust.json"). `realpath` must be the file's
 * realpath.
 */
export async function resolveOpenTrust(realpath: string, requestedProtected: boolean, deps: ResolveDeps): Promise<OpenTrust> {
  let m: InternetMarker;
  try {
    m = await (deps.readMarker ?? ((p: string) => readInternetMarker(p)))(realpath);
  } catch {
    m = { marker: null, reason: REASON_UNKNOWN, uncertain: true };
  }
  const remembered = m.uncertain ? null : deps.store.get(realpath, m.marker);
  const t = trustFor(realpath, m, requestedProtected, remembered, deps.lists(), { platform: deps.platform });
  if (t.state === 'protected' && remembered === null && !m.uncertain) {
    await deps.store.set(realpath, { marker: m.marker, allowNetwork: false, editing: false, received: true }).catch(() => undefined);
  }
  return t;
}

// ---------------------------------------------------------------------------------------------------
// Settings › Trust
// ---------------------------------------------------------------------------------------------------

export type TrustSettingsChange = 'folders' | 'strict' | 'allowlist';

export interface TrustSettingsOptions extends LocationOptions {
  /** Default fs.realpath.native. */
  realpath?: (p: string) => Promise<string>;
  /** Default fs.promises.stat. */
  stat?: (p: string) => Promise<{ isDirectory(): boolean }>;
}

function realpathNative(p: string): Promise<string> {
  return new Promise((resolve, reject) => fs.realpath.native(p, (err, r) => (err ? reject(err) : resolve(r))));
}

function sentence(why: string): string {
  return why.charAt(0).toUpperCase() + why.slice(1);
}

/**
 * The Trust settings over config.json: trusted and untrusted folders (realpaths), "Block all network in
 * Protected view", and the CDN allowlist (9.9: user-editable in Settings › Trust; absent = the 9.9 list).
 * Changes notify onChange listeners, so main re-applies every open document's policy (the views item's
 * onTrustSettingsChanged).
 */
export class TrustSettings {
  private readonly listeners = new Set<(c: TrustSettingsChange) => void>();
  private trustedCache: { from: readonly string[]; ok: string[] } | null = null;

  constructor(
    private readonly config: ConfigStore,
    private readonly o: TrustSettingsOptions = {},
  ) {}

  private get platform(): NodeJS.Platform {
    return this.o.platform ?? process.platform;
  }

  private get p(): path.PlatformPath {
    return pathFor(this.platform);
  }

  private same(a: string, b: string): boolean {
    const ci = caseInsensitivePaths(this.platform);
    return this.p.relative(ci ? a.toLowerCase() : a, ci ? b.toLowerCase() : b) === '';
  }

  /** The trusted folders as stored. */
  trustedFolders(): string[] {
    return this.config.get().trustedFolders ?? [];
  }

  untrustedFolders(): string[] {
    return this.config.get().untrustedFolders ?? [];
  }

  /**
   * The lists trustFor uses. A trusted folder that addFolder would refuse (only a hand-edited config.json can
   * hold one) is left out: a folder such as the home folder or `/` must never make files Trusted.
   */
  lists(): FolderLists {
    const trusted = this.trustedFolders();
    const c = this.trustedCache;
    let ok: string[];
    if (c && c.from.length === trusted.length && c.from.every((f, i) => f === trusted[i])) ok = c.ok;
    else {
      ok = trusted.filter((f) => refuseAsTrustedFolder(f, this.o) === null);
      this.trustedCache = { from: trusted, ok };
    }
    return { trusted: [...ok], untrusted: this.untrustedFolders() };
  }

  /** 6.10 "Block all network in Protected view" (9.9: the strict option blocks the allowlist too). */
  strict(): boolean {
    return this.config.get().strictProtected === true;
  }

  /** The CDN allowlist in effect (9.9). */
  allowlist(): readonly string[] {
    return this.config.get().cdnAllowlist ?? DEFAULT_ALLOWLIST;
  }

  allowlistIsDefault(): boolean {
    return this.config.get().cdnAllowlist === undefined;
  }

  onChange(fn: (c: TrustSettingsChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: TrustSettingsChange): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(c);
      } catch {
        // one listener never stops the others
      }
    }
  }

  /**
   * Adds a folder to a list (Settings › Trust › Add…). The folder is stored as its realpath. A trusted folder
   * is refused when it is the home folder, Desktop, Downloads, a mail or Messages attachment folder, a
   * temporary folder, a volume root, or contains one of them (refuseAsTrustedFolder, 6.10). The same folder
   * leaves the other list: a folder is either trusted or untrusted.
   */
  async addFolder(kind: FolderKind, folder: string): Promise<FolderResult> {
    const p = this.p;
    if (typeof folder !== 'string' || folder.length === 0 || folder.length > MAX_FOLDER_PATH || folder.includes('\0') || !p.isAbsolute(folder)) {
      return { ok: false, reason: 'That is not a folder path.' };
    }
    let real: string;
    try {
      // The OS's own realpath: on macOS and Windows it also gives the case stored on disk, which a trusted
      // folder is compared with exactly (folderFor).
      real = await (this.o.realpath ?? realpathNative)(folder);
      const st = await (this.o.stat ?? ((x: string) => fs.promises.stat(x)))(real);
      if (!st.isDirectory()) return { ok: false, reason: 'That is not a folder.' };
    } catch {
      return { ok: false, reason: 'That folder could not be found.' };
    }
    if (real.length > MAX_FOLDER_PATH) return { ok: false, reason: 'That folder’s path is too long.' };
    // config.json drops such a path when it is read (sanitizeFolderList), so it could not stay in the list: an
    // untrusted folder would silently stop protecting its files. Refuse it now, with the reason.
    if (/[\u0000-\u001f\u007f]/.test(real)) return { ok: false, reason: 'That folder’s path has control characters Blueline cannot store.' };
    if (kind === 'trusted') {
      const why = refuseAsTrustedFolder(real, this.o);
      if (why) return { ok: false, folder: real, reason: `${sentence(why)} cannot be a trusted folder.` };
    }
    const mine = kind === 'trusted' ? this.trustedFolders() : this.untrustedFolders();
    const other = kind === 'trusted' ? this.untrustedFolders() : this.trustedFolders();
    const existing = mine.find((f) => this.same(f, real));
    if (existing) return { ok: true, folder: existing };
    if (mine.length >= MAX_FOLDERS) return { ok: false, reason: `At most ${MAX_FOLDERS} folders.` };
    const nextMine = [...mine, real];
    const nextOther = other.filter((f) => !this.same(f, real));
    await this.config.update(kind === 'trusted' ? { trustedFolders: nextMine, untrustedFolders: nextOther } : { untrustedFolders: nextMine, trustedFolders: nextOther });
    this.emit('folders');
    return { ok: true, folder: real };
  }

  /** Removes a folder from a list. `folder` must be one of its entries, exactly. Returns whether it was there. */
  async removeFolder(kind: FolderKind, folder: string): Promise<boolean> {
    const list = kind === 'trusted' ? this.trustedFolders() : this.untrustedFolders();
    if (!list.includes(folder)) return false;
    const next = list.filter((f) => f !== folder);
    await this.config.update(kind === 'trusted' ? { trustedFolders: next } : { untrustedFolders: next });
    this.emit('folders');
    return true;
  }

  async setStrict(on: boolean): Promise<void> {
    if (this.strict() === on) return;
    await this.config.update({ strictProtected: on });
    this.emit('strict');
  }

  /**
   * Adds a host to the CDN allowlist. Hosts are normalized and checked (normalizeAllowlistHost): a plain DNS
   * name, no scheme, port, path or wildcard, no IP address and no localhost, because an allowlisted host goes
   * around the Protected proxy (9.9, finding 8).
   */
  async addAllowlistHost(host: string): Promise<HostResult> {
    const h = typeof host === 'string' ? normalizeAllowlistHost(host) : null;
    if (h === null) return { ok: false, reason: 'Enter a host name such as fonts.example.com: no scheme, port, path or wildcard. IP addresses and localhost cannot be allowed.' };
    const list = [...this.allowlist()];
    if (list.includes(h)) return { ok: true, host: h };
    if (list.length >= MAX_HOSTS) return { ok: false, reason: `At most ${MAX_HOSTS} hosts.` };
    await this.config.update({ cdnAllowlist: [...list, h] });
    this.emit('allowlist');
    return { ok: true, host: h };
  }

  async removeAllowlistHost(host: string): Promise<boolean> {
    const h = typeof host === 'string' ? normalizeAllowlistHost(host) : null;
    const list = [...this.allowlist()];
    if (h === null || !list.includes(h)) return false;
    await this.config.update({ cdnAllowlist: list.filter((x) => x !== h) });
    this.emit('allowlist');
    return true;
  }

  /** Back to the 9.9 list. */
  async resetAllowlist(): Promise<void> {
    if (this.allowlistIsDefault()) return;
    await this.config.update({ cdnAllowlist: null });
    this.emit('allowlist');
  }
}
