// The deck file watcher (9.2 Watcher; 6.6 Reload when the file changes on disk; 6.1 Auto-reload).
//
// 1. What to watch: fs.watch on the deck's directory, keeping events for the deck's basename or a null
//    filename, with a stat poll (device, inode, size, mtime) every second as a backstop. Never the file
//    itself: on Linux and macOS that watch follows the inode and goes silent after the first rename-replace
//    (vim, VS Code, Claude's Write tool and Blueline's own atomic write all save that way).
// 2. Settle first: an event starts a 150 ms wait (each further event restarts it, for at most 1 s, so a burst
//    of events gives one check); then the file is read twice, 50 ms apart, and only two reads that agree are
//    acted on, so a half-written file is never mapped. Two reads that disagree wait for the next settle.
// 3. Decide: equal to knownHash, nothing happens (Blueline's own writes call setKnownHash first, so they never
//    reload; P2-2: the holder also names an own write renamed in but not yet taken). Otherwise the change is
//    external: knownHash becomes the new hash and onExternalChange(bytes, version) runs; the caller rebuilds the
//    map, transforms the locked spans (edit-session.ts) and reloads the view.
//
// A file that is missing on two looks 150 ms apart is gone (deleted, or renamed away): onGone. When a file
// appears at the path again, onBack, and then the usual decision on its content. The watcher reads by path,
// so a file replaced by another inode (an atomic replace) is simply the new content. Reads go through an
// open descriptor (O_NONBLOCK, fstat, regular files only), and the path is stat'ed once more after the
// second read: a decision is made only on bytes that are still what the path holds, so a write that lands
// while the watcher reads is seen as the next change, never decided against a stale knownHash.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256Hex } from './atomic-write';

/** A file's identity and version as stat reports it: device, inode, size and mtime (ns), as strings. */
export interface FileSig {
  dev: string;
  ino: string;
  size: string;
  mtime: string;
}

export interface WatchHandle {
  close(): void;
  on(event: 'error', listener: (e: Error) => void): unknown;
}

/** The file system calls the watcher makes (node:fs by default; tests inject fakes). */
export interface WatchFs {
  /** fs.watch(dir): `filename` is the changed entry's name, or null when the platform does not say. */
  watch(dir: string, listener: (event: string, filename: string | null) => void): WatchHandle;
  /** stat (following symlinks). Rejects with the fs error (`code` ENOENT when there is no file). */
  stat(p: string): Promise<FileSig>;
  /** Reads a regular file through one descriptor, with that descriptor's fstat. */
  read(p: string, maxBytes: number): Promise<{ bytes: Uint8Array; sig: FileSig }>;
}

export interface WatchTiming {
  /** 9.2 step 2: the wait after an event. */
  settleMs: number;
  /** 9.2 step 2: between the two reads. */
  rereadMs: number;
  /** 9.2 step 1: the stat poll. */
  pollMs: number;
  /** A stream of events still gets a check this long after its first event. */
  maxWaitMs: number;
  /** A missing file is looked for once more after this long before it counts as gone. */
  goneConfirmMs: number;
}

export const WATCH_TIMING: Readonly<WatchTiming> = Object.freeze({ settleMs: 150, rereadMs: 50, pollMs: 1000, maxWaitMs: 1000, goneConfirmMs: 150 });

export interface DeckWatcherOptions {
  /** The deck's realpath (9.2 Atomic write step 1: resolved at open). */
  realpath: string;
  /**
   * Where knownHash lives (9.2 Watcher step 3, Write protocol step 6): pass the BlDocument, whose DeckIO
   * (documents.ts io(), onWritten) sets doc.knownHash after each of Blueline's own writes, so the watcher reads
   * the hash of the moment it decides and never reloads Blueline's own edits. The watcher writes the new hash
   * there when it sees an external change.
   */
  holder?: { knownHash: string; isOwnWrite?(hash: string): boolean };
  /** Without a holder: the hash of the bytes the document was opened from (BlDocument.version). */
  knownHash?: string;
  /** 9.2 step 3: an external change, with the settled bytes and their sha256. */
  onExternalChange(bytes: Uint8Array, version: string): void;
  /** The file is gone from its path (deleted, or renamed away). */
  onGone?(): void;
  /** A file is at the path again (onExternalChange follows when its content differs from knownHash). */
  onBack?(): void;
  log?(msg: string): void;
  fs?: WatchFs;
  timing?: Partial<WatchTiming>;
  /** Reads larger than this fail (default 512 MB, as documents.ts opens). */
  maxBytes?: number;
  hash?: (bytes: Uint8Array) => string;
  /** File name comparison: case-insensitive on macOS and Windows volumes (default process.platform). */
  platform?: NodeJS.Platform;
}

const GONE = 'gone';

function sigKey(s: FileSig): string {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtime}`;
}

function errCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : 'EUNKNOWN';
}

function missing(e: unknown): boolean {
  const c = errCode(e);
  return c === 'ENOENT' || c === 'ENOTDIR';
}

function sigOf(st: fs.BigIntStats): FileSig {
  return { dev: String(st.dev), ino: String(st.ino), size: String(st.size), mtime: String(st.mtimeNs) };
}

/** node:fs. Stats are read as bigint: inode numbers above 2^53 (Windows, ZFS) must not collide. */
export const nodeWatchFs: WatchFs = {
  watch(dir, listener) {
    // persistent: false — the watch never keeps the process alive by itself.
    return fs.watch(dir, { persistent: false, encoding: 'utf8' }, (event, filename) => listener(event, filename ?? null));
  },
  async stat(p) {
    return sigOf(await fs.promises.stat(p, { bigint: true }));
  },
  async read(p, maxBytes) {
    // Non-blocking open and an fstat of the descriptor, as atomic-write.ts readRegularFile: a FIFO or a device
    // swapped in for the deck is refused, never read.
    const fh = await fs.promises.open(p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const st = await fh.stat({ bigint: true });
      if (!st.isFile()) throw Object.assign(new Error(`${path.basename(p)} is not a regular file`), { code: 'ENOTREG' });
      if (st.size > BigInt(maxBytes)) throw Object.assign(new Error(`${path.basename(p)} is too large`), { code: 'EFBIG' });
      const buf = await fh.readFile();
      return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), sig: sigOf(st) };
    } finally {
      await fh.close().catch(() => undefined);
    }
  },
};

export class DeckWatcher {
  readonly realpath: string;
  private readonly dir: string;
  private readonly base: string;
  private readonly fs: WatchFs;
  private readonly t: WatchTiming;
  private readonly maxBytes: number;
  private readonly hash: (b: Uint8Array) => string;
  private readonly sameName: (name: string) => boolean;
  private readonly holder: { knownHash: string; isOwnWrite?(hash: string): boolean };
  private started = false;
  private closed = false;
  private dirWatch: WatchHandle | null = null;
  /** The directory's identity when its watch was made: a replaced directory gets a new watch. */
  private dirSig: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** What the poll last saw at the path: a stat signature, GONE, or `error:<code>`. */
  private polled: string | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private firstEventAt: number | null = null;
  private checking = false;
  private again = false;
  private gone = false;
  private readonly sleepers = new Set<ReturnType<typeof setTimeout>>();
  private lastError: string | null = null;
  /** Checks run (tests). */
  checks = 0;

  constructor(private readonly o: DeckWatcherOptions) {
    if (typeof o.realpath !== 'string' || !path.isAbsolute(o.realpath)) throw new Error('DeckWatcher: the path must be absolute');
    this.realpath = o.realpath;
    this.dir = path.dirname(o.realpath);
    this.base = path.basename(o.realpath);
    this.fs = o.fs ?? nodeWatchFs;
    this.t = { ...WATCH_TIMING, ...o.timing };
    this.maxBytes = o.maxBytes ?? 512 * 1024 * 1024;
    this.hash = o.hash ?? sha256Hex;
    if (!o.holder && typeof o.knownHash !== 'string') throw new Error('DeckWatcher: a holder or a knownHash is needed');
    this.holder = o.holder ?? { knownHash: o.knownHash! };
    const platform = o.platform ?? process.platform;
    // A false match costs one check (two reads); a missed one leaves the change to the poll. So names are
    // compared NFC-normalized (macOS reports decomposed names), and case-insensitively where volumes usually are.
    const fold = platform === 'darwin' || platform === 'win32';
    const norm = (s: string) => (fold ? s.normalize('NFC').toLowerCase() : s.normalize('NFC'));
    const want = norm(this.base);
    this.sameName = (name) => norm(name) === want;
  }

  /** Starts watching: the directory watch, the poll, and one check (the file may have changed since it was read). */
  start(): this {
    if (this.started || this.closed) return this;
    this.started = true;
    this.watchDir();
    void this.fs.stat(this.realpath).then(
      (s) => {
        this.polled ??= sigKey(s);
      },
      (e) => {
        this.polled ??= missing(e) ? GONE : `error:${errCode(e)}`;
      },
    );
    this.pollTimer = setInterval(() => void this.poll(), this.t.pollMs);
    this.pollTimer.unref?.();
    this.trigger();
    return this;
  }

  /** The hash Blueline last knew the file by (9.2 step 3). */
  get knownHash(): string {
    return this.holder.knownHash;
  }

  /**
   * Blueline wrote the file (9.2 Write protocol step 6): its own change is not external. Call it as soon as
   * the write is on disk (DeckIO onWritten); the watcher waits 150 ms before it reads, and decides against
   * the knownHash of the moment it decides.
   */
  setKnownHash(hash: string): void {
    this.holder.knownHash = hash;
  }

  /** The file is gone from its path (onGone ran, and onBack has not yet). */
  get isGone(): boolean {
    return this.gone;
  }

  /** Releases the directory watch and every timer; nothing is reported after this. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    for (const s of this.sleepers) clearTimeout(s);
    this.sleepers.clear();
    this.closeDirWatch();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ------------------------------------------------------------------------------------------- 1. watching

  private watchDir(): void {
    if (this.closed || this.dirWatch) return;
    try {
      const w = this.fs.watch(this.dir, (_event, filename) => {
        if (this.closed) return;
        // 9.2 step 1: the deck's basename, or a null filename (the platform did not say which entry changed).
        if (filename !== null && !this.sameName(filename)) return;
        this.trigger();
      });
      // An FSWatcher error (the folder was deleted, or a platform limit) must never reach main as an uncaught
      // error: drop the watch; the poll keeps going and makes a new one when the folder is back.
      w.on('error', (e) => {
        this.note(`watching ${this.dir} stopped: ${e.message}`);
        if (this.dirWatch === w) this.closeDirWatch();
      });
      this.dirWatch = w;
      void this.fs.stat(this.dir).then(
        (s) => {
          if (this.dirWatch === w) this.dirSig = `${s.dev}:${s.ino}`;
        },
        () => undefined,
      );
    } catch (e) {
      // The folder is gone or not watchable (a network volume may refuse): the poll covers it.
      this.note(`cannot watch ${this.dir}: ${e instanceof Error ? e.message : String(e)}`);
      this.dirWatch = null;
    }
  }

  private closeDirWatch(): void {
    const w = this.dirWatch;
    this.dirWatch = null;
    this.dirSig = null;
    try {
      w?.close();
    } catch {
      // already closed
    }
  }

  /** The 1 s backstop: a change of the path's stat signature, and the directory watch kept alive. */
  private async poll(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      let key: string;
      try {
        key = sigKey(await this.fs.stat(this.realpath));
      } catch (e) {
        key = missing(e) ? GONE : `error:${errCode(e)}`;
      }
      if (this.closed) return;
      if (this.polled !== null && key !== this.polled) this.trigger();
      this.polled = key;
      // A folder that was replaced (or came back) needs a new watch: the old one follows the old folder.
      let dirKey: string | null = null;
      try {
        const d = await this.fs.stat(this.dir);
        dirKey = `${d.dev}:${d.ino}`;
      } catch {
        dirKey = null;
      }
      if (this.closed) return;
      if (dirKey === null) this.closeDirWatch();
      else if (this.dirWatch && this.dirSig !== null && this.dirSig !== dirKey) {
        this.closeDirWatch();
        this.watchDir();
      } else if (!this.dirWatch) this.watchDir();
    } finally {
      this.polling = false;
    }
  }

  // ------------------------------------------------------------------------------------------- 2. settling

  /** An event or a poll change: (re)start the 150 ms wait, for at most maxWaitMs since the first event. */
  private trigger(): void {
    if (this.closed) return;
    const now = Date.now();
    this.firstEventAt ??= now;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    const delay = Math.max(0, Math.min(this.t.settleMs, this.firstEventAt + this.t.maxWaitMs - now));
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.firstEventAt = null;
      void this.runCheck();
    }, delay);
    this.settleTimer.unref?.();
  }

  private async runCheck(): Promise<void> {
    if (this.closed) return;
    if (this.checking) {
      // One check at a time; an event during it gets its own settle once it is done.
      this.again = true;
      return;
    }
    this.checking = true;
    try {
      await this.check();
    } catch (e) {
      this.note(`check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.checking = false;
      if (this.again && !this.closed) {
        this.again = false;
        this.trigger();
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const s = setTimeout(() => {
        this.sleepers.delete(s);
        resolve();
      }, ms);
      s.unref?.();
      this.sleepers.add(s);
    });
  }

  private async check(): Promise<void> {
    this.checks++;
    let first: { bytes: Uint8Array; sig: FileSig };
    let second: { bytes: Uint8Array; sig: FileSig };
    try {
      first = await this.fs.read(this.realpath, this.maxBytes);
      await this.sleep(this.t.rereadMs);
      if (this.closed) return;
      second = await this.fs.read(this.realpath, this.maxBytes);
    } catch (e) {
      if (this.closed) return;
      if (missing(e)) return this.confirmGone();
      // Unreadable for now (permissions, a FIFO swapped in, too large): say so once; the poll looks again.
      this.note(`cannot read ${this.base}: ${errCode(e)}`);
      return;
    }
    if (this.closed) return;
    const h1 = this.hash(first.bytes);
    const h2 = this.hash(second.bytes);
    // 9.2 step 2: act only when both reads agree (a file still being written, or replaced between the reads,
    // is looked at again after the next settle).
    if (h1 !== h2 || sigKey(first.sig) !== sigKey(second.sig)) {
      this.trigger();
      return;
    }
    // The path still holds what was read: otherwise a newer write landed, and is the next change.
    let now: FileSig;
    try {
      now = await this.fs.stat(this.realpath);
    } catch (e) {
      if (this.closed) return;
      if (missing(e)) return this.confirmGone();
      this.note(`cannot stat ${this.base}: ${errCode(e)}`);
      return;
    }
    if (this.closed) return;
    if (sigKey(now) !== sigKey(second.sig)) {
      this.trigger();
      return;
    }
    this.polled = sigKey(now);
    this.lastError = null;
    if (this.gone) {
      this.gone = false;
      this.call('onBack', () => this.o.onBack?.());
    }
    // 9.2 step 3: decided against knownHash as it is now (setKnownHash may have run while the file was read).
    // P2-2: a write of Blueline's own that is renamed in but not yet taken (its directory fsync is still running)
    // is not external either.
    if (h2 === this.holder.knownHash || this.holder.isOwnWrite?.(h2) === true) return;
    this.holder.knownHash = h2;
    this.call('onExternalChange', () => this.o.onExternalChange(second.bytes, h2));
  }

  /** The file was missing: editors that delete and recreate leave a short gap, so look once more. */
  private async confirmGone(): Promise<void> {
    await this.sleep(this.t.goneConfirmMs);
    if (this.closed) return;
    try {
      await this.fs.stat(this.realpath);
      // It is back already: settle and read it.
      this.trigger();
      return;
    } catch (e) {
      if (this.closed) return;
      if (!missing(e)) {
        this.note(`cannot stat ${this.base}: ${errCode(e)}`);
        return;
      }
    }
    this.polled = GONE;
    if (!this.gone) {
      this.gone = true;
      this.call('onGone', () => this.o.onGone?.());
    }
  }

  private call(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.note(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Logs a problem once until it changes (the poll would repeat it every second). */
  private note(msg: string): void {
    if (msg === this.lastError) return;
    this.lastError = msg;
    this.o.log?.(`watcher: ${msg}`);
  }
}

/** Starts a DeckWatcher (9.2 Watcher) for an open document. */
export function watchDeck(o: DeckWatcherOptions): DeckWatcher {
  return new DeckWatcher(o).start();
}
