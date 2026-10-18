// The atomic file writer (9.2 Atomic write; 9.9 Writes, Write protocol addition; 9.6: "atomic file writer
// (temp file, xattr copy, fsync, rename) used for session.json, for saving notes into a file and by the
// patcher").
//
// atomicWriteFile(realpath, bytes, {expectHash}):
//   1. the caller resolved realpath at open and always writes to that path (9.2 step 4.1);
//   2. a temp file in the same directory gets the bytes, the original's mode bits and extended attributes
//      (macOS: com.apple.quarantine; Windows: the Zone.Identifier stream), and a derived file its marker
//      (prepareTemp), then fsync (step 4.2, 9.9);
//   3. the file on disk is re-hashed; a hash other than expectHash aborts with a WriteConflictError, so the
//      caller re-queues (step 4.3);
//   4. rename over the file, then fsync the directory where the platform supports it (step 4.4).
// The temp file is removed on any failure. createDeckIO gives the editor's write queue a DeckIO for one
// document (core/capabilities.ts).

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DeckIO } from '@blueline/core/capabilities';
// markers.ts imports only the XattrCopier type from this file, so there is no cycle at run time.
import { markerXattrCopier } from './markers';

/** Thrown when the file on disk no longer has the hash the write was planned against (9.2 step 4.3). */
export class WriteConflictError extends Error {
  override readonly name = 'WriteConflictError';
  constructor(message = 'The file changed on disk since it was read') {
    super(message);
  }
}

/** sha256 of bytes, lowercase hex (the map `version`, 9.2 Write protocol step 1). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Copies the extended attributes that carry an internet marker from the original to the temp file (9.9). */
export interface XattrCopier {
  copy(from: string, to: string): Promise<void>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type ExecFn = (file: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<ExecResult>;

const XATTR = '/usr/bin/xattr';
const QUARANTINE = 'com.apple.quarantine';
const MAX_MARKER = 64 * 1024;

function defaultExec(file: string, args: string[], opts: { timeout: number; maxBuffer: number }): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { ...opts, encoding: 'utf8', windowsHide: true, shell: false }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * macOS, Phase 0: copies com.apple.quarantine with /usr/bin/xattr. The Phase 1 native helper replaces this
 * with copyfile(COPYFILE_XATTR), which copies every extended attribute. If the marker cannot be read or
 * written the write fails: a write that silently dropped the marker would reset trust (6.10, 9.9).
 */
export function macQuarantineCopier(exec: ExecFn = defaultExec): XattrCopier {
  return {
    async copy(from, to) {
      const r = await exec(XATTR, ['-p', QUARANTINE, from], { timeout: 5000, maxBuffer: MAX_MARKER });
      if (r.code === 1 && /no such xattr/i.test(r.stderr)) return;
      if (r.code !== 0) throw new Error('Could not read the file’s quarantine marker');
      const value = r.stdout.replace(/\r?\n$/, '');
      if (value.length === 0 || value.startsWith('-')) throw new Error('Could not read the file’s quarantine marker');
      const w = await exec(XATTR, ['-w', QUARANTINE, value, to], { timeout: 5000, maxBuffer: MAX_MARKER });
      if (w.code !== 0) throw new Error('Could not copy the file’s quarantine marker');
    },
  };
}

/** Windows: `<path>:Zone.Identifier` is copied with fs through NTFS stream paths (9.9). */
export function windowsZoneCopier(
  io: { readFile(p: string): Promise<Uint8Array>; writeFile(p: string, b: Uint8Array): Promise<void> } = {
    readFile: (p) => fs.promises.readFile(p),
    writeFile: (p, b) => fs.promises.writeFile(p, b),
  },
): XattrCopier {
  return {
    async copy(from, to) {
      let bytes: Uint8Array;
      try {
        bytes = await io.readFile(`${from}:Zone.Identifier`);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        // No stream, or a volume without streams (FAT): nothing to copy.
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EINVAL') return;
        throw new Error('Could not read the file’s Zone.Identifier');
      }
      if (bytes.byteLength > MAX_MARKER) throw new Error('Could not read the file’s Zone.Identifier');
      await io.writeFile(`${to}:Zone.Identifier`, bytes);
    },
  };
}

/** Linux and others carry no internet marker. */
export const noXattrs: XattrCopier = { copy: async () => undefined };

/**
 * 9.9 Write protocol addition: the platform's copier of the deck's extended attributes. macOS and Windows use
 * markers.ts (trust-native): on macOS the native helper's copyfile(deck, temp, NULL, COPYFILE_XATTR), every
 * attribute (/usr/bin/xattr for the quarantine marker without the helper); on Windows the Zone.Identifier
 * stream. macQuarantineCopier and windowsZoneCopier stay for their tests and as the reference behaviour.
 */
export function xattrCopierFor(platform: NodeJS.Platform): XattrCopier {
  if (platform === 'darwin' || platform === 'win32') return markerXattrCopier({ platform });
  return noXattrs;
}

export interface AtomicWriteOptions {
  /** The hash the write was planned against (9.2 step 4.3). Omit only for files Blueline alone writes (app data). */
  expectHash?: string;
  /** Hash function (default sha256Hex). */
  sha256?: (bytes: Uint8Array) => string;
  /** Default process.platform. */
  platform?: NodeJS.Platform;
  /** Mode of a file that does not exist yet (default 0o600: app data is private). */
  newFileMode?: number;
  /** Default xattrCopierFor(platform). */
  xattrs?: XattrCopier;
  /**
   * Runs on the temp file once its bytes and the original's attributes are in, before fsync and the rename,
   * whether or not the target exists yet (the xattrs copier runs only for an existing one). A derived file is
   * marked here (9.9 Derived files keep the marker; pdf.ts saveAsPdf): a marker belongs to the inode, so the
   * renamed file has it, and a mark that fails leaves the target as it was (review finding 30).
   */
  prepareTemp?: (temp: string) => Promise<void> | void;
  /** Tests: runs right before the rename (to simulate a concurrent writer). */
  beforeRename?: () => Promise<void> | void;
}

function errCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
}

/**
 * Reads a regular file without blocking on a FIFO or device swapped in for it: open non-blocking, fstat
 * the descriptor, refuse anything but a regular file, then read from the descriptor.
 */
export async function readRegularFile(p: string, maxBytes = 512 * 1024 * 1024): Promise<Uint8Array> {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
  const fh = await fs.promises.open(p, flags);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw Object.assign(new Error(`${path.basename(p)} is not a regular file`), { code: 'ENOTREG' });
    if (st.size > maxBytes) throw Object.assign(new Error(`${path.basename(p)} is too large`), { code: 'EFBIG' });
    const buf = await fh.readFile();
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

async function fsyncDir(dir: string, platform: NodeJS.Platform): Promise<void> {
  // Windows cannot open a directory for fsync; NTFS journals the rename itself.
  if (platform === 'win32') return;
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(dir, fs.constants.O_RDONLY);
    await fh.sync();
  } catch {
    // Some file systems refuse fsync on a directory (EINVAL); the rename has happened either way.
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * Writes `bytes` to `realpath` atomically (9.2 Atomic write steps 2–4). Throws WriteConflictError when the
 * file's hash is not `expectHash`, and a plain Error for any other failure; the file is then unchanged.
 */
export async function atomicWriteFile(realpath: string, bytes: Uint8Array, opts: AtomicWriteOptions = {}): Promise<void> {
  if (typeof realpath !== 'string' || !path.isAbsolute(realpath)) throw new Error('atomicWriteFile: the path must be absolute');
  const platform = opts.platform ?? process.platform;
  const hash = opts.sha256 ?? sha256Hex;
  const dir = path.dirname(realpath);

  let st: fs.Stats | null = null;
  try {
    st = await fs.promises.stat(realpath);
  } catch (e) {
    if (errCode(e) !== 'ENOENT') throw e;
  }
  if (st && !st.isFile()) throw new Error(`${path.basename(realpath)} is not a regular file`);
  if (!st && opts.expectHash !== undefined) throw new WriteConflictError('The file is no longer there');
  if (st) {
    // A read-only file stays read-only: renaming over it would bypass the protection (6.8: a file that
    // cannot be written is saved elsewhere).
    try {
      await fs.promises.access(realpath, fs.constants.W_OK);
    } catch {
      throw Object.assign(new Error(`${path.basename(realpath)} is read-only`), { code: 'EACCES' });
    }
  }

  // Short, hidden, unique: a long file name plus a suffix could exceed the 255-byte name limit.
  const tmp = path.join(dir, `.bl-write-${randomBytes(8).toString('hex')}.tmp`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  const fh = await fs.promises.open(tmp, flags, 0o600);
  let closed = false;
  let renamed = false;
  try {
    await fh.writeFile(bytes);
    if (platform !== 'win32') {
      // 9.2 step 4.2: the original's permission bits (setuid/setgid are never carried over).
      await fh.chmod(st ? st.mode & 0o777 : (opts.newFileMode ?? 0o600));
      if (st && typeof process.getuid === 'function' && (st.uid !== process.getuid() || (typeof process.getgid === 'function' && st.gid !== process.getgid()))) {
        // Keep the owner and group where allowed (a shared folder's group); rename would otherwise make
        // the file ours. Not permitted is fine: that is what any editor's save does.
        await fh.chown(st.uid, st.gid).catch(() => undefined);
      }
    }
    if (st) await (opts.xattrs ?? xattrCopierFor(platform)).copy(realpath, tmp);
    await opts.prepareTemp?.(tmp);
    await fh.sync();
    await fh.close();
    closed = true;

    if (opts.expectHash !== undefined) {
      let current: Uint8Array;
      try {
        current = await readRegularFile(realpath);
      } catch (e) {
        if (errCode(e) === 'ENOENT') throw new WriteConflictError('The file is no longer there');
        throw e;
      }
      if (hash(current) !== opts.expectHash) throw new WriteConflictError();
    }
    await opts.beforeRename?.();
    await fs.promises.rename(tmp, realpath);
    renamed = true;
    await fsyncDir(dir, platform);
  } finally {
    if (!closed) await fh.close().catch(() => undefined);
    if (!renamed) await fs.promises.unlink(tmp).catch(() => undefined);
  }
}

export interface DeckIOOptions {
  /**
   * Checked at the moment of every write (9.1: an edit write happens only while editing is allowed and
   * capabilities.edit is on; 9.2 rule 1: never write a file that failed the UTF-8 check). Returns why the
   * write is refused, or null.
   */
  refuse?: () => string | null;
  /** Runs after a successful write with the new bytes' hash (the watcher's knownHash, 9.2 step 6). */
  onWritten?: (hash: string) => void;
  /** Passed to atomicWriteFile (tests). */
  write?: Omit<AtomicWriteOptions, 'expectHash'>;
}

/** The DeckIO of one document (core/capabilities.ts): its realpath, reads, and the atomic write. */
export function createDeckIO(realpath: string, opts: DeckIOOptions = {}): DeckIO {
  return {
    realpath,
    read: () => readRegularFile(realpath),
    async atomicWrite(bytes: Uint8Array, expectHash: string): Promise<void> {
      if (typeof expectHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectHash)) throw new Error('atomicWrite: expectHash must be a sha256');
      const why = opts.refuse?.() ?? null;
      if (why) throw new Error(why);
      await atomicWriteFile(realpath, bytes, { ...opts.write, expectHash });
      opts.onWritten?.(sha256Hex(bytes));
    },
    sha256: sha256Hex,
  };
}

/**
 * Serializes the writes of one app-data file (session.json, config.json): one write at a time, and when
 * writes pile up only the latest content is written (6.8: "One writer"). `produce` runs at write time,
 * so it serializes the newest state.
 */
export class CoalescingWriter {
  private pending: (() => Uint8Array) | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly target: string,
    private readonly onResult: (err: Error | null) => void = () => undefined,
    private readonly write: (p: string, bytes: Uint8Array) => Promise<void> = (p, b) => atomicWriteFile(p, b),
  ) {}

  /** Schedules a write; resolves when the queue is idle again (it never rejects; see onResult). */
  schedule(produce: () => Uint8Array): Promise<void> {
    this.pending = produce;
    if (!this.loop) this.loop = this.run();
    return this.loop;
  }

  /** Resolves when no write is pending or running. */
  idle(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  /** A write is pending or running. */
  get busy(): boolean {
    return this.loop !== null;
  }

  private async run(): Promise<void> {
    try {
      while (this.pending) {
        const produce = this.pending;
        this.pending = null;
        try {
          await fs.promises.mkdir(path.dirname(this.target), { recursive: true, mode: 0o700 });
          await this.write(this.target, produce());
          this.onResult(null);
        } catch (e) {
          this.onResult(e instanceof Error ? e : new Error(String(e)));
        }
      }
    } finally {
      this.loop = null;
    }
  }
}
