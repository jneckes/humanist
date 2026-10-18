// <userData>/trust.json (9.7; 6.10 What changes; 6.8 Received or yours): per-file trust decisions, keyed by
// the file's realpath (as returned, never case-folded), each with the internet marker it was made on and, where
// the marker cannot tell two files apart, the identity of the file it was made on.
//
//   { "version": 1,
//     "files": { "<realpath>": { "marker": "<whole marker>" | null,
//                                "identity": { "dev": "<n>", "ino": "<n>", "birth": "<ns>" },
//                                "allowNetwork": bool, "editing": bool, "received": bool, "at": "<ISO time>" } } }
//
// - A decision applies only while the file carries the same marker: on macOS the whole com.apple.quarantine
//   value (it carries a per-download time and event id), on Windows the whole Zone.Identifier contents, null
//   for no marker. A new download saved over the same path brings a new marker, so get() drops the old
//   decision (and removes it from the file) and the file opens Protected again (6.10).
// - Where the marker alone cannot tell the file from a later one at the same path (bindsToFile), the decision is
//   also bound to the file's identity, and applies only while the file at the path is that same file: with no
//   marker (a file Protected because it is in an untrusted folder), and on Windows, where the Zone.Identifier text
//   has no time or id (every download of the same link, and every Outlook attachment, carries the same text). The
//   identity is fs.stat's dev and ino (bigint: a 64-bit NTFS file ID, whose sequence number changes when its
//   record is reused, is exact) and the birth time where the file system has one: ext4 hands a freed inode number
//   to the next new file at once (measured: a temp file renamed over the path got the previous file's number 199
//   times in 200), and the birth time tells those apart. A browser, mail or sync client that saves a new file puts
//   a new file (a new identity) at the path, so the decision is dropped as for a new marker (6.10 "A different
//   copy of the file starts from its own marker"). The identity is read when the decision is recorded: at the
//   first Protected open (folders.ts resolveOpenTrust), so a switch pressed later binds to the file the user saw.
//   The limit: a program that writes over the file in place (rather than saving a new file) keeps the file's
//   identity, and on Windows writes the same Zone.Identifier text again, so such a file keeps the decision.
// - Blueline's own writes keep the marker (9.9), so they never reset trust (6.10). Its atomic write puts a new
//   file at the path, so a decision bound to the file it replaced moves to the new file (rebindAfterOwnWrite,
//   called by documents.ts after every write of the app's documents).
// - The file is app data that only Blueline writes, but it decides trust, so it is read defensively: a file
//   that is too large, not JSON or not an object is ignored as a whole; an entry with a bad field is ignored
//   (never trusted); unknown fields, top-level and per entry, are kept on rewrite (a newer version may have
//   added them). Blueline never writes a file its next launch would ignore: the oldest decisions are dropped
//   until the file fits (trimToSize).
// - Writes are atomic, one at a time, latest state wins (CoalescingWriter), with mode 0600.
// - "Continue the review" (9.7 Moved files) moves notes, never trust (9.9): nothing here moves a decision
//   from one path to another.
// - `blueline pdf` and `blueline map` use an in-memory store (inMemory, command-trust.ts) that never reads or
//   writes trust.json: remembered decisions never apply to a command.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoalescingWriter } from './atomic-write';
import { MAX_MARKER_BYTES } from './native-helper';

/** A file's identity: fs.stat's device and file number (bigint), and its birth time in ns, as decimal strings. */
export interface FileIdentity {
  dev: string;
  ino: string;
  /** Absent where the file system keeps no birth time (fs.stat reports 0). */
  birth?: string;
}

export interface RememberedTrust {
  /** The marker the decision was made on (the whole value), or null when the file had none. */
  marker: string | null;
  /**
   * The file the decision was made on, where the marker cannot tell it from a later file at the same path
   * (bindsToFile); absent otherwise. A decision that should have one and has none applies to no file.
   */
  identity?: FileIdentity;
  /** **Allow network** was pressed for this file (6.10). */
  allowNetwork: boolean;
  /** **Enable editing** was pressed for this file (6.10). */
  editing: boolean;
  /** 6.8: the file is received (first opened Protected, or the user switched it), not the user's own. */
  received: boolean;
  /** When the decision was made or last changed (ISO 8601). */
  at: string;
}

export const TRUST_FILE = 'trust.json';
const VERSION = 1;
/**
 * The whole file: a larger one is ignored when it is read. Entries can be up to MAX_MARKER_BYTES each (a long
 * Zone.Identifier HostUrl), so the entry count alone does not keep the file under it: writes also trim by size.
 */
export const MAX_TRUST_BYTES = 8 * 1024 * 1024;
/** What a write may use: the oldest decisions are dropped until the file fits, with 1 MiB to spare. */
export const TRUST_WRITE_BUDGET = MAX_TRUST_BYTES - 1024 * 1024;
/** Entries kept; past this the oldest (by `at`) are dropped, so the file cannot grow without bound. */
export const MAX_TRUST_ENTRIES = 10_000;
/** A realpath key (PATH_MAX is 1024 on macOS, 4096 on Linux; Windows long paths stay under 32,767). */
const MAX_PATH = 32_767;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const KNOWN = new Set(['marker', 'identity', 'allowNetwork', 'editing', 'received', 'at']);
const POISON = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function validKey(k: string): boolean {
  return k.length > 0 && k.length <= MAX_PATH && !k.includes('\0') && (path.posix.isAbsolute(k) || path.win32.isAbsolute(k)) && !POISON.has(k);
}

/** A marker as trust.json may hold it: null, or a string of at most MAX_MARKER_BYTES UTF-8 bytes. */
function validMarker(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && v.length > 0 && Buffer.byteLength(v, 'utf8') <= MAX_MARKER_BYTES);
}

const DIGITS = /^[0-9]{1,40}$/;

/** An identity as trust.json may hold it (rebuilt: dev, ino and an optional birth, decimal strings), or null. */
function sanitizeIdentity(v: unknown): FileIdentity | null {
  if (!isPlainObject(v)) return null;
  const own = (k: string): unknown => (Object.prototype.hasOwnProperty.call(v, k) ? v[k] : undefined);
  const dev = own('dev');
  const ino = own('ino');
  const birth = own('birth');
  if (typeof dev !== 'string' || typeof ino !== 'string' || !DIGITS.test(dev) || !DIGITS.test(ino) || /^0+$/.test(ino)) return null;
  if (birth !== undefined && (typeof birth !== 'string' || !DIGITS.test(birth) || /^0+$/.test(birth))) return null;
  return birth === undefined ? { dev, ino } : { dev, ino, birth };
}

/** The same file: same device, file number and birth time (both without one counts as the same). */
export function sameIdentity(a: FileIdentity | null | undefined, b: FileIdentity | null | undefined): boolean {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino && (a.birth ?? '') === (b.birth ?? '');
}

/**
 * Whether a decision made on `marker` must also be bound to the file's identity (6.10: "A different copy of the
 * file starts from its own marker"). With no marker there is nothing that tells two files at the path apart. On
 * Windows the Zone.Identifier text has no time or id: two downloads of the same link, and any two Outlook
 * attachments, carry the same text. On macOS the quarantine value carries a per-download time and event id, so
 * it binds the decision by itself.
 */
export function bindsToFile(marker: string | null, platform: NodeJS.Platform): boolean {
  return marker === null || platform === 'win32';
}

/**
 * The identity of the file at `p` (fs.stat with bigint, so a 64-bit NTFS file ID and a ns birth time are exact),
 * or null when it cannot be read or is not a regular file. A file system that numbers no files (ino 0, as FAT can
 * report) has no identity: a decision there cannot be bound to the file, so it is not remembered.
 */
export async function readFileIdentity(p: string): Promise<FileIdentity | null> {
  try {
    const st = await fs.promises.stat(p, { bigint: true });
    if (!st.isFile()) return null;
    return sanitizeIdentity({ dev: st.dev.toString(), ino: st.ino.toString(), ...(st.birthtimeNs > 0n ? { birth: st.birthtimeNs.toString() } : {}) });
  } catch {
    return null;
  }
}

/** An entry read from the file, rebuilt field by field, or null when any known field is wrong. */
export function sanitizeEntry(v: unknown): { trust: RememberedTrust; extra: Record<string, unknown> } | null {
  if (!isPlainObject(v)) return null;
  const own = (k: string): unknown => (Object.prototype.hasOwnProperty.call(v, k) ? v[k] : undefined);
  const marker = own('marker');
  const allowNetwork = own('allowNetwork');
  const editing = own('editing');
  const received = own('received');
  const at = own('at');
  const rawIdentity = own('identity');
  if (!validMarker(marker)) return null;
  const identity = rawIdentity === undefined ? undefined : sanitizeIdentity(rawIdentity);
  if (identity === null) return null;
  if (typeof allowNetwork !== 'boolean' || typeof editing !== 'boolean' || typeof received !== 'boolean') return null;
  if (typeof at !== 'string' || at.length > 40 || !ISO.test(at)) return null;
  const extra: Record<string, unknown> = {};
  for (const k of Object.keys(v)) if (!KNOWN.has(k) && !POISON.has(k)) extra[k] = v[k];
  return { trust: { marker, ...(identity ? { identity } : {}), allowNetwork, editing, received, at }, extra };
}

interface Entry {
  trust: RememberedTrust;
  extra: Record<string, unknown>;
}

export interface TrustStoreOptions {
  /** Which platform's marker rules apply (bindsToFile). Default process.platform. */
  platform?: NodeJS.Platform;
  /** Reads a file's identity (default readFileIdentity). */
  identityOf?: (p: string) => Promise<FileIdentity | null>;
}

/** The app's own store (forUserData): Blueline's writes of a document re-bind its decision there. */
let appStore: TrustStore | null = null;

export class TrustStore {
  private entries = new Map<string, Entry>();
  /** Top-level fields other than `version` and `files`, kept as they were. */
  private extraTop: Record<string, unknown> = {};
  private readonly writer: CoalescingWriter;
  private persist = true;
  readonly platform: NodeJS.Platform;
  private readonly identityOf: (p: string) => Promise<FileIdentity | null>;

  constructor(
    readonly file: string,
    onWriteError: (e: Error) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
    opts: TrustStoreOptions = {},
  ) {
    this.writer = new CoalescingWriter(file, (e) => {
      if (e) onWriteError(e);
    });
    this.platform = opts.platform ?? process.platform;
    this.identityOf = opts.identityOf ?? readFileIdentity;
  }

  /** The app's store, `<userData>/trust.json` (index.ts). Blueline's own writes re-bind through it (rebindAfterOwnWrite). */
  static forUserData(userData: string, onWriteError?: (e: Error) => void): TrustStore {
    const s = new TrustStore(path.join(userData, TRUST_FILE), onWriteError);
    appStore = s;
    return s;
  }

  /**
   * A store that never reads or writes trust.json: `blueline pdf` and `blueline map` decide trust as the app does,
   * but no remembered decision ever applies to them (the stricter direction), and they never change the file.
   */
  static inMemory(opts: TrustStoreOptions = {}): TrustStore {
    const s = new TrustStore('', undefined, undefined, opts);
    s.persist = false;
    return s;
  }

  /**
   * Reads the file. A missing, oversized or malformed file reads as empty: no decision is remembered, so every
   * marked file opens Protected (when unsure, refuse). It is rewritten on the next change.
   */
  load(): this {
    this.entries = new Map();
    this.extraTop = {};
    if (!this.persist) return this;
    let parsed: unknown;
    try {
      const st = fs.statSync(this.file);
      if (!st.isFile() || st.size > MAX_TRUST_BYTES) return this;
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return this;
    }
    if (!isPlainObject(parsed)) return this;
    const files = Object.prototype.hasOwnProperty.call(parsed, 'files') ? parsed.files : undefined;
    if (files !== undefined && !isPlainObject(files)) return this;
    for (const k of Object.keys(parsed)) if (k !== 'version' && k !== 'files' && !POISON.has(k)) this.extraTop[k] = parsed[k];
    if (!files) return this;
    for (const key of Object.keys(files)) {
      if (!validKey(key)) continue;
      const e = sanitizeEntry(files[key]);
      if (e) this.entries.set(key, e);
    }
    this.trim();
    return this;
  }

  /**
   * The decision remembered for `realpath`, if it was made on `currentMarker` (exact equality of the whole
   * value) and, where the marker cannot tell two files apart (bindsToFile), on the file whose identity is
   * `current.identity`. A decision made on another marker or another file is dropped and removed from the file:
   * the file is a new download or a new copy (6.10). Call it only with a marker that was read, and with the
   * identity read when it is needed: when either could not be read there is nothing to compare, so no decision
   * applies and none is dropped (folders.ts resolveOpenTrust).
   */
  get(realpath: string, currentMarker: string | null, current: { identity?: FileIdentity | null; platform?: NodeJS.Platform } = {}): RememberedTrust | null {
    const e = this.entries.get(realpath);
    if (!e) return null;
    const bound = bindsToFile(currentMarker, current.platform ?? this.platform);
    if (e.trust.marker === currentMarker && bound && !current.identity) return null;
    if (e.trust.marker !== currentMarker || (bound && !sameIdentity(e.trust.identity, current.identity))) {
      this.entries.delete(realpath);
      void this.flush();
      return null;
    }
    return copyTrust(e.trust);
  }

  /** Remembers a decision for `realpath` (Allow network, Enable editing, received or yours). */
  set(realpath: string, d: Omit<RememberedTrust, 'at'> & { at?: string }): Promise<void> {
    if (!validKey(realpath)) return Promise.reject(new Error('trust.json: not an absolute path'));
    const at = d.at ?? this.now().toISOString();
    const built = sanitizeEntry({ marker: d.marker, ...(d.identity ? { identity: d.identity } : {}), allowNetwork: d.allowNetwork, editing: d.editing, received: d.received, at });
    if (!built) return Promise.reject(new Error('trust.json: invalid decision'));
    const old = this.entries.get(realpath);
    // Unknown fields survive a change of the known ones, but not a change of marker or file (that is a new file).
    const sameFile = old && old.trust.marker === built.trust.marker && (old.trust.identity === undefined ? built.trust.identity === undefined : sameIdentity(old.trust.identity, built.trust.identity));
    const extra = old && sameFile ? old.extra : {};
    this.entries.delete(realpath);
    this.entries.set(realpath, { trust: built.trust, extra });
    this.trim();
    return this.flush();
  }

  /**
   * Turns switches on or off for `realpath` and the marker it carries now, keeping the others: the trust
   * bar's **Allow network** and **Enable editing** (6.10), and the file name's received/yours switch (6.8). A
   * decision made on another marker (or another file) is replaced, not merged. A new decision starts received:
   * the trust bar is shown only in Protected view, so a file whose switch is pressed opened Protected (6.8).
   *
   * Where the decision is bound to the file (bindsToFile), it is bound to the file the user saw: the identity
   * recorded when the file opened (resolveOpenTrust records it at the first Protected open), else the file at
   * the path now. When no identity can be read, nothing is remembered (the promise rejects with the reason): the
   * switch then applies to this window only, as for a marker that could not be read.
   */
  async remember(realpath: string, marker: string | null, change: Partial<Pick<RememberedTrust, 'allowNetwork' | 'editing' | 'received'>>): Promise<void> {
    let identity: FileIdentity | undefined;
    if (bindsToFile(marker, this.platform)) {
      const seen = this.entries.get(realpath);
      identity = (seen && seen.trust.marker === marker ? seen.trust.identity : undefined) ?? (await this.identityOf(realpath)) ?? undefined;
      if (!identity) throw new Error(`${path.basename(realpath)} cannot be told apart from another file saved at its path, so the decision applies to this window only`);
    }
    const e = this.entries.get(realpath);
    const sameFile = e && e.trust.marker === marker && (identity === undefined || sameIdentity(e.trust.identity, identity));
    const base = sameFile ? e.trust : { allowNetwork: false, editing: false, received: true };
    return this.set(realpath, {
      marker,
      identity,
      allowNetwork: change.allowNetwork ?? base.allowNetwork,
      editing: change.editing ?? base.editing,
      received: change.received ?? base.received,
    });
  }

  /**
   * Blueline wrote the file at `realpath` itself (an atomic write puts a new file there): a decision bound to
   * the file it replaced, `from`, now belongs to the new file, `to` (6.10: Blueline's own writes never reset
   * trust). A decision bound to any other file is left as it is (it no longer applies anyway). `at` is kept: no
   * decision was made.
   */
  rebind(realpath: string, from: FileIdentity, to: FileIdentity): Promise<void> {
    const e = this.entries.get(realpath);
    if (!e || !sameIdentity(e.trust.identity, from) || sameIdentity(from, to)) return this.idle();
    const next = sanitizeIdentity(to);
    if (!next) return this.idle();
    this.entries.set(realpath, { trust: { ...e.trust, identity: next }, extra: e.extra });
    return this.flush();
  }

  /** rebind() with the identity of the file now at `realpath`, after Blueline's own write over `before`. */
  async rebindAfterWrite(realpath: string, before: FileIdentity | null): Promise<void> {
    if (!before || !this.entries.get(realpath)?.trust.identity) return;
    const after = await this.identityOf(realpath);
    if (after) await this.rebind(realpath, before, after);
  }

  /** Forgets the decision for `realpath`. */
  clear(realpath: string): Promise<void> {
    if (!this.entries.delete(realpath)) return this.writer.idle();
    return this.flush();
  }

  /** How many decisions are remembered (tests, Diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  idle(): Promise<void> {
    return this.writer.idle();
  }

  get busy(): boolean {
    return this.writer.busy;
  }

  /** The entries, oldest first (by `at`). */
  private byAge(): [string, Entry][] {
    return [...this.entries].sort((a, b) => (a[1].trust.at < b[1].trust.at ? -1 : a[1].trust.at > b[1].trust.at ? 1 : 0));
  }

  /** Drops the oldest entries past MAX_TRUST_ENTRIES. */
  private trim(): void {
    if (this.entries.size <= MAX_TRUST_ENTRIES) return;
    for (const [k] of this.byAge().slice(0, this.entries.size - MAX_TRUST_ENTRIES)) this.entries.delete(k);
  }

  private serialize(): Uint8Array {
    const files: Record<string, unknown> = {};
    for (const [k, e] of this.entries) files[k] = { ...e.extra, ...e.trust };
    const out: Record<string, unknown> = { ...this.extraTop, version: VERSION, files };
    return new TextEncoder().encode(JSON.stringify(out, null, 2) + '\n');
  }

  /**
   * The file as it will be written, at most TRUST_WRITE_BUDGET bytes: past it the oldest decisions are dropped
   * (from memory too) until it fits, so the next launch never ignores the whole file (load() refuses a file
   * over MAX_TRUST_BYTES). Unknown top-level fields go only if they alone would not fit.
   */
  private trimToSize(): Uint8Array {
    let bytes = this.serialize();
    while (bytes.byteLength > TRUST_WRITE_BUDGET && this.entries.size > 0) {
      // Drop at least the excess, measured per entry (its key, its fields, and the indentation they get).
      let excess = bytes.byteLength - TRUST_WRITE_BUDGET;
      for (const [k, e] of this.byAge()) {
        if (excess <= 0) break;
        excess -= Buffer.byteLength(JSON.stringify(k), 'utf8') + Buffer.byteLength(JSON.stringify({ ...e.extra, ...e.trust }, null, 2), 'utf8');
        this.entries.delete(k);
      }
      bytes = this.serialize();
    }
    if (bytes.byteLength > TRUST_WRITE_BUDGET) {
      this.extraTop = {};
      bytes = this.serialize();
    }
    return bytes;
  }

  private flush(): Promise<void> {
    if (!this.persist) return Promise.resolve();
    return this.writer.schedule(() => this.trimToSize());
  }
}

function copyTrust(t: RememberedTrust): RememberedTrust {
  return { ...t, ...(t.identity ? { identity: { ...t.identity } } : {}) };
}

/**
 * documents.ts calls this after each of Blueline's own writes of a document (DeckIO.atomicWrite), with the
 * identity of the file the write replaced: the app's store re-binds a decision bound to that file to the new
 * one (TrustStore.rebindAfterWrite). Nothing happens outside the app (no store) or for a decision on a marker
 * that binds by itself.
 */
export async function rebindAfterOwnWrite(realpath: string, before: FileIdentity | null): Promise<void> {
  await appStore?.rebindAfterWrite(realpath, before).catch(() => undefined);
}
