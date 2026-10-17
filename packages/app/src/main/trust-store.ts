// <userData>/trust.json (9.7; 6.10 What changes; 6.8 Received or yours): per-file trust decisions, keyed by
// the file's realpath (as returned, never case-folded), each with the internet marker it was made on.
//
//   { "version": 1,
//     "files": { "<realpath>": { "marker": "<whole marker>" | null, "allowNetwork": bool, "editing": bool,
//                                "received": bool, "at": "<ISO time>" } } }
//
// - A decision applies only while the file carries the same marker: on macOS the whole com.apple.quarantine
//   value (it carries a per-download time and event id), on Windows the whole Zone.Identifier contents, null
//   for no marker. A new download saved over the same path brings a new marker, so get() drops the old
//   decision (and removes it from the file) and the file opens Protected again (6.10). Blueline's own writes
//   keep the marker (9.9), so they never reset trust.
// - The file is app data that only Blueline writes, but it decides trust, so it is read defensively: a file
//   that is too large, not JSON or not an object is ignored as a whole; an entry with a bad field is ignored
//   (never trusted); unknown fields, top-level and per entry, are kept on rewrite (a newer version may have
//   added them).
// - Writes are atomic, one at a time, latest state wins (CoalescingWriter), with mode 0600.
// - "Continue the review" (9.7 Moved files) moves notes, never trust (9.9): nothing here moves a decision
//   from one path to another.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoalescingWriter } from './atomic-write';
import { MAX_MARKER_BYTES } from './native-helper';

export interface RememberedTrust {
  /** The marker the decision was made on (the whole value), or null when the file had none. */
  marker: string | null;
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
/** The whole file: far more than 10,000 entries with Windows-sized markers would ever need. */
export const MAX_TRUST_BYTES = 8 * 1024 * 1024;
/** Entries kept; past this the oldest (by `at`) are dropped, so the file cannot grow without bound. */
export const MAX_TRUST_ENTRIES = 10_000;
/** A realpath key (PATH_MAX is 1024 on macOS, 4096 on Linux; Windows long paths stay under 32,767). */
const MAX_PATH = 32_767;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const KNOWN = new Set(['marker', 'allowNetwork', 'editing', 'received', 'at']);
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

/** An entry read from the file, rebuilt field by field, or null when any known field is wrong. */
export function sanitizeEntry(v: unknown): { trust: RememberedTrust; extra: Record<string, unknown> } | null {
  if (!isPlainObject(v)) return null;
  const own = (k: string): unknown => (Object.prototype.hasOwnProperty.call(v, k) ? v[k] : undefined);
  const marker = own('marker');
  const allowNetwork = own('allowNetwork');
  const editing = own('editing');
  const received = own('received');
  const at = own('at');
  if (!validMarker(marker)) return null;
  if (typeof allowNetwork !== 'boolean' || typeof editing !== 'boolean' || typeof received !== 'boolean') return null;
  if (typeof at !== 'string' || at.length > 40 || !ISO.test(at)) return null;
  const extra: Record<string, unknown> = {};
  for (const k of Object.keys(v)) if (!KNOWN.has(k) && !POISON.has(k)) extra[k] = v[k];
  return { trust: { marker, allowNetwork, editing, received, at }, extra };
}

interface Entry {
  trust: RememberedTrust;
  extra: Record<string, unknown>;
}

export class TrustStore {
  private entries = new Map<string, Entry>();
  /** Top-level fields other than `version` and `files`, kept as they were. */
  private extraTop: Record<string, unknown> = {};
  private readonly writer: CoalescingWriter;

  constructor(
    readonly file: string,
    onWriteError: (e: Error) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.writer = new CoalescingWriter(file, (e) => {
      if (e) onWriteError(e);
    });
  }

  static forUserData(userData: string, onWriteError?: (e: Error) => void): TrustStore {
    return new TrustStore(path.join(userData, TRUST_FILE), onWriteError);
  }

  /**
   * Reads the file. A missing, oversized or malformed file reads as empty: no decision is remembered, so every
   * marked file opens Protected (when unsure, refuse). It is rewritten on the next change.
   */
  load(): this {
    this.entries = new Map();
    this.extraTop = {};
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
   * value; null equals null). A decision made on another marker is dropped and removed from the file: the file
   * is a new download (6.10). Call it only with a marker that was read: when the marker could not be read,
   * there is nothing to compare, and no decision applies (folders.ts resolveOpenTrust).
   */
  get(realpath: string, currentMarker: string | null): RememberedTrust | null {
    const e = this.entries.get(realpath);
    if (!e) return null;
    if (e.trust.marker !== currentMarker) {
      this.entries.delete(realpath);
      void this.flush();
      return null;
    }
    return { ...e.trust };
  }

  /** Remembers a decision for `realpath` (Allow network, Enable editing, received or yours). */
  set(realpath: string, d: Omit<RememberedTrust, 'at'> & { at?: string }): Promise<void> {
    if (!validKey(realpath)) return Promise.reject(new Error('trust.json: not an absolute path'));
    const at = d.at ?? this.now().toISOString();
    const built = sanitizeEntry({ marker: d.marker, allowNetwork: d.allowNetwork, editing: d.editing, received: d.received, at });
    if (!built) return Promise.reject(new Error('trust.json: invalid decision'));
    const old = this.entries.get(realpath);
    // Unknown fields survive a change of the known ones, but not a change of marker (that is a new file).
    const extra = old && old.trust.marker === built.trust.marker ? old.extra : {};
    this.entries.delete(realpath);
    this.entries.set(realpath, { trust: built.trust, extra });
    this.trim();
    return this.flush();
  }

  /**
   * Turns switches on or off for `realpath` and the marker it carries now, keeping the others: the trust
   * bar's **Allow network** and **Enable editing** (6.10), and the file name's received/yours switch (6.8). A
   * decision made on another marker is replaced, not merged. A new decision starts received: the trust bar is
   * shown only in Protected view, so a file whose switch is pressed opened Protected (6.8).
   */
  remember(realpath: string, marker: string | null, change: Partial<Pick<RememberedTrust, 'allowNetwork' | 'editing' | 'received'>>): Promise<void> {
    const e = this.entries.get(realpath);
    const base = e && e.trust.marker === marker ? e.trust : { marker, allowNetwork: false, editing: false, received: true };
    return this.set(realpath, {
      marker,
      allowNetwork: change.allowNetwork ?? base.allowNetwork,
      editing: change.editing ?? base.editing,
      received: change.received ?? base.received,
    });
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

  /** Drops the oldest entries past MAX_TRUST_ENTRIES. */
  private trim(): void {
    if (this.entries.size <= MAX_TRUST_ENTRIES) return;
    const byAge = [...this.entries].sort((a, b) => (a[1].trust.at < b[1].trust.at ? -1 : a[1].trust.at > b[1].trust.at ? 1 : 0));
    for (const [k] of byAge.slice(0, this.entries.size - MAX_TRUST_ENTRIES)) this.entries.delete(k);
  }

  private flush(): Promise<void> {
    return this.writer.schedule(() => {
      const files: Record<string, unknown> = {};
      for (const [k, e] of this.entries) files[k] = { ...e.extra, ...e.trust };
      const out: Record<string, unknown> = { ...this.extraTop, version: VERSION, files };
      return new TextEncoder().encode(JSON.stringify(out, null, 2) + '\n');
    });
  }
}
