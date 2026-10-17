// The native helpers (6.1 Becoming the default app; 9.6 native/; 9.9 Write protocol addition, Derived files
// keep the marker). The platform seam for what Node and Electron cannot do themselves:
//
// - macOS: a long-lived child of main, native/macos's Swift helper (`blueline-helper`), spoken to in JSON
//   lines on stdin and stdout, each request with an id and a timeout. It is spawned once, on first use, is
//   restarted with a backoff when it dies, and is killed on quit (9.9: "It runs as a long-lived child of
//   main, so a write does not pay a process launch"). It sets and reads the default HTML app
//   (NSWorkspace.setDefaultApplication(at:toOpen:) with UTType.html; urlForApplication(toOpen:)), reads and
//   sets com.apple.quarantine (getxattr, setxattr, or the Launch Services quarantine properties), and copies
//   extended attributes (copyfile COPYFILE_XATTR). Without the binary (a development checkout where
//   native/macos/build.sh has not run) quarantine goes through /usr/bin/xattr, which is said once in the log,
//   and the default app cannot be set.
// - Windows: no helper process. Markers are `Zone.Identifier` streams, read and written with fs (markers.ts).
//   The default app cannot be set by an app: the button opens Default Apps settings on Blueline's own page
//   (`ms-settings:defaultapps?registeredAppUser=Blueline`, or `registeredAppMachine=` for a per-machine
//   install), which needs Windows 11 21H2 or later with the 2023-04 update; older Windows gets the plain page.
//   The registry values that page reads are written by the installer (packages/app/build/installer.nsh).
// - Linux: no markers; the default app is not set here (Linux packages are Later, 9.10).
//
// No Electron import: main passes in what it knows (packaged or not, the app bundle, shell.openExternal), so
// markers.ts and documents.ts stay testable in plain Node.

import { execFile, spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { DefaultAppResult, DefaultAppStatus } from '@blueline/core/ipc-trust';

export const HELPER_NAME = 'blueline-helper';
export const QUARANTINE_ATTR = 'com.apple.quarantine';
/** The `RegisteredApplications` value the installer writes and Default Apps settings is opened on (6.1). */
export const REGISTERED_APP_NAME = 'Blueline';
/** The ProgID the installer registers for .html and .htm (installer.nsh). */
export const WINDOWS_PROG_ID = 'Blueline.HTML';
const XATTR = '/usr/bin/xattr';
/** A marker value is small (a quarantine string, a Zone.Identifier INI); anything larger is refused. */
export const MAX_MARKER_BYTES = 64 * 1024;
/** Requests that read or write attributes answer at once; one that takes this long means the helper hangs. */
const REQUEST_TIMEOUT_MS = 10_000;
/** setDefaultHtmlApp waits for the user's answer to the system prompt from macOS 26.4 (6.1). */
const DEFAULT_APP_TIMEOUT_MS = 10 * 60_000;
/** A reply line longer than this is a protocol error (replies are a few hundred bytes). */
const MAX_LINE = 1024 * 1024;
/** Restart delays after the helper exits, by the number of exits in a row. */
const BACKOFF_MS: readonly number[] = [100, 500, 2_000, 5_000, 15_000];
/** After this many exits in a row without one good reply, the helper is given up for this launch. */
const MAX_CRASHES = 6;

// ---------------------------------------------------------------------------------------------------
// Seams: child processes and commands
// ---------------------------------------------------------------------------------------------------

/** The parts of a ChildProcess the client uses (tests pass a fake). */
export interface ChildLike {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnFn = (file: string, args: readonly string[]) => ChildLike;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs a program without a shell. */
export type ExecFn = (file: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<ExecResult>;

/** The helper's environment: only what Foundation needs, none of main's own variables (BLUELINE_*, tokens). */
function helperEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const k of ['HOME', 'TMPDIR', 'LANG', 'USER']) {
    const v = env[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export const defaultSpawn: SpawnFn = (file, args) =>
  nodeSpawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: helperEnv() });

export const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { ...opts, encoding: 'utf8', windowsHide: true, shell: false }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

// ---------------------------------------------------------------------------------------------------
// The JSON-lines client (macOS helper)
// ---------------------------------------------------------------------------------------------------

/** One reply line: `{"id": n, "ok": true, …}` or `{"id": n, "ok": false, "error": "…"}`. */
export interface HelperReply {
  id: number;
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export class HelperTimeoutError extends Error {
  override readonly name = 'HelperTimeoutError';
}
export class HelperExitedError extends Error {
  override readonly name = 'HelperExitedError';
}

export interface HelperClientOptions {
  binary: string;
  spawn?: SpawnFn;
  timeoutMs?: number;
  backoffMs?: readonly number[];
  maxCrashes?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (msg: string) => void;
}

interface Pending {
  resolve(r: HelperReply): void;
  reject(e: Error): void;
  timer: unknown;
}

/**
 * Talks to the helper: one request per line, `{"id": n, "op": "…", …}`, answered by one line with the same id.
 * Replies may come in any order (setDefaultHtmlApp waits for the user while reads are answered). A reply with
 * an unknown id (one that timed out) is dropped.
 */
export class HelperClient {
  private child: ChildLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buf = '';
  private crashes = 0;
  private restartAt = 0;
  private disposed = false;
  private gaveUp = false;
  /** Times the helper was started (tests). */
  starts = 0;

  constructor(private readonly o: HelperClientOptions) {}

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }
  private timer(fn: () => void, ms: number): unknown {
    return (this.o.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  }
  private clear(t: unknown): void {
    (this.o.clearTimer ?? ((x) => clearTimeout(x as NodeJS.Timeout)))(t);
  }
  private log(msg: string): void {
    try {
      this.o.log?.(msg);
    } catch {
      // logging never decides
    }
  }

  /** The helper exited too often in a row: callers use their fallback for the rest of this launch. */
  get broken(): boolean {
    return this.gaveUp;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /**
   * Sends one request. `killOnTimeout` (default true): a request that is not answered in time means the
   * helper hangs, so it is killed (and started again by the next request). setDefaultHtmlApp passes false: it
   * waits for a person.
   */
  async request(op: string, args: Record<string, unknown>, opts: { timeoutMs?: number; killOnTimeout?: boolean } = {}): Promise<HelperReply> {
    if (this.disposed) throw new HelperExitedError('the helper was stopped');
    if (this.gaveUp) throw new HelperExitedError('the helper is not available');
    const wait = this.restartAt - this.now;
    if (!this.child && wait > 0) await new Promise<void>((r) => this.timer(r, wait));
    if (this.disposed) throw new HelperExitedError('the helper was stopped');
    if (this.gaveUp) throw new HelperExitedError('the helper is not available');
    const child = this.child ?? this.start();
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.o.timeoutMs ?? REQUEST_TIMEOUT_MS;
    // `op` and `id` go last, so an argument can never replace them.
    const line = JSON.stringify({ ...args, op, id }) + '\n';
    // The helper skips a line longer than this without answering; refuse it here rather than wait it out.
    if (line.length > MAX_LINE) throw new Error(`${op}: the request is too large for the helper`);
    return await new Promise<HelperReply>((resolve, reject) => {
      const timer = this.timer(() => {
        if (!this.pending.delete(id)) return;
        reject(new HelperTimeoutError(`the helper did not answer ${op} in ${timeoutMs} ms`));
        if (opts.killOnTimeout !== false && this.child === child) {
          this.log(`native helper: no answer to ${op}; restarting it`);
          this.kill(child);
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin?.write(line);
      } catch (e) {
        this.settle(id, null, new HelperExitedError(`could not write to the helper: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  /** Stops the helper (app quit). Pending requests fail. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const c = this.child;
    this.child = null;
    if (c) {
      try {
        c.stdin?.end();
      } catch {
        // already closed
      }
      this.kill(c);
    }
    this.failAll(new HelperExitedError('the helper was stopped'));
  }

  private start(): ChildLike {
    const spawn = this.o.spawn ?? defaultSpawn;
    const child = spawn(this.o.binary, []);
    this.child = child;
    this.buf = '';
    this.starts++;
    child.on('error', (err) => this.onExit(child, `error: ${err.message}`));
    child.on('exit', (code, signal) => this.onExit(child, `exit ${code ?? signal ?? '?'}`));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => this.onData(child, String(chunk)));
    let stderrBudget = 50;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string | Buffer) => {
      if (stderrBudget-- > 0) this.log(`native helper: ${String(chunk).trim().slice(0, 500)}`);
    });
    // EPIPE when the helper is gone: the exit handler fails the pending requests.
    child.stdin?.on('error', () => undefined);
    return child;
  }

  private kill(child: ChildLike): void {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    if (this.child === child) this.onExit(child, 'killed');
  }

  private onExit(child: ChildLike, why: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.buf = '';
    this.failAll(new HelperExitedError(`the helper stopped (${why})`));
    if (this.disposed) return;
    this.crashes++;
    const max = this.o.maxCrashes ?? MAX_CRASHES;
    if (this.crashes >= max) {
      this.gaveUp = true;
      this.log(`native helper: stopped ${this.crashes} times in a row (${why}); not starting it again`);
      return;
    }
    const backoff = this.o.backoffMs ?? BACKOFF_MS;
    this.restartAt = this.now + backoff[Math.min(this.crashes - 1, backoff.length - 1)];
    this.log(`native helper: ${why}; it starts again on the next request`);
  }

  private failAll(e: Error): void {
    for (const [id] of [...this.pending]) this.settle(id, null, e);
  }

  private settle(id: number, reply: HelperReply | null, err?: Error): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.clear(p.timer);
    if (reply) p.resolve(reply);
    else p.reject(err ?? new Error('no reply'));
  }

  private onData(child: ChildLike, chunk: string): void {
    if (this.child !== child) return;
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim().length > 0) this.onLine(line);
    }
    if (this.buf.length > MAX_LINE) {
      this.log('native helper: a reply line is too long; restarting it');
      this.kill(child);
    }
  }

  private onLine(line: string): void {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      this.log('native helper: a reply is not JSON');
      return;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== 'number' || !Number.isInteger(r.id) || typeof r.ok !== 'boolean') return;
    if (!this.pending.has(r.id)) return;
    // A good answer: the helper works, so the next exit starts the backoff from the beginning.
    this.crashes = 0;
    this.restartAt = 0;
    const reply: HelperReply = { ...r, id: r.id, ok: r.ok };
    if (r.error !== undefined && typeof r.error !== 'string') delete reply.error;
    this.settle(r.id, reply);
  }
}

// ---------------------------------------------------------------------------------------------------
// The platform seam
// ---------------------------------------------------------------------------------------------------

/** A quarantine read: the whole `com.apple.quarantine` value, or null when there is none. */
export type QuarantineRead = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * What setQuarantine writes: a whole value (a marker copied from another file, 9.9 Derived files), or
 * quarantine properties for a new marker (a deck's download; a derived file of a Protected document that had
 * none), which the helper sets through Launch Services so the event names the deck as its origin.
 */
export type QuarantineSpec = { value: string } | { properties: { agent: string; originUrl?: string; dataUrl?: string } };

export interface NativeHelper {
  /** `helper`: the macOS binary; `xattr`: macOS without it; `windows`; `none` (Linux and others). */
  readonly mode: 'helper' | 'xattr' | 'windows' | 'none';
  /** Settings › General: whether Blueline is the default HTML app (6.1). Never throws. */
  isDefaultHtmlApp(): Promise<DefaultAppStatus>;
  /** "Make Blueline your HTML app" (6.0, 6.1). Never throws. */
  setDefaultHtmlApp(): Promise<DefaultAppResult>;
  /** macOS: the whole quarantine value. Elsewhere: none (no such attribute). */
  readQuarantine(p: string): Promise<QuarantineRead>;
  /** macOS: every extended attribute of `from` onto `to` (9.9 Write protocol addition). Throws on failure. */
  copyXattrs(from: string, to: string): Promise<void>;
  /** macOS: sets com.apple.quarantine on `p`. Throws on failure. */
  setQuarantine(p: string, q: QuarantineSpec): Promise<void>;
  dispose(): void;
}

export interface NativeHelperOptions {
  platform?: NodeJS.Platform;
  /** macOS: the helper binary (findHelperBinary), or null when there is none. */
  binary?: string | null;
  /**
   * macOS: the app bundle that becomes the default (`/Applications/Blueline.app`), only for a packaged app;
   * null in development, where the running bundle is Electron's own.
   */
  appBundle?: string | null;
  spawn?: SpawnFn;
  exec?: ExecFn;
  /** Windows: opens the Default Apps link (Electron's shell.openExternal). */
  openExternal?: (url: string) => Promise<void>;
  /** Windows: os.release() ("10.0.22621"). */
  osRelease?: () => string;
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
  /** HelperClient options (tests). */
  client?: Partial<HelperClientOptions>;
}

/**
 * Where the macOS helper binary is: inside the packaged app, `Contents/Resources/helper/blueline-helper`
 * (shipped outside app.asar through extraResources, 6.1, and signed with the app); in development,
 * `native/macos/build/blueline-helper` in the checkout (dist/ is packages/app/dist). A packaged app never
 * looks in the checkout. Returns null when there is no executable regular file there.
 */
export function findHelperBinary(o: {
  isPackaged: boolean;
  resourcesPath?: string;
  distDir: string;
  isExecutableFile?: (p: string) => boolean;
}): string | null {
  const ok = o.isExecutableFile ?? isExecutableFile;
  const candidate = o.isPackaged
    ? o.resourcesPath
      ? path.join(o.resourcesPath, 'helper', HELPER_NAME)
      : null
    : path.resolve(o.distDir, '..', '..', '..', 'native', 'macos', 'build', HELPER_NAME);
  return candidate && ok(candidate) ? candidate : null;
}

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The .app bundle of a packaged macOS app's executable (`…/Blueline.app/Contents/MacOS/Blueline`), or null. */
export function appBundleOf(execPath: string): string | null {
  const macos = path.posix.dirname(execPath);
  const contents = path.posix.dirname(macos);
  const bundle = path.posix.dirname(contents);
  if (path.posix.basename(macos) !== 'MacOS' || path.posix.basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return null;
  return bundle;
}

export function createNativeHelper(o: NativeHelperOptions = {}): NativeHelper {
  const platform = o.platform ?? process.platform;
  if (platform === 'darwin') return new MacHelper(o);
  if (platform === 'win32') return new WindowsHelper(o);
  return new NoHelper();
}

// --------------------------------------------------------------------------------------------- macOS

const NO_HELPER_REASON = 'The native helper is not built in this copy of Blueline (development: run native/macos/build.sh).';
const DEV_BUNDLE_REASON = 'Only an installed Blueline can become your HTML app; this one runs from a development checkout.';

function validMarkerValue(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && Buffer.byteLength(v, 'utf8') <= MAX_MARKER_BYTES && !/[\u0000\n\r]/.test(v);
}

function absolute(p: string): boolean {
  return typeof p === 'string' && path.posix.isAbsolute(p) && !p.includes('\0');
}

class MacHelper implements NativeHelper {
  private readonly client: HelperClient | null;
  private readonly exec: ExecFn;
  private readonly appBundle: string | null;
  private saidFallback = false;

  constructor(private readonly o: NativeHelperOptions) {
    this.exec = o.exec ?? defaultExec;
    this.appBundle = o.appBundle ?? null;
    this.client = o.binary ? new HelperClient({ binary: o.binary, spawn: o.spawn, log: o.log, ...o.client }) : null;
  }

  get mode(): 'helper' | 'xattr' {
    return this.client && !this.client.broken ? 'helper' : 'xattr';
  }

  private log(msg: string): void {
    try {
      this.o.log?.(msg);
    } catch {
      // ignore
    }
  }

  /** The helper, or null (with one log line) when quarantine goes through /usr/bin/xattr. */
  private live(): HelperClient | null {
    if (this.client && !this.client.broken) return this.client;
    if (!this.saidFallback) {
      this.saidFallback = true;
      this.log(
        this.client
          ? 'native helper: not available; quarantine markers go through /usr/bin/xattr, and the default HTML app cannot be set'
          : `native helper: ${HELPER_NAME} not found; quarantine markers go through /usr/bin/xattr (development), and the default HTML app cannot be set`,
      );
    }
    return null;
  }

  async isDefaultHtmlApp(): Promise<DefaultAppStatus> {
    const c = this.live();
    if (!c) return { known: false, isDefault: false, current: null, action: 'none', reason: NO_HELPER_REASON };
    try {
      const r = await c.request('isDefaultHtmlApp', { app: this.appBundle ?? '' });
      if (!r.ok) return { known: false, isDefault: false, current: null, action: this.appBundle ? 'set' : 'none', reason: this.appBundle ? null : DEV_BUNDLE_REASON };
      const currentPath = typeof r.current === 'string' ? r.current : null;
      const name = typeof r.currentName === 'string' && r.currentName.length <= 256 ? r.currentName : currentPath ? path.posix.basename(currentPath, '.app') : null;
      const isDefault = this.appBundle !== null && r.isDefault === true;
      return {
        known: true,
        isDefault,
        current: isDefault ? null : name,
        action: this.appBundle ? 'set' : 'none',
        reason: this.appBundle ? null : DEV_BUNDLE_REASON,
      };
    } catch (e) {
      return { known: false, isDefault: false, current: null, action: this.appBundle ? 'set' : 'none', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async setDefaultHtmlApp(): Promise<DefaultAppResult> {
    if (!this.appBundle) return { ok: false, reason: DEV_BUNDLE_REASON };
    const c = this.live();
    if (!c) return { ok: false, reason: NO_HELPER_REASON };
    try {
      // From macOS 26.4 the completion handler waits for the user's Use or Keep (6.1): no kill on timeout.
      const r = await c.request('setDefaultHtmlApp', { app: this.appBundle }, { timeoutMs: DEFAULT_APP_TIMEOUT_MS, killOnTimeout: false });
      if (r.ok) return { ok: true };
      if (r.declined === true) return { ok: false, declined: true, reason: 'You kept your current HTML app.' };
      return { ok: false, reason: r.error ?? 'macOS did not change the default HTML app.' };
    } catch (e) {
      return { ok: false, reason: e instanceof HelperTimeoutError ? 'macOS did not answer.' : e instanceof Error ? e.message : String(e) };
    }
  }

  async readQuarantine(p: string): Promise<QuarantineRead> {
    if (!absolute(p)) return { ok: false, error: 'not an absolute path' };
    const c = this.live();
    if (c) {
      try {
        const r = await c.request('readQuarantine', { path: p });
        if (!r.ok) return { ok: false, error: r.error ?? 'could not read the quarantine attribute' };
        if (r.value === null) return { ok: true, value: null };
        if (validMarkerValue(r.value)) return { ok: true, value: r.value };
        return { ok: false, error: 'the quarantine attribute is not readable text' };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return await xattrReadQuarantine(this.exec, p);
  }

  async copyXattrs(from: string, to: string): Promise<void> {
    if (!absolute(from) || !absolute(to)) throw new Error('copyXattrs: paths must be absolute');
    const c = this.live();
    if (c) {
      const r = await c.request('copyXattrs', { from, to });
      if (!r.ok) throw new Error(`Could not copy the file’s extended attributes: ${r.error ?? 'copyfile failed'}`);
      return;
    }
    // Fallback: only the marker (copyfile would copy every attribute). A write that silently dropped the
    // marker would reset trust (6.10, 9.9), so a failure fails the write.
    const q = await xattrReadQuarantine(this.exec, from);
    if (!q.ok) throw new Error('Could not read the file’s quarantine marker');
    if (q.value !== null) await xattrWriteQuarantine(this.exec, to, q.value);
  }

  async setQuarantine(p: string, q: QuarantineSpec): Promise<void> {
    if (!absolute(p)) throw new Error('setQuarantine: the path must be absolute');
    if ('value' in q && !validMarkerValue(q.value)) throw new Error('setQuarantine: not a quarantine value');
    const c = this.live();
    if (c) {
      const args: Record<string, unknown> = { path: p };
      if ('value' in q) args.value = q.value;
      else args.properties = { agent: q.properties.agent, originUrl: q.properties.originUrl ?? null, dataUrl: q.properties.dataUrl ?? null };
      const r = await c.request('setQuarantine', args);
      if (!r.ok) throw new Error(`Could not set the file’s quarantine marker: ${r.error ?? 'failed'}`);
      return;
    }
    await xattrWriteQuarantine(this.exec, p, 'value' in q ? q.value : quarantineValue(q.properties.agent, Date.now()));
  }

  dispose(): void {
    this.client?.dispose();
  }
}

/**
 * A quarantine value for /usr/bin/xattr (development only; the helper lets Launch Services build it):
 * `flags;hex seconds;agent;` with 0081, the flags Chromium-based browsers write for a download.
 */
export function quarantineValue(agent: string, nowMs: number): string {
  const clean = agent.replace(/[;\u0000-\u001f\u007f]/g, '').slice(0, 64) || 'Blueline';
  return `0081;${Math.floor(nowMs / 1000).toString(16).padStart(8, '0')};${clean};`;
}

/** Reads com.apple.quarantine with /usr/bin/xattr -p (development, without the helper). */
export async function xattrReadQuarantine(exec: ExecFn, p: string): Promise<QuarantineRead> {
  // The path is absolute, so it can never be read as an option.
  const r = await exec(XATTR, ['-p', QUARANTINE_ATTR, p], { timeout: 5000, maxBuffer: MAX_MARKER_BYTES });
  if (r.code === 0) {
    const value = r.stdout.replace(/\r?\n$/, '');
    return validMarkerValue(value) ? { ok: true, value } : { ok: false, error: 'the quarantine attribute is not readable text' };
  }
  // xattr exits 1 with "No such xattr" when the file has no quarantine attribute.
  if (r.code === 1 && /no such xattr/i.test(r.stderr)) return { ok: true, value: null };
  return { ok: false, error: `xattr failed (${r.code})` };
}

/** Writes com.apple.quarantine with /usr/bin/xattr -w (development, without the helper). */
export async function xattrWriteQuarantine(exec: ExecFn, p: string, value: string): Promise<void> {
  // A value that starts with '-' would be read as an option by xattr.
  if (!validMarkerValue(value) || value.startsWith('-')) throw new Error('Could not copy the file’s quarantine marker');
  const w = await exec(XATTR, ['-w', QUARANTINE_ATTR, value, p], { timeout: 5000, maxBuffer: MAX_MARKER_BYTES });
  if (w.code !== 0) throw new Error('Could not copy the file’s quarantine marker');
}

// --------------------------------------------------------------------------------------------- Windows

/** ProgIDs that mean Blueline opens .html (the installer's, and the ones Windows makes from Open With). */
const BLUELINE_PROG_IDS = new Set([WINDOWS_PROG_ID.toLowerCase(), 'html document', 'applications\\blueline.exe']);

/** The Windows build number from os.release() ("10.0.22621" → 22621), or null. */
export function windowsBuildOf(release: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(release.trim());
  if (!m) return null;
  return Number(m[3]);
}

/**
 * Whether Default Apps settings can open on Blueline's own page (`registeredAppUser=` / `registeredAppMachine=`,
 * 6.1): Windows 11 21H2 with the 2023-04 cumulative update (KB5025224, OS build 22000.1817) or later; on 22H2
 * the 2023-04 preview update (KB5025305, 22621.1635) or later; every later feature update (22631 23H2, 26100
 * 24H2, …) has it. os.release() carries only the build, so on 22000 and 22621 the update revision (UBR, from
 * the registry) decides, and an unknown UBR counts as too old: the plain page always works. Windows 10 (build
 * 19045 and below) never has it.
 */
export function supportsRegisteredAppLink(build: number | null, ubr: number | null): boolean {
  if (build === null) return false;
  if (build > 22621) return true;
  if (build === 22621) return ubr !== null && ubr >= 1635;
  if (build === 22000) return ubr !== null && ubr >= 1817;
  return false;
}

export type WindowsInstallScope = 'user' | 'machine' | 'none';

/** The Default Apps link for this Windows (6.1). */
export function defaultAppsUri(o: { build: number | null; ubr: number | null; scope: WindowsInstallScope }): string {
  if (o.scope === 'none' || !supportsRegisteredAppLink(o.build, o.ubr)) return 'ms-settings:defaultapps';
  const key = o.scope === 'machine' ? 'registeredAppMachine' : 'registeredAppUser';
  return `ms-settings:defaultapps?${key}=${encodeURIComponent(REGISTERED_APP_NAME)}`;
}

/** A `reg query … /v <name>` line: `    <name>    REG_SZ    <data>`. */
export function parseRegValue(stdout: string, name: string): { type: string; data: string } | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*?)\s*$/.exec(line) ?? /^\s+(.+?)\s{2,}(REG_[A-Z_]+)\s*$/.exec(line);
    if (m && m[1].toLowerCase() === name.toLowerCase()) return { type: m[2], data: m[3] ?? '' };
  }
  return null;
}

class WindowsHelper implements NativeHelper {
  readonly mode = 'windows' as const;
  private readonly exec: ExecFn;
  private readonly env: Record<string, string | undefined>;

  constructor(private readonly o: NativeHelperOptions) {
    this.exec = o.exec ?? defaultExec;
    this.env = o.env ?? process.env;
  }

  /** reg.exe from System32 by full path (never a `reg` found on PATH). */
  private get reg(): string {
    const root = this.env.SystemRoot ?? this.env.windir ?? 'C:\\Windows';
    return path.win32.join(root, 'System32', 'reg.exe');
  }

  private async query(key: string, value: string): Promise<{ type: string; data: string } | null> {
    try {
      const r = await this.exec(this.reg, ['query', key, '/v', value], { timeout: 5000, maxBuffer: 64 * 1024 });
      return r.code === 0 ? parseRegValue(r.stdout, value) : null;
    } catch {
      return null;
    }
  }

  /** Per-user or per-machine: which hive holds the installer's RegisteredApplications value (installer.nsh). */
  async installScope(): Promise<WindowsInstallScope> {
    if (await this.query('HKCU\\Software\\RegisteredApplications', REGISTERED_APP_NAME)) return 'user';
    if (await this.query('HKLM\\Software\\RegisteredApplications', REGISTERED_APP_NAME)) return 'machine';
    return 'none';
  }

  private async ubr(): Promise<number | null> {
    const v = await this.query('HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', 'UBR');
    if (!v || v.type !== 'REG_DWORD') return null;
    const n = Number.parseInt(v.data.replace(/^0x/i, ''), 16);
    return Number.isFinite(n) ? n : null;
  }

  async isDefaultHtmlApp(): Promise<DefaultAppStatus> {
    // The user's choice for .html (UserChoiceLatest on current Windows 11, UserChoice before it). Read only:
    // an app cannot write it (6.1).
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.html';
    const choice = (await this.query(`${base}\\UserChoiceLatest`, 'ProgId')) ?? (await this.query(`${base}\\UserChoice`, 'ProgId'));
    if (!choice) return { known: false, isDefault: false, current: null, action: 'open-settings', reason: null };
    return { known: true, isDefault: BLUELINE_PROG_IDS.has(choice.data.toLowerCase()), current: null, action: 'open-settings', reason: null };
  }

  async setDefaultHtmlApp(): Promise<DefaultAppResult> {
    const open = this.o.openExternal;
    if (!open) return { ok: false, reason: 'Default Apps settings cannot be opened from here.' };
    const build = windowsBuildOf((this.o.osRelease ?? os.release)());
    const [scope, ubr] = await Promise.all([this.installScope(), build === 22000 || build === 22621 ? this.ubr() : Promise.resolve(null)]);
    const uri = defaultAppsUri({ build, ubr, scope });
    try {
      await open(uri);
      return { ok: true, openedSettings: true };
    } catch (e) {
      return { ok: false, reason: `Could not open Default Apps settings: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Windows markers are Zone.Identifier streams, handled with fs in markers.ts.
  async readQuarantine(): Promise<QuarantineRead> {
    return { ok: true, value: null };
  }
  async copyXattrs(): Promise<void> {}
  async setQuarantine(): Promise<void> {}
  dispose(): void {}
}

// --------------------------------------------------------------------------------------------- others

class NoHelper implements NativeHelper {
  readonly mode = 'none' as const;
  async isDefaultHtmlApp(): Promise<DefaultAppStatus> {
    return { known: false, isDefault: false, current: null, action: 'none', reason: 'On Linux, choose the default HTML app in your desktop’s settings (Linux packages come later).' };
  }
  async setDefaultHtmlApp(): Promise<DefaultAppResult> {
    return { ok: false, reason: 'Not available on this system.' };
  }
  async readQuarantine(): Promise<QuarantineRead> {
    return { ok: true, value: null };
  }
  async copyXattrs(): Promise<void> {}
  async setQuarantine(): Promise<void> {}
  dispose(): void {}
}

// ---------------------------------------------------------------------------------------------------
// The app's one helper
// ---------------------------------------------------------------------------------------------------

let shared: NativeHelper | null = null;

/**
 * Sets up the app's helper once main knows its paths (startup, before the first file opens): on macOS
 * `{ binary: findHelperBinary(…), appBundle: app.isPackaged ? appBundleOf(app.getPath('exe')) : null }`; on
 * Windows `{ openExternal: shell.openExternal }`. Replaces (and stops) any earlier one.
 */
export function configureNativeHelper(o: NativeHelperOptions): NativeHelper {
  shared?.dispose();
  shared = createNativeHelper(o);
  return shared;
}

/**
 * The app's helper. Before configureNativeHelper it is a helper without the binary (macOS: /usr/bin/xattr,
 * no default app), so markers are still read.
 */
export function nativeHelper(): NativeHelper {
  if (!shared) shared = createNativeHelper({ binary: null, log: (m) => console.error(`[blueline] ${m}`) });
  return shared;
}

/** Stops the helper (app `will-quit`). */
export function disposeNativeHelper(): void {
  shared?.dispose();
  shared = null;
}
