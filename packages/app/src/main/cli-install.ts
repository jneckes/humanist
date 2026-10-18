// Help › Install Command Line Tool (6.1 The command line tool).
//
// The `blueline` command ships outside app.asar, next to the app (Resources/cli/: blueline.cjs and the shims
// `blueline` and `blueline.cmd`; packages/cli/dist in development), so its version always matches the app's.
// Installing makes it reachable from a terminal:
//
// - macOS and Linux: a symbolic link named `blueline` to the shipped shim, in ~/.local/bin, or in /usr/local/bin.
//   Linux uses ~/.local/bin (most distributions put it on PATH once it exists). macOS puts ~/.local/bin on no
//   one's PATH by default, so when the user's login shell does not have it there, Blueline uses /usr/local/bin:
//   directly when that folder is writable (Homebrew on Intel Macs owns it), or after asking, through an
//   administrator prompt. That prompt is AppleScript's `do shell script … with administrator privileges`
//   (Apple Technical Note TN2065; the Authorization Services call that did this, AuthorizationExecuteWithPrivileges,
//   is deprecated, and SMJobBless/SMAppService install daemons, not files). The paths reach the script as
//   osascript arguments and go into the shell command only through AppleScript's `quoted form of`, so no path is
//   ever parsed as script or shell syntax.
// - Windows (the documented minimum): no symbolic links (they need administrator rights or Developer Mode).
//   A two-line blueline.cmd in %LOCALAPPDATA%\Blueline\bin calls the shipped blueline.cmd; when that folder is
//   not on PATH, the result says how to add it. Blueline never edits PATH itself (setx truncates it).
//
// Only a previous Blueline link is ever replaced (a link to a Blueline cli folder, or to a file with the shim's
// marker; on Windows, a blueline.cmd with Blueline's marker); any other file, link or folder of that name is left
// alone and the result says why. A replaced link is swapped atomically (a new link renamed over the old one).
// The result tells the user when the folder is not on the PATH their login shell sets (the login shell is run
// with `-l -c /usr/bin/env` and its PATH= line read). ~/.local/bin is made before that PATH is read, because
// Debian's and Ubuntu's ~/.profile add it only `if [ -d "$HOME/.local/bin" ]`. When the login PATH has it but
// this session's does not (the folder was just made), Linux terminals find the command after the next login:
// they start non-login shells, which do not read ~/.profile (review finding 25).
//
// Pure apart from the injected file system, child process and dialogs (CliInstallEnv), so unit tests pin every
// path decision for each platform; createCliInstallEnv wires the real ones.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** In the shims (packages/cli/src/shim): a file that carries it is Blueline's command. */
export const SHIM_MARKER = 'blueline-shim';
/** In the Windows wrapper Blueline writes to %LOCALAPPDATA%\Blueline\bin. */
export const WRAPPER_MARKER = 'blueline-command-line-tool';
export const SYSTEM_BIN = '/usr/local/bin';

export interface CliInstallFs {
  lstat(p: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean }>;
  stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  readlink(p: string): Promise<string>;
  /** The start of a file (at most 64 KB), as UTF-8. */
  readHead(p: string): Promise<string>;
  /** Resolves when `p` is writable (W_OK) or executable (X_OK). */
  access(p: string, mode: 'write' | 'exec'): Promise<void>;
  mkdirp(p: string): Promise<void>;
  symlink(target: string, p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
  writeFile(p: string, text: string): Promise<void>;
}

export interface AdminResult {
  ok: boolean;
  /** The user cancelled the administrator prompt. */
  canceled?: boolean;
  reason?: string;
}

export interface CliInstallEnv {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  isPackaged: boolean;
  /** process.resourcesPath (packaged). */
  resourcesPath: string;
  /** packages/cli/dist (development). */
  devCliDir: string;
  /** /usr/local/bin (tests use a folder of their own). */
  systemDir?: string;
  fs: CliInstallFs;
  /** The PATH the user's login shell sets, or null when it could not be read. */
  loginPath(): Promise<string | null>;
  /** The user's login shell (for the PATH hint), or null. */
  loginShell(): string | null;
  /** macOS: creates (or replaces) the link with administrator privileges. */
  runAsAdmin?(o: { target: string; link: string; dir: string; replace: boolean }): Promise<AdminResult>;
  /** macOS, when ~/.local/bin is not on PATH and /usr/local/bin is not writable: where to install, or null (Cancel). */
  choose?(o: { userDir: string; systemDir: string }): Promise<'user' | 'system' | null>;
}

export type CliInstallResult =
  | {
      ok: true;
      /** The installed command (the link, or the Windows wrapper). */
      link: string;
      /** The shipped shim it points to. */
      target: string;
      dir: string;
      /** A previous Blueline link was replaced. */
      replaced: boolean;
      /** The link already pointed to this app's command. */
      upToDate: boolean;
      /** Whether `dir` is on the login shell's PATH (null: unknown). */
      onPath: boolean | null;
      /** What to do when it is not. */
      pathHint: string | null;
      /**
       * Linux: `dir` is on the login PATH but not on this session's (it was just made, and ~/.profile adds it
       * once it exists): terminals find the command after the next login.
       */
      loginNeeded?: boolean;
      admin: boolean;
    }
  | { ok: false; canceled?: boolean; reason: string; link?: string };

function pathApiFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function errCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
}

/** The shipped command the link points to: <Resources>/cli/blueline(.cmd) packaged, packages/cli/dist in development. */
export function shippedCommand(env: Pick<CliInstallEnv, 'platform' | 'isPackaged' | 'resourcesPath' | 'devCliDir'>): string {
  const p = pathApiFor(env.platform);
  const name = env.platform === 'win32' ? 'blueline.cmd' : 'blueline';
  return env.isPackaged ? p.join(env.resourcesPath, 'cli', name) : p.join(env.devCliDir, name);
}

/** A link target in a Blueline cli folder: …/Resources/cli/blueline (any app copy), or …/packages/cli/dist/blueline. */
export function isBluelineCommandPath(target: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = pathApiFor(platform);
  const norm = p.normalize(target);
  if (p.basename(norm) !== 'blueline') return false;
  const parent = p.dirname(norm);
  const grand = p.dirname(parent);
  if (p.basename(parent) === 'cli' && /^resources$/i.test(p.basename(grand))) return true;
  return p.basename(parent) === 'dist' && p.basename(grand) === 'cli' && p.basename(p.dirname(grand)) === 'packages';
}

export type ExistingKind = 'absent' | 'same' | 'ours' | 'foreign-file' | 'foreign-link' | 'folder';

/** What is at `link` now, compared with the link Blueline would make to `target`. */
export async function classifyExisting(link: string, target: string, env: Pick<CliInstallEnv, 'platform' | 'fs'>): Promise<ExistingKind> {
  const p = pathApiFor(env.platform);
  let st: { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean };
  try {
    st = await env.fs.lstat(link);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return 'absent';
    throw e;
  }
  if (env.platform === 'win32') {
    if (st.isDirectory()) return 'folder';
    if (!st.isFile()) return 'foreign-file';
    const text = await env.fs.readHead(link).catch(() => '');
    if (!text.includes(WRAPPER_MARKER)) return 'foreign-file';
    return text === windowsWrapper(target) ? 'same' : 'ours';
  }
  if (st.isSymbolicLink()) {
    const raw = await env.fs.readlink(link);
    const resolved = p.resolve(p.dirname(link), raw);
    if (resolved === p.normalize(target)) return 'same';
    if (isBluelineCommandPath(resolved, env.platform)) return 'ours';
    // A link to a moved copy of the shim (it carries the marker) is Blueline's too.
    const head = await env.fs.readHead(resolved).catch(() => '');
    return head.includes(SHIM_MARKER) ? 'ours' : 'foreign-link';
  }
  if (st.isDirectory()) return 'folder';
  // A regular file is never Blueline's on macOS and Linux: Blueline only makes links there.
  return 'foreign-file';
}

/** Whether `dir` is one of the entries of `pathValue` (a PATH string), after ~ expansion and normalization. */
export function isOnPath(dir: string, pathValue: string | null | undefined, o: { platform: NodeJS.Platform; home: string }): boolean | null {
  if (pathValue === null || pathValue === undefined) return null;
  const p = pathApiFor(o.platform);
  const sep = o.platform === 'win32' ? ';' : ':';
  const fold = (s: string) => (o.platform === 'win32' ? s.toLowerCase() : s);
  const norm = (s: string) => {
    let x = s.trim();
    if (o.platform === 'win32') x = x.replace(/^"|"$/g, '');
    if (x === '~') x = o.home;
    else if (x.startsWith('~/')) x = p.join(o.home, x.slice(2));
    else if (x.startsWith('$HOME/')) x = p.join(o.home, x.slice(6));
    if (!p.isAbsolute(x)) return null;
    x = p.normalize(x);
    while (x.length > 1 && (x.endsWith('/') || (o.platform === 'win32' && x.endsWith('\\') && !/^[A-Za-z]:\\$/.test(x)))) x = x.slice(0, -1);
    return fold(x);
  };
  const want = norm(dir);
  return pathValue.split(sep).some((e) => e.length > 0 && norm(e) === want);
}

/** The line that puts ~/.local/bin on PATH, for the user's login shell. */
export function pathHint(dir: string, o: { platform: NodeJS.Platform; home: string; shell: string | null }): string {
  if (o.platform === 'win32') {
    return `Add ${dir} to your PATH: open Settings, search for “environment variables”, choose “Edit environment variables for your account”, select Path, choose Edit, then New, and paste the folder. Then open a new terminal.`;
  }
  const shell = o.shell ? path.posix.basename(o.shell) : '';
  const shown = dir.startsWith(o.home + '/') ? `$HOME/${dir.slice(o.home.length + 1)}` : dir;
  if (shell === 'fish') return `Add it to your PATH with: fish_add_path ${dir}. Then open a new terminal.`;
  const file = shell === 'zsh' ? '~/.zprofile' : shell === 'bash' ? (o.platform === 'darwin' ? '~/.bash_profile' : '~/.profile') : '~/.profile';
  // Terminal on macOS starts login shells, which read the file; Linux terminals start non-login shells, so the
  // line applies from the next login.
  const then = o.platform === 'darwin' ? 'then open a new terminal' : 'then log out and log back in';
  return `Add it to your PATH: add the line export PATH="${shown}:$PATH" to ${file}, ${then}.`;
}

/** The Windows wrapper: calls the shipped blueline.cmd, so the command always matches the installed app. */
export function windowsWrapper(target: string): string {
  return [
    '@echo off',
    `rem ${WRAPPER_MARKER}: written by Blueline (Help > Install Command Line Tool), which replaces this file and no other.`,
    'rem It runs the command that ships with the app, so its version always matches the app.',
    `"${target}" %*`,
    '',
  ].join('\r\n');
}

/** Why the shipped command cannot be linked to from where the app runs now (macOS), or null. */
export function unstableLocation(env: Pick<CliInstallEnv, 'platform' | 'isPackaged' | 'resourcesPath'>): string | null {
  if (env.platform !== 'darwin' || !env.isPackaged) return null;
  // Gatekeeper runs a quarantined app from a random read-only copy (App Translocation), and a disk image goes away
  // when it is ejected: a link to either breaks.
  if (env.resourcesPath.includes('/AppTranslocation/')) return 'Blueline is running from a temporary copy that macOS made. Move Blueline to your Applications folder, open it from there, and install the command line tool again.';
  if (env.resourcesPath.startsWith('/Volumes/')) return 'Blueline is running from a disk image. Drag it to your Applications folder, open it from there, and install the command line tool again.';
  return null;
}

async function linkAtomically(target: string, link: string, env: CliInstallEnv): Promise<void> {
  const p = pathApiFor(env.platform);
  // A new link under a temporary name, renamed over the old one: there is never a moment without a command.
  const tmp = p.join(p.dirname(link), `.blueline-link-${process.pid}-${Date.now().toString(36)}`);
  await env.fs.symlink(target, tmp);
  try {
    await env.fs.rename(tmp, link);
  } catch (e) {
    await env.fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
}

function refusal(kind: ExistingKind, link: string): string {
  if (kind === 'folder') return `${link} is a folder. Blueline did not change it.`;
  if (kind === 'foreign-link') return `${link} is a link to another program. Blueline replaces only its own command; remove that link first if you want Blueline’s.`;
  return `${link} is another program’s file. Blueline replaces only its own command; remove or rename that file first if you want Blueline’s.`;
}

/** Installs the `blueline` command (see the module comment for every decision). */
export async function installCommandLineTool(env: CliInstallEnv): Promise<CliInstallResult> {
  const p = pathApiFor(env.platform);
  const target = shippedCommand(env);
  const unstable = unstableLocation(env);
  if (unstable) return { ok: false, reason: unstable };
  try {
    const st = await env.fs.stat(target);
    if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTREG' });
    if (env.platform !== 'win32') await env.fs.access(target, 'exec');
  } catch {
    return {
      ok: false,
      reason: env.isPackaged
        ? `The command line tool is missing from this copy of Blueline (${target}). Reinstall Blueline.`
        : `The command line tool is not built (${target}). Run npm run build in the Blueline repository first.`,
    };
  }
  if (env.platform === 'win32') return installWindows(env, target);

  const systemDir = env.systemDir ?? SYSTEM_BIN;
  const userDir = p.join(env.home, '.local', 'bin');
  const userLink = p.join(userDir, 'blueline');
  const systemLink = p.join(systemDir, 'blueline');
  // Made first on Linux: a ~/.profile that adds the folder only once it exists (Debian, Ubuntu) has it on the
  // login PATH only then, so it must exist before loginPath() is read. macOS does not put ~/.local/bin on PATH
  // that way, and the install may go to /usr/local/bin, so creating it up front there would leave an empty
  // folder behind (review finding 25 side effect); on macOS it is made only when the link goes into it (below).
  if (env.platform === 'linux') await env.fs.mkdirp(userDir).catch(() => undefined);
  const loginPath = await env.loginPath().catch(() => null);
  const userOnPath = isOnPath(userDir, loginPath, env);
  const [userKind, systemKind] = await Promise.all([
    classifyExisting(userLink, target, env).catch(() => 'foreign-file' as const),
    classifyExisting(systemLink, target, env).catch(() => 'foreign-file' as const),
  ]);
  const systemWritable = await env.fs.access(systemDir, 'write').then(
    () => true,
    () => false,
  );

  // Where: an existing Blueline link is updated where it is (the user chose that place before); otherwise
  // ~/.local/bin, except on macOS when the login shell does not have it on PATH.
  let where: 'user' | 'system';
  if (systemKind === 'same' || systemKind === 'ours') where = 'system';
  else if (userKind === 'same' || userKind === 'ours') where = 'user';
  else if (env.platform === 'darwin' && userOnPath !== true) {
    if (systemWritable && systemKind === 'absent') where = 'system';
    else if (systemKind !== 'absent') where = 'user';
    else {
      const choice = env.choose ? await env.choose({ userDir, systemDir }) : 'user';
      if (choice === null) return { ok: false, canceled: true, reason: 'Not installed.' };
      where = choice;
    }
  } else where = 'user';
  if (where === 'system' && env.platform !== 'darwin' && !systemWritable) where = 'user';

  const dir = where === 'system' ? systemDir : userDir;
  const link = where === 'system' ? systemLink : userLink;
  const kind = where === 'system' ? systemKind : userKind;
  if (kind === 'folder' || kind === 'foreign-file' || kind === 'foreign-link') return { ok: false, reason: refusal(kind, link), link };
  // /usr/local/bin is on every macOS PATH (/etc/paths): unknown counts as yes there.
  const onPath = where === 'system' ? (isOnPath(systemDir, loginPath, env) ?? true) : userOnPath;
  // Linux only: a macOS app started from the Finder has launchd's short PATH, whatever the shells have.
  const loginNeeded = env.platform === 'linux' && onPath === true && isOnPath(dir, env.env.PATH, env) === false;
  const done = (o: { replaced: boolean; upToDate: boolean; admin: boolean }): CliInstallResult => ({
    ok: true,
    link,
    target,
    dir,
    ...o,
    onPath,
    pathHint: onPath === false ? pathHint(dir, { platform: env.platform, home: env.home, shell: env.loginShell() }) : null,
    loginNeeded,
  });
  if (kind === 'same') return done({ replaced: false, upToDate: true, admin: false });

  if (where === 'system' && !systemWritable) {
    if (!env.runAsAdmin) return { ok: false, reason: `${systemDir} is not writable.`, link };
    const r = await env.runAsAdmin({ target, link, dir, replace: kind === 'ours' });
    if (!r.ok) return { ok: false, canceled: r.canceled, reason: r.canceled ? 'Not installed: the administrator prompt was cancelled.' : `Not installed: ${r.reason ?? 'the administrator command failed.'}`, link };
    return done({ replaced: kind === 'ours', upToDate: false, admin: true });
  }
  try {
    if (where === 'user') await env.fs.mkdirp(userDir);
    await linkAtomically(target, link, env);
  } catch (e) {
    return { ok: false, reason: `Not installed: ${e instanceof Error ? e.message : String(e)}`, link };
  }
  return done({ replaced: kind === 'ours', upToDate: false, admin: false });
}

async function installWindows(env: CliInstallEnv, target: string): Promise<CliInstallResult> {
  const p = path.win32;
  const local = env.env.LOCALAPPDATA && p.isAbsolute(env.env.LOCALAPPDATA) ? env.env.LOCALAPPDATA : p.join(env.home, 'AppData', 'Local');
  const dir = p.join(local, 'Blueline', 'bin');
  const link = p.join(dir, 'blueline.cmd');
  const kind = await classifyExisting(link, target, env).catch(() => 'foreign-file' as const);
  if (kind === 'folder' || kind === 'foreign-file' || kind === 'foreign-link') return { ok: false, reason: refusal(kind, link), link };
  const onPath = isOnPath(dir, env.env.Path ?? env.env.PATH, env);
  const result = (o: { replaced: boolean; upToDate: boolean }): CliInstallResult => ({
    ok: true,
    link,
    target,
    dir,
    ...o,
    admin: false,
    onPath,
    pathHint: onPath === false ? pathHint(dir, { platform: 'win32', home: env.home, shell: null }) : null,
  });
  if (kind === 'same') return result({ replaced: false, upToDate: true });
  try {
    await env.fs.mkdirp(dir);
    const tmp = `${link}.${process.pid}.tmp`;
    await env.fs.writeFile(tmp, windowsWrapper(target));
    try {
      await env.fs.rename(tmp, link);
    } catch (e) {
      await env.fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
  } catch (e) {
    return { ok: false, reason: `Not installed: ${e instanceof Error ? e.message : String(e)}`, link };
  }
  return result({ replaced: kind === 'ours', upToDate: false });
}

/** The result as a message box (message and detail). */
export function cliInstallMessage(r: CliInstallResult): { type: 'info' | 'warning' | 'error'; message: string; detail: string } {
  if (!r.ok) return { type: r.canceled ? 'info' : 'error', message: r.canceled ? 'The command line tool was not installed' : 'The command line tool could not be installed', detail: r.reason };
  const lines = [
    r.upToDate ? `${r.link} already runs this copy of Blueline.` : `${r.link} now runs ${r.target}.`,
    'Try it in a terminal: blueline deck.html, or blueline pdf deck.html. It needs Node.js 22 or later (nodejs.org).',
  ];
  if (r.onPath === false && r.pathHint) lines.push(`${r.dir} is not on your PATH yet, so your terminal will not find blueline. ${r.pathHint}`);
  else if (r.loginNeeded) lines.push(`${r.dir} will be on your PATH after you log in again: terminals opened before then may not find blueline.`);
  else if (r.onPath === null) lines.push(`Blueline could not read your PATH. If your terminal does not find blueline, add ${r.dir} to your PATH.`);
  return {
    type: r.onPath === false ? 'warning' : 'info',
    message: r.upToDate ? 'The command line tool is installed' : r.replaced ? 'The command line tool was updated' : 'The command line tool is installed',
    detail: lines.join('\n\n'),
  };
}

// ------------------------------------------------------------------------------------------- the real environment

/** execFile, narrowed (tests inject one). */
export type ExecFileFn = (file: string, args: readonly string[], opts: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultExecFile: ExecFileFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, [...args], { ...opts, encoding: 'utf8', windowsHide: true, shell: false }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/** The PATH= line of `env` output (the last one wins, as a later export would). */
export function parsePathLine(stdout: string): string | null {
  let found: string | null = null;
  for (const line of stdout.split('\n')) if (line.startsWith('PATH=')) found = line.slice(5).replace(/\r$/, '');
  return found;
}

/** The PATH the user's login shell sets: `<shell> -l -c /usr/bin/env`, its PATH= line (5 s at most). */
export async function readLoginShellPath(shell: string | null, exec: ExecFileFn = defaultExecFile, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!shell || !path.isAbsolute(shell)) return null;
  const r = await exec(shell, ['-l', '-c', '/usr/bin/env'], { timeout: 5000, maxBuffer: 1024 * 1024, env });
  if (r.code !== 0) return null;
  return parsePathLine(r.stdout);
}

/** The user's login shell: the account's (passwd), else $SHELL. */
export function loginShellOf(env: Record<string, string | undefined> = process.env): string | null {
  try {
    const s = os.userInfo().shell;
    if (typeof s === 'string' && path.isAbsolute(s)) return s;
  } catch {
    // no passwd entry
  }
  return env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : null;
}

/**
 * The osascript arguments that create (or replace) the link with administrator privileges (TN2065). The three
 * paths are passed as arguments (`item n of argv`) and quoted for the shell by `quoted form of`; the script text
 * itself is constant.
 */
export function osascriptArgs(o: { target: string; link: string; dir: string; replace: boolean }): string[] {
  // ln -sfh: replace the old link itself (never follow it), only when it was found to be Blueline's.
  const ln = o.replace ? '/bin/ln -sfh ' : '/bin/ln -s ';
  return [
    '-e',
    'on run argv',
    '-e',
    `do shell script ("/bin/mkdir -p " & quoted form of (item 3 of argv) & " && ${ln}" & quoted form of (item 1 of argv) & " " & quoted form of (item 2 of argv)) with prompt ("Blueline wants to install the blueline command in " & (item 3 of argv) & ".") with administrator privileges`,
    '-e',
    'end run',
    o.target,
    o.link,
    o.dir,
  ];
}

/** macOS: runs osascriptArgs; error -128 is the user's Cancel. */
export async function runAsAdminMac(o: { target: string; link: string; dir: string; replace: boolean }, exec: ExecFileFn = defaultExecFile): Promise<AdminResult> {
  const r = await exec('/usr/bin/osascript', osascriptArgs(o), { timeout: 5 * 60_000, maxBuffer: 64 * 1024 });
  if (r.code === 0) return { ok: true };
  if (/-128|User canceled/i.test(r.stderr)) return { ok: false, canceled: true };
  return { ok: false, reason: r.stderr.trim().slice(0, 500) || `osascript exited with ${r.code}` };
}

export const nodeCliFs: CliInstallFs = {
  lstat: (p) => fs.promises.lstat(p),
  stat: (p) => fs.promises.stat(p),
  readlink: (p) => fs.promises.readlink(p),
  async readHead(p) {
    const fh = await fs.promises.open(p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const st = await fh.stat();
      if (!st.isFile()) return '';
      const buf = Buffer.alloc(Math.min(64 * 1024, st.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close().catch(() => undefined);
    }
  },
  access: (p, mode) => fs.promises.access(p, mode === 'write' ? fs.constants.W_OK : fs.constants.X_OK),
  mkdirp: async (p) => {
    await fs.promises.mkdir(p, { recursive: true, mode: 0o755 });
  },
  symlink: (t, p) => fs.promises.symlink(t, p),
  rename: (a, b) => fs.promises.rename(a, b),
  unlink: (p) => fs.promises.unlink(p),
  writeFile: (p, text) => fs.promises.writeFile(p, text, { mode: 0o755 }),
};

/** The real environment, from main (distDir: the folder of main.cjs). */
export function createCliInstallEnv(o: {
  isPackaged: boolean;
  resourcesPath: string;
  distDir: string;
  platform?: NodeJS.Platform;
  home?: string;
  choose?: CliInstallEnv['choose'];
}): CliInstallEnv {
  const platform = o.platform ?? process.platform;
  const shell = platform === 'win32' ? null : loginShellOf();
  return {
    platform,
    home: o.home ?? os.homedir(),
    env: process.env,
    isPackaged: o.isPackaged,
    resourcesPath: o.resourcesPath,
    // dist/main.cjs is packages/app/dist; the command is built into packages/cli/dist.
    devCliDir: path.resolve(o.distDir, '..', '..', 'cli', 'dist'),
    fs: nodeCliFs,
    loginPath: () => (platform === 'win32' ? Promise.resolve(process.env.Path ?? process.env.PATH ?? null) : readLoginShellPath(shell)),
    loginShell: () => shell,
    runAsAdmin: platform === 'darwin' ? (a) => runAsAdminMac(a) : undefined,
    choose: o.choose,
  };
}

export interface CliInstallUi {
  showMessageBox(opts: { type: 'info' | 'warning' | 'error' | 'question'; message: string; detail?: string; buttons: string[]; defaultId?: number; cancelId?: number; noLink?: boolean }): Promise<{ response: number }>;
  log(msg: string): void;
}

/** macOS: where to install when ~/.local/bin is not on PATH (the question the admin prompt follows). */
export function chooseWithDialog(ui: CliInstallUi): NonNullable<CliInstallEnv['choose']> {
  return async ({ userDir, systemDir }) => {
    const r = await ui.showMessageBox({
      type: 'question',
      message: 'Where should Blueline install the blueline command?',
      detail: `${systemDir} is on your PATH, so terminals find the command at once; installing there asks for an administrator password.\n\n${userDir} needs no password, but it is not on your PATH yet: you would add it yourself.`,
      buttons: [`Install in ${systemDir}`, `Install in ${userDir.replace(/^.*\/\.local\/bin$/, '~/.local/bin')}`, 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return r.response === 0 ? 'system' : r.response === 1 ? 'user' : null;
  };
}

/** Help › Install Command Line Tool: installs, then shows the result. */
export async function runInstallCommandLineTool(env: CliInstallEnv, ui: CliInstallUi): Promise<CliInstallResult> {
  let r: CliInstallResult;
  try {
    r = await installCommandLineTool(env);
  } catch (e) {
    r = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  ui.log(r.ok ? `command line tool: ${r.link} -> ${r.target}${r.admin ? ' (administrator)' : ''}` : `command line tool not installed: ${r.reason}`);
  const m = cliInstallMessage(r);
  await ui.showMessageBox({ type: m.type, message: m.message, detail: m.detail, buttons: ['OK'], defaultId: 0, noLink: true }).catch(() => undefined);
  return r;
}
