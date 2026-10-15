// Finding and starting the Blueline app from the `blueline` command (6.1). The command runs on the system's
// Node (22 or later), never inside Electron (the runAsNode fuse is off, 9.9), so it starts the app's own
// executable:
//   - BLUELINE_ELECTRON: an Electron binary (development), with BLUELINE_APP_DIR or the dev app folder;
//   - packaged: the command ships in the app's resources (`<Resources>/cli/blueline.cjs`, 6.1), next to the
//     app's executable (Phase 1 installs it);
//   - development: packages/cli/dist/blueline.cjs, with Electron resolved from packages/app.
// On Linux with no display it runs under xvfb-run with a large screen (an offscreen window is clamped to
// the X screen, docs/PHASE0-FINDINGS.md F2); as root it adds --no-sandbox (development only).

import * as path from 'node:path';

export interface LaunchContext {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** process.getuid(), or null where there is none (Windows). */
  uid: number | null;
  /** Folder of the running blueline.cjs. */
  cliDir: string;
  exists(p: string): boolean;
  /** The Electron binary as `require('electron')` resolves it from `appDir`, or null. */
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
      return { ok: false, error: 'Electron is not installed. Run `npm install` in the Blueline repository first.' };
    }
    return { ok: true, value: { executable: electron, appDir } };
  }
  return { ok: false, error: 'Could not find the Blueline app next to this command. Reinstall the command line tool from Help › Install Command Line Tool.' };
}

/** The command line that starts the app with `appArgs` (--bl-cmd, --bl-args, --bl-out). */
export function planLaunch(app: AppLocation, appArgs: readonly string[], ctx: LaunchContext): Found<LaunchPlan> {
  const warnings: string[] = [];
  const args: string[] = [];
  if (ctx.platform === 'linux' && ctx.uid === 0) {
    warnings.push('running as root: starting the app with --no-sandbox, so the OS sandbox is off (development only)');
    args.push('--no-sandbox');
  }
  if (app.appDir) args.push(app.appDir);
  args.push(...appArgs);
  if (ctx.platform === 'linux' && !ctx.env.DISPLAY && !ctx.env.WAYLAND_DISPLAY) {
    const xvfb = ctx.which('xvfb-run');
    if (!xvfb) return { ok: false, error: 'There is no display. Install Xvfb (the xvfb-run command) or set DISPLAY.' };
    return { ok: true, value: { command: xvfb, args: ['-a', '-s', '-screen 0 3840x2160x24', app.executable, ...args], warnings } };
  }
  return { ok: true, value: { command: app.executable, args, warnings } };
}
