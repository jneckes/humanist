// <userData>/files/<fileKey>/history/ (9.7: "pre-write snapshots, newest 100 kept"; decision P2-11).
//
// Before every write of the deck (an edit, an undo, a redo, a restore) main saves the bytes the write is about
// to replace, in the write queue's beforeWrite hook (the mutation probe's queue has no hook, so `blueline map`
// writes no history). The history list shows each snapshot's time and cause, and "Restore deck to <time>" (9.2
// Undo and redo 4) reads one back and writes it through the queue. External changes can be recorded too (the
// content main knew before the change), so a restore can say how many later direct edits and external changes it
// discards (countSince).
//
// Layout and rules:
//   - index.json lists the snapshots, oldest first, and is replaced atomically on every change (atomic-write.ts);
//   - each distinct version is one file, `<sha256>.html`, named by the sha256 of its bytes: two snapshots of the
//     same bytes (an edit undone and redone) share one file, and a read checks the bytes against the name;
//   - every file is 0600 in a 0700 folder (app data is private);
//   - a snapshot of a Protected document carries the document's marker (9.9 Derived files keep the marker:
//     markers.ts markDerivedFile, on the temp file before the rename, so a snapshot that cannot be marked is
//     never written, and an unmarked copy of a Protected deck never opens Trusted from the Finder);
//   - the newest MAX_HISTORY_ENTRIES snapshots are kept, and their files may take MAX_HISTORY_BYTES at most: the
//     oldest go first, the newest is always kept (a single deck larger than the budget keeps one);
//   - the base (P2-12: the content of the last version main knew, so locked spans transform across restarts and
//     D-1 reopens) is kept apart from the list and never pruned.
//
// One store per folder in this process (forFile), so every window of a file, before and after a D-1 reopen,
// writes through the same serial chain.
//
// Lead decision E-11 (review finding 21): one entry per write that LANDED. The queue snapshots the bytes before
// every attempt (P2-11: no write without its snapshot), so such a snapshot is `pending`: its file and its entry are
// stored at once (index.json lists it, so a crash right after the write keeps it), but list, entry, countSince and
// findBySha256 see it only once settle(id, true) says its write landed; settle(id, false) removes it (a conflict
// requeued the write, it was refused, or it failed). An entry whose bytes are those of the newest entry is not
// added again (never two consecutive entries with the same sha256), so Restore's counts are exact.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile, readRegularFile, sha256Hex } from './atomic-write';
import { markDerivedFile, type DerivedMarkOptions, type DerivedSource } from './markers';

/** What replaced a snapshot's bytes. `edit`, `undo`, `redo` and `restore` are Blueline's own writes (direct). */
export type HistoryCause = 'edit' | 'undo' | 'redo' | 'restore' | 'external';
const CAUSES: readonly HistoryCause[] = ['edit', 'undo', 'redo', 'restore', 'external'];

/** One snapshot in the history list. */
export interface HistoryEntry {
  /** `h-<n>`, never reused in this folder. */
  id: string;
  /** sha256 of the snapshot's bytes (the whole file: the map `version`). */
  sha256: string;
  /** sha256 without the notes block (Session.deck.sha256; 6.8 matches a block's baseSha against history versions). */
  contentHash: string;
  /** The write that replaced these bytes. */
  cause: HistoryCause;
  /** The edit note of that write (edit, redo), when there is one. */
  noteId?: string;
  /** When the write happened (ISO time). */
  at: string;
  /** Size of the snapshot in bytes. */
  size: number;
}

export interface SnapshotMeta {
  /** sha256 of `bytes`; checked, so a snapshot is never stored under another version's name. */
  sha256: string;
  contentHash: string;
  cause: HistoryCause;
  noteId?: string;
  /** ISO time of the write. */
  at: string;
  /**
   * 9.9 Derived files keep the marker. Omit (undefined) for a Trusted document: no marker is written. For a
   * Protected document pass its marker (BlDocument.marker): the snapshot gets that marker, or, when it is null
   * (Protected by `--protected` or an untrusted folder), a new marker naming the document.
   */
  marker?: string | null;
}

/** The snapshots of 100 versions of a 2 MB deck fit; a larger deck keeps fewer. */
export const MAX_HISTORY_ENTRIES = 100;
/** Bytes the snapshot files of one document may take (the base included). */
export const MAX_HISTORY_BYTES = 256 * 1024 * 1024;
/** index.json larger than this is not read (100 entries take about 30 KB). */
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const INDEX = 'index.json';
const SHA256 = /^[0-9a-f]{64}$/;
const SNAPSHOT_FILE = /^([0-9a-f]{64})\.html$/;
const TEMP_FILE = /^\.bl-write-[0-9a-f]{16}\.tmp$/;
const ENTRY_ID = /^h-([0-9]{1,15})$/;
const NOTE_ID = /^(?:[a-z0-9-]{1,40}:)?n-[0-9]{4,6}$/;
const MAX_TIME = 64;

export interface HistoryOptions {
  /** The document's realpath: a snapshot of a Protected document without a marker gets one naming it. */
  realpath: string;
  maxEntries?: number;
  maxBytes?: number;
  /** Marks a snapshot's temp file (default markers.ts markDerivedFile; tests inject one). */
  mark?: (temp: string, source: DerivedSource, opts: DerivedMarkOptions) => Promise<void>;
  /** Passed to `mark` (platform, helper: tests). */
  markOptions?: DerivedMarkOptions;
  log?: (msg: string) => void;
}

interface StoredFile {
  size: number;
  /** The file carries a derived marker (9.9). */
  marked: boolean;
}

interface Base {
  sha256: string;
  contentHash: string;
  at: string;
}

interface IndexState {
  next: number;
  entries: HistoryEntry[];
  files: Map<string, StoredFile>;
  base: Base | null;
}

export function historyDirFor(userData: string, fileKey: string): string {
  if (!/^[0-9a-f]{16}$/.test(fileKey)) throw new Error('invalid fileKey');
  return path.join(userData, 'files', fileKey, 'history');
}

function errCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
}

function isTime(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_TIME && !/[\u0000-\u001f\u007f]/.test(v);
}

function ownField(o: Record<string, unknown>, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

/** Reads index.json field by field. Returns null when it cannot be read at all; drops entries it cannot read. */
export function readHistoryIndex(raw: unknown): IndexState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (ownField(r, 'version') !== 1) return null;
  const files = new Map<string, StoredFile>();
  const rawFiles = ownField(r, 'files');
  if (rawFiles && typeof rawFiles === 'object' && !Array.isArray(rawFiles)) {
    for (const k of Object.keys(rawFiles)) {
      const f = (rawFiles as Record<string, unknown>)[k];
      if (!SHA256.test(k) || !f || typeof f !== 'object' || Array.isArray(f)) continue;
      const size = ownField(f as Record<string, unknown>, 'size');
      const marked = ownField(f as Record<string, unknown>, 'marked');
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) continue;
      files.set(k, { size, marked: marked === true });
    }
  }
  const entries: HistoryEntry[] = [];
  const ids = new Set<string>();
  let maxId = 0;
  const rawEntries = ownField(r, 'entries');
  for (const e of Array.isArray(rawEntries) ? rawEntries : []) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const o = e as Record<string, unknown>;
    const id = ownField(o, 'id');
    const sha = ownField(o, 'sha256');
    const contentHash = ownField(o, 'contentHash');
    const cause = ownField(o, 'cause');
    const at = ownField(o, 'at');
    const noteId = ownField(o, 'noteId');
    const m = typeof id === 'string' ? ENTRY_ID.exec(id) : null;
    if (!m || ids.has(id as string)) continue;
    if (typeof sha !== 'string' || !SHA256.test(sha) || !files.has(sha)) continue;
    if (typeof contentHash !== 'string' || !SHA256.test(contentHash)) continue;
    if (typeof cause !== 'string' || !(CAUSES as readonly string[]).includes(cause)) continue;
    if (!isTime(at)) continue;
    if (noteId !== undefined && (typeof noteId !== 'string' || !NOTE_ID.test(noteId))) continue;
    const entry: HistoryEntry = { id: id as string, sha256: sha, contentHash, cause: cause as HistoryCause, at, size: files.get(sha)!.size };
    if (typeof noteId === 'string') entry.noteId = noteId;
    ids.add(entry.id);
    maxId = Math.max(maxId, Number(m[1]));
    entries.push(entry);
  }
  let base: Base | null = null;
  const rawBase = ownField(r, 'base');
  if (rawBase && typeof rawBase === 'object' && !Array.isArray(rawBase)) {
    const b = rawBase as Record<string, unknown>;
    const sha = ownField(b, 'sha256');
    const contentHash = ownField(b, 'contentHash');
    const at = ownField(b, 'at');
    if (typeof sha === 'string' && SHA256.test(sha) && files.has(sha) && typeof contentHash === 'string' && SHA256.test(contentHash) && isTime(at)) {
      base = { sha256: sha, contentHash, at };
    }
  }
  const next = ownField(r, 'next');
  return {
    next: typeof next === 'number' && Number.isSafeInteger(next) && next > maxId ? next : maxId + 1,
    entries,
    files,
    base,
  };
}

function serializeIndex(s: IndexState): Uint8Array {
  const files: Record<string, StoredFile> = {};
  for (const [k, f] of s.files) files[k] = { size: f.size, marked: f.marked };
  const out = {
    version: 1,
    next: s.next,
    base: s.base ? { sha256: s.base.sha256, contentHash: s.base.contentHash, at: s.base.at } : null,
    files,
    entries: s.entries.map((e) => {
      const o: Record<string, unknown> = { id: e.id, sha256: e.sha256, contentHash: e.contentHash, cause: e.cause, at: e.at };
      if (e.noteId !== undefined) o.noteId = e.noteId;
      return o;
    }),
  };
  return new TextEncoder().encode(JSON.stringify(out, null, 1) + '\n');
}

function cloneState(s: IndexState): IndexState {
  return { next: s.next, entries: s.entries.map((e) => ({ ...e })), files: new Map([...s.files].map(([k, f]) => [k, { ...f }])), base: s.base ? { ...s.base } : null };
}

function copyEntry(e: HistoryEntry): HistoryEntry {
  const c: HistoryEntry = { id: e.id, sha256: e.sha256, contentHash: e.contentHash, cause: e.cause, at: e.at, size: e.size };
  if (e.noteId !== undefined) c.noteId = e.noteId;
  return c;
}

/** The files still referenced by an entry or the base. */
function referenced(s: IndexState): Set<string> {
  const keep = new Set(s.entries.map((e) => e.sha256));
  if (s.base) keep.add(s.base.sha256);
  return keep;
}

function bytesOf(s: IndexState): number {
  let total = 0;
  for (const sha of referenced(s)) total += s.files.get(sha)?.size ?? 0;
  return total;
}

const stores = new Map<string, HistoryStore>();

/** One document's history folder. */
export class HistoryStore {
  private state: IndexState;
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;
  /** E-11: entries of snapshots whose write has not landed yet (in index.json; listed once settled). */
  private readonly unsettled = new Set<string>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  /**
   * The store of `<userData>/files/<fileKey>/history`, the same object for every caller in this process. The
   * options of the first call stay (the realpath is the same for one fileKey).
   */
  static forFile(userData: string, fileKey: string, opts: HistoryOptions): HistoryStore {
    const dir = path.resolve(historyDirFor(userData, fileKey));
    let s = stores.get(dir);
    if (!s) stores.set(dir, (s = new HistoryStore(dir, opts)));
    return s;
  }

  /** A store for `dir` outside the registry (tests, tools). */
  static at(dir: string, opts: HistoryOptions): HistoryStore {
    return new HistoryStore(path.resolve(dir), opts);
  }

  private constructor(
    readonly dir: string,
    private readonly opts: HistoryOptions,
  ) {
    if (typeof opts.realpath !== 'string' || !path.isAbsolute(opts.realpath)) throw new Error('HistoryStore: the realpath must be absolute');
    this.maxEntries = Math.max(1, opts.maxEntries ?? MAX_HISTORY_ENTRIES);
    this.maxBytes = Math.max(0, opts.maxBytes ?? MAX_HISTORY_BYTES);
    const loaded = this.load();
    this.state = loaded.state;
    // Files a crash left behind (a snapshot written whose index was not, a pruned file not yet deleted, a temp
    // file): swept once, unless the index could not be read (then nothing tells a kept file from a stray one).
    if (loaded.sweep) void this.enqueue(() => this.sweep());
  }

  private log(msg: string): void {
    this.opts.log?.(`history: ${msg}`);
  }

  /** Reads index.json at open (small, so synchronously: list() answers at once). */
  private load(): { state: IndexState; sweep: boolean } {
    const empty: IndexState = { next: 1, entries: [], files: new Map(), base: null };
    const file = path.join(this.dir, INDEX);
    let text: string;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_INDEX_BYTES) throw Object.assign(new Error('unreadable'), { code: 'EBADINDEX' });
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (errCode(e) === 'ENOENT') return { state: empty, sweep: true };
      this.keepAside(file);
      return { state: empty, sweep: false };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const s = readHistoryIndex(parsed);
    if (!s) {
      this.keepAside(file);
      return { state: empty, sweep: false };
    }
    // An entry whose file is gone (removed by hand, or a crash between a sweep and the index) cannot be restored.
    for (const sha of [...s.files.keys()]) {
      try {
        const st = fs.statSync(path.join(this.dir, `${sha}.html`));
        if (!st.isFile() || st.size !== s.files.get(sha)!.size) s.files.delete(sha);
      } catch {
        s.files.delete(sha);
      }
    }
    s.entries = s.entries.filter((e) => s.files.has(e.sha256));
    if (s.base && !s.files.has(s.base.sha256)) s.base = null;
    for (const sha of [...s.files.keys()]) if (!referenced(s).has(sha)) s.files.delete(sha);
    return { state: s, sweep: true };
  }

  private keepAside(file: string): void {
    const aside = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.copyFileSync(file, aside, fs.constants.COPYFILE_EXCL);
    } catch {
      // Nothing to keep, or it is kept already.
    }
    this.log('index.json could not be read; kept aside, the list starts empty');
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.pending++;
    const run = this.chain.then(job, job);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.pending--;
    });
  }

  /** Resolves when every snapshot, prune and sweep started so far has finished. */
  idle(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  /** A snapshot, prune or sweep is running or queued (the app's quit waits for these). */
  get busy(): boolean {
    return this.pending > 0;
  }

  /** The snapshots, newest first. */
  list(): HistoryEntry[] {
    return this.settled().map(copyEntry).reverse();
  }

  /** The entry with this id, or null. */
  entry(id: string): HistoryEntry | null {
    const e = this.settled().find((x) => x.id === id);
    return e ? copyEntry(e) : null;
  }

  /** The newest entry of these bytes, or null. */
  findBySha256(sha: string): HistoryEntry | null {
    const list = this.settled();
    for (let i = list.length - 1; i >= 0; i--) if (list[i].sha256 === sha) return copyEntry(list[i]);
    return null;
  }

  /** The base (P2-12): the content of the last version main knew, or null. */
  base(): Base | null {
    return this.state.base ? { ...this.state.base } : null;
  }

  /** Bytes the snapshot files take now. */
  totalBytes(): number {
    return bytesOf(this.state);
  }

  /**
   * 9.2 Undo and redo 4: what "Restore deck to <time>" discards. Restoring snapshot `id` undoes the write that
   * replaced it and every later one, so the count includes the entry itself: `direct` counts Blueline's own
   * writes (edit, undo, redo, restore), `external` the changes from outside Blueline that were recorded (an
   * agent's edits, in Phase 4). Null for an id not in the list.
   */
  countSince(id: string): { direct: number; external: number } | null {
    const list = this.settled();
    const i = list.findIndex((e) => e.id === id);
    if (i === -1) return null;
    let direct = 0;
    let external = 0;
    for (const e of list.slice(i)) {
      if (e.cause === 'external') external++;
      else direct++;
    }
    return { direct, external };
  }

  /**
   * Saves `bytes` (the deck as it is before a write of cause `m.cause`) and returns the new entry's id. The file
   * is written first (atomically, 0600, marked when the document is Protected), then the index; a failure
   * rejects and leaves the list as it was. Bytes already stored (the same sha256) are not written again, but a
   * file stored unmarked is marked when this snapshot needs a marker. Then the list is pruned.
   */
  snapshot(bytes: Uint8Array, m: SnapshotMeta, o: { pending?: boolean } = {}): Promise<string> {
    let meta: SnapshotMeta;
    try {
      meta = checkMeta(m);
    } catch (e) {
      return Promise.reject(e);
    }
    if (!(bytes instanceof Uint8Array)) return Promise.reject(new Error('history: bytes must be a Uint8Array'));
    if (sha256Hex(bytes) !== meta.sha256) return Promise.reject(new Error('history: the bytes do not have the sha256 given'));
    // Copied now: the caller may reuse its buffer while the snapshot waits its turn.
    const copy = new Uint8Array(bytes);
    return this.enqueue(async () => {
      const next = cloneState(this.state);
      await this.store(next, copy, meta.sha256, meta.marker);
      // E-11: the newest entry (a write that landed) already holds these bytes: nothing new to list (its file is kept,
      // and marked above when it must be).
      const newest = next.entries.length > 0 ? next.entries[next.entries.length - 1] : null;
      if (newest && !this.unsettled.has(newest.id) && newest.sha256 === meta.sha256) {
        if (next.files.get(meta.sha256)?.marked !== this.state.files.get(meta.sha256)?.marked) await this.commit(next);
        return newest.id;
      }
      const id = `h-${next.next}`;
      next.next++;
      const entry: HistoryEntry = { id, sha256: meta.sha256, contentHash: meta.contentHash, cause: meta.cause, at: meta.at, size: copy.byteLength };
      if (meta.noteId !== undefined) entry.noteId = meta.noteId;
      next.entries.push(entry);
      const dropped = this.pruneState(next);
      await this.commit(next);
      if (o.pending === true) this.unsettled.add(id);
      await this.removeFiles(dropped);
      return id;
    });
  }

  /**
   * E-11: the write a pending snapshot (snapshot with `pending`) was taken for landed (`landed`: the entry is listed
   * from now on) or did not (the entry goes, and its file when nothing else needs it). An id that is not pending
   * (already settled, or a snapshot that found its bytes already listed) is left alone.
   */
  settle(id: string, landed: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (!this.unsettled.delete(id)) return;
      if (landed) return;
      const next = cloneState(this.state);
      const i = next.entries.findIndex((e) => e.id === id);
      if (i === -1) return;
      next.entries.splice(i, 1);
      const dropped = this.pruneState(next);
      await this.commit(next);
      await this.removeFiles(dropped);
    });
  }

  /** Entries whose write landed (E-11), oldest first. */
  private settled(): HistoryEntry[] {
    return this.state.entries.filter((e) => !this.unsettled.has(e.id));
  }

  /**
   * P2-12: keeps `bytes` as the base, the content of the last version main knew, so locked spans can be diffed
   * from it after a restart or a D-1 reopen. Replaces the previous base; never pruned.
   */
  setBase(bytes: Uint8Array, m: { sha256: string; contentHash: string; at: string; marker?: string | null }): Promise<void> {
    if (typeof m?.sha256 !== 'string' || !SHA256.test(m.sha256) || typeof m.contentHash !== 'string' || !SHA256.test(m.contentHash) || !isTime(m.at)) {
      return Promise.reject(new Error('history: bad base'));
    }
    if (m.marker !== undefined && m.marker !== null && typeof m.marker !== 'string') return Promise.reject(new Error('history: bad marker'));
    if (!(bytes instanceof Uint8Array) || sha256Hex(bytes) !== m.sha256) return Promise.reject(new Error('history: the bytes do not have the sha256 given'));
    const copy = new Uint8Array(bytes);
    return this.enqueue(async () => {
      // Already the base, and marked if it must be: nothing to write.
      if (this.state.base?.sha256 === m.sha256 && (m.marker === undefined || this.state.files.get(m.sha256)?.marked === true)) return;
      const next = cloneState(this.state);
      await this.store(next, copy, m.sha256, m.marker);
      next.base = { sha256: m.sha256, contentHash: m.contentHash, at: m.at };
      const dropped = this.pruneState(next);
      await this.commit(next);
      await this.removeFiles(dropped);
    });
  }

  /** The bytes of snapshot `id`, checked against its sha256. Rejects when the id is unknown or the file damaged. */
  async read(id: string): Promise<Uint8Array> {
    const e = this.state.entries.find((x) => x.id === id);
    if (!e) throw new Error('history: no such snapshot');
    return this.readFile(e.sha256, e.size);
  }

  /** The stored bytes of version `sha` (a snapshot or the base), checked, or null when none is stored. */
  async readSha256(sha: string): Promise<Uint8Array | null> {
    if (typeof sha !== 'string' || !SHA256.test(sha)) return null;
    const f = this.state.files.get(sha);
    if (!f || !referenced(this.state).has(sha)) return null;
    try {
      return await this.readFile(sha, f.size);
    } catch (e) {
      this.log(`version ${sha.slice(0, 12)} not read: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private async readFile(sha: string, size: number): Promise<Uint8Array> {
    const bytes = await readRegularFile(path.join(this.dir, `${sha}.html`), size);
    // A restore writes these bytes into the user's deck: they must be exactly the version they claim to be.
    if (bytes.byteLength !== size || sha256Hex(bytes) !== sha) throw new Error('history: the snapshot file is damaged');
    return bytes;
  }

  /** Applies the limits now (they also apply after every snapshot). */
  prune(): Promise<void> {
    return this.enqueue(async () => {
      const next = cloneState(this.state);
      const dropped = this.pruneState(next);
      if (dropped.length === 0 && next.entries.length === this.state.entries.length) return;
      await this.commit(next);
      await this.removeFiles(dropped);
    });
  }

  /**
   * Drops the oldest entries past maxEntries, then past maxBytes (never the newest entry, never the base), and
   * the files no entry or base refers to any more. Returns the shas whose files to delete after the index lands.
   */
  private pruneState(s: IndexState): string[] {
    while (s.entries.length > this.maxEntries) s.entries.shift();
    while (s.entries.length > 1 && bytesOf(s) > this.maxBytes) s.entries.shift();
    const keep = referenced(s);
    const dropped: string[] = [];
    for (const sha of [...s.files.keys()]) {
      if (!keep.has(sha)) {
        s.files.delete(sha);
        dropped.push(sha);
      }
    }
    return dropped;
  }

  /** Writes `<sha>.html` unless it is stored (and marked when it must be); records it in `s.files`. */
  private async store(s: IndexState, bytes: Uint8Array, sha: string, marker: string | null | undefined): Promise<void> {
    const wantMark = marker !== undefined;
    const known = s.files.get(sha);
    const file = path.join(this.dir, `${sha}.html`);
    if (known && (!wantMark || known.marked)) {
      try {
        const st = await fs.promises.stat(file);
        if (st.isFile() && st.size === known.size) return;
      } catch {
        // Gone: written again below.
      }
    }
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const source: DerivedSource = { realpath: this.opts.realpath, marker: marker ?? null, protectedView: true };
    const mark = this.opts.mark ?? markDerivedFile;
    await atomicWriteFile(file, bytes, {
      newFileMode: 0o600,
      prepareTemp: wantMark ? (temp) => mark(temp, source, this.opts.markOptions ?? {}) : undefined,
    });
    // The file was written now: it carries a marker exactly when this write put one there.
    s.files.set(sha, { size: bytes.byteLength, marked: wantMark });
  }

  private async commit(next: IndexState): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(path.join(this.dir, INDEX), serializeIndex(next), { newFileMode: 0o600 });
    this.state = next;
  }

  private async removeFiles(shas: readonly string[]): Promise<void> {
    for (const sha of shas) {
      if (this.state.files.has(sha)) continue;
      await fs.promises.unlink(path.join(this.dir, `${sha}.html`)).catch((e: unknown) => {
        if (errCode(e) !== 'ENOENT') this.log(`${sha.slice(0, 12)} not removed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }

  /** Deletes snapshot files the index does not list and leftover temp files (only names this store makes). */
  private async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return;
    }
    const keep = referenced(this.state);
    for (const name of names) {
      const m = SNAPSHOT_FILE.exec(name);
      const stray = (m && !keep.has(m[1])) || TEMP_FILE.test(name);
      if (!stray) continue;
      try {
        const st = await fs.promises.lstat(path.join(this.dir, name));
        if (!st.isFile()) continue;
        await fs.promises.unlink(path.join(this.dir, name));
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  }
}

function checkMeta(m: SnapshotMeta): SnapshotMeta {
  if (!m || typeof m !== 'object') throw new Error('history: no metadata');
  if (typeof m.sha256 !== 'string' || !SHA256.test(m.sha256)) throw new Error('history: bad sha256');
  if (typeof m.contentHash !== 'string' || !SHA256.test(m.contentHash)) throw new Error('history: bad contentHash');
  if (!CAUSES.includes(m.cause)) throw new Error('history: bad cause');
  if (!isTime(m.at)) throw new Error('history: bad time');
  if (m.noteId !== undefined && (typeof m.noteId !== 'string' || !NOTE_ID.test(m.noteId))) throw new Error('history: bad note id');
  if (m.marker !== undefined && m.marker !== null && typeof m.marker !== 'string') throw new Error('history: bad marker');
  const out: SnapshotMeta = { sha256: m.sha256, contentHash: m.contentHash, cause: m.cause, at: m.at };
  if (m.noteId !== undefined) out.noteId = m.noteId;
  if (m.marker !== undefined) out.marker = m.marker;
  return out;
}
