// Finding and starting the Blueline app from the `blueline` command (6.1). The command runs on the system's
// Node (22 or later), never inside Electron (the runAsNode fuse is off, 9.9), so it starts the app's own
// executable:
//   - BLUELINE_ELECTRON: an Electron binary (development), with BLUELINE_APP_DIR or the dev app folder;
//   - packaged: the command ships in the app's resources (`<Resources>/cli/blueline.cjs`, 6.1), next to the
//     app's executable (Phase 1 installs it);
//   - development: packages/cli/dist/blueline.cjs, with Electron resolved from packages/app.
// On Linux with no display it runs under xvfb-run with a large screen (an offscreen window is clamped to
// the X screen, docs/PHASE0-FINDINGS.md F2); as root it adds --no-sandbox (development only).

import * as os from 'node:os';
import * as path from 'node:path';

export interface LaunchContext {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** process.getuid(), or null where there is none (Windows). */
  uid: number | null;
  /** Folder of the running blueline.cjs. */
  cliDir: string;
  exists(p: string): boolean;
  /** The Electron binary installed for `appDir` (node_modules/electron/dist, path.txt), or null. */
  resolveElectron(appDir: string): string | null;
  /** Full path of a program on PATH, or null. */
  which(cmd: string): string | null;
}

export interface AppLocation {
  /** The executable to run. */
  executable: string;
  /** The app folder to pass to a bare Electron binary, or null for a packaged app. */
  appDir: string | null;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  warnings: string[];
  /**
   * Start the app in its own process group (POSIX). A signal the command receives is passed on to the app's
   * main process (under xvfb-run: found in that group, see xvfbAppPid), and a run that does not end is
   * killed as a whole group. Before, a signal sent to the command alone reached only xvfb-run, which died
   * and left Electron and Xvfb running. Windows has no process groups; there the command signals the child.
   */
  ownGroup: boolean;
  /** The app runs under xvfb-run, which starts even when the app cannot (`open` waits for an early exit). */
  viaXvfb: boolean;
  /** The app's own executable (the command itself, or what xvfb-run runs). */
  executable: string;
}

export type Found<T> = { ok: true; value: T } | { ok: false; error: string };

/** The packaged app's executable, relative to `<resources>/cli`. */
export function packagedExecutable(cliDir: string, platform: NodeJS.Platform): string {
  const resources = path.dirname(cliDir);
  if (platform === 'darwin') return path.join(path.dirname(resources), 'MacOS', 'Blueline'); // Blueline.app/Contents/MacOS/Blueline
  if (platform === 'win32') return path.join(path.dirname(resources), 'Blueline.exe');
  return path.join(path.dirname(resources), 'blueline');
}

/** The dev app folder: packages/app next to packages/cli. */
export function devAppDir(cliDir: string): string {
  return path.resolve(cliDir, '..', '..', 'app');
}

function devAppReady(appDir: string, ctx: LaunchContext): boolean {
  return ctx.exists(path.join(appDir, 'package.json')) && ctx.exists(path.join(appDir, 'dist', 'main.cjs'));
}

/** Where the app is (see the module comment for the order). */
export function findApp(ctx: LaunchContext): Found<AppLocation> {
  const envElectron = ctx.env.BLUELINE_ELECTRON;
  if (envElectron) {
    if (!ctx.exists(envElectron)) return { ok: false, error: `BLUELINE_ELECTRON does not exist: ${envElectron}` };
    const appDir = ctx.env.BLUELINE_APP_DIR ?? (devAppReady(devAppDir(ctx.cliDir), ctx) ? devAppDir(ctx.cliDir) : null);
    return { ok: true, value: { executable: envElectron, appDir } };
  }
  if (path.basename(ctx.cliDir) === 'cli') {
    const exe = packagedExecutable(ctx.cliDir, ctx.platform);
    if (ctx.exists(exe)) return { ok: true, value: { executable: exe, appDir: null } };
  }
  const appDir = devAppDir(ctx.cliDir);
  if (ctx.exists(path.join(appDir, 'package.json'))) {
    if (!ctx.exists(path.join(appDir, 'dist', 'main.cjs'))) {
      return { ok: false, error: 'The app is not built. Run `npm run build` in the Blueline repository first.' };
    }
    const electron = ctx.resolveElectron(appDir);
    if (!electron || !ctx.exists(electron)) {
      return { ok: false, error: 'Electron is not installed. Run `npm ci` and `npm run install:electron` in the Blueline repository first.' };
    }
    return { ok: true, value: { executable: electron, appDir } };
  }
  return { ok: false, error: 'Could not find the Blueline app next to this command. Reinstall the command line tool from Help › Install Command Line Tool.' };
}

/** The command line that starts the app with `appArgs` (--bl-cmd, --bl-args, --bl-out). */
export function planLaunch(app: AppLocation, appArgs: readonly string[], ctx: LaunchContext): Found<LaunchPlan> {
  const warnings: string[] = [];
  const args: string[] = [];
  const ownGroup = ctx.platform !== 'win32';
  if (ctx.platform === 'linux' && ctx.uid === 0) {
    warnings.push('running as root: starting the app with --no-sandbox, so the OS sandbox is off (development only)');
    args.push('--no-sandbox');
  }
  if (app.appDir) args.push(app.appDir);
  args.push(...appArgs);
  if (ctx.platform === 'linux' && !ctx.env.DISPLAY && !ctx.env.WAYLAND_DISPLAY) {
    const xvfb = ctx.which('xvfb-run');
    if (!xvfb) return { ok: false, error: 'There is no display. Install Xvfb (the xvfb-run command) or set DISPLAY.' };
    return { ok: true, value: { command: xvfb, args: ['-a', '-s', '-screen 0 3840x2160x24', app.executable, ...args], warnings, ownGroup, viaXvfb: true, executable: app.executable } };
  }
  return { ok: true, value: { command: app.executable, args, warnings, ownGroup, viaXvfb: false, executable: app.executable } };
}

/** One line of /proc/<pid>/stat: `pid (comm) state ppid pgrp …` (comm may hold spaces and parentheses). */
export interface ProcStat {
  pid: number;
  comm: string;
  ppid: number;
  pgrp: number;
}

export function parseProcStat(text: string): ProcStat | null {
  const open = text.indexOf(' (');
  const close = text.lastIndexOf(')');
  if (open < 1 || close < open) return null;
  const pid = Number(text.slice(0, open));
  const rest = text.slice(close + 2).split(' ');
  const ppid = Number(rest[1]);
  const pgrp = Number(rest[2]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgrp)) return null;
  return { pid, comm: text.slice(open + 2, close), ppid, pgrp };
}

/**
 * The app's main process when it runs under xvfb-run (Linux): the child of xvfb-run that runs the app's
 * executable (comm is the executable's name, cut to 15 bytes), or null while it has not started.
 *
 * A signal the command passes on goes to this process alone, as it does to the app itself without
 * xvfb-run. The app stops in order (map deletes its probe copy, check saves check.json) and its helper
 * processes end with it; xvfb-run then sees its command end and stops Xvfb and removes its temporary
 * folder, as on a normal exit. Signalled with the rest of the group, Xvfb could vanish under a map run that
 * is still cleaning up, a signalled xvfb-run (a dash script) exits without its cleanup, and Chromium's
 * helpers (zygote, GPU) die under a running app, which then aborts ("GPU process isn't usable").
 */
export function xvfbAppPid(members: readonly ProcStat[], xvfbRunPid: number, executable: string): number | null {
  const comm = path.basename(executable).slice(0, 15);
  const m = members.find((x) => x.ppid === xvfbRunPid && x.pid !== xvfbRunPid && x.comm === comm);
  return m ? m.pid : null;
}

/**
 * Windows has no signals to pass on, and child.kill() there is TerminateProcess: the app would stop at once,
 * with no chance to delete map's probe copy or write its result. So the command first asks: `taskkill /PID <pid>
 * /T` without /F posts WM_CLOSE to the windows of the app's process tree, which Electron handles as a close (a
 * Ctrl+C in the console also reaches the app itself, as SIGINT). Only a run that has not ended
 * FORWARD_KILL_AFTER_MS later is ended with /F. taskkill is run from System32 by its full path, never found
 * through PATH.
 */
export function windowsStopCommand(pid: number, o: { force: boolean; systemRoot?: string }): { file: string; args: string[] } {
  const root = o.systemRoot && path.win32.isAbsolute(o.systemRoot) ? o.systemRoot : 'C:\\Windows';
  const args = ['/PID', String(pid), '/T'];
  if (o.force) args.push('/F');
  return { file: path.win32.join(root, 'System32', 'taskkill.exe'), args };
}

/** After passing a signal on, the command waits this long for the run to end, then kills the whole group. */
export const FORWARD_KILL_AFTER_MS = 10_000;

/** The signals the command passes on to the app's process group. */
export const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]);

/** 128 + the signal's number, as a shell reports a process a signal stopped (SIGTERM: 143). */
export function signalExitCode(sig: NodeJS.Signals): number {
  const n = (os.constants.signals as Record<string, number | undefined>)[sig];
  return typeof n === 'number' ? 128 + n : 1;
}

/**
 * The exit status of `blueline map` or `check` (6.1; section 10). The app's own result decides when it
 * wrote one (an interrupted map writes 129, 130 or 143 itself). Without a result: 128 + n for a signal the
 * command passed on or that stopped the app (xvfb-run reports a stopped child as a plain exit code), else
 * the app's exit code, and never 0.
 */
export function commandExitCode(o: {
  resultExitCode: number | null;
  received: NodeJS.Signals | null;
  code: number | null;
  signal: NodeJS.Signals | null;
}): number {
  if (o.resultExitCode !== null) return o.resultExitCode;
  const sig = o.received ?? o.signal;
  if (sig) return signalExitCode(sig);
  return typeof o.code === 'number' && o.code !== 0 ? o.code : 1;
}
