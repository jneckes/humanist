// Electron main entry (dist/main.cjs). Order matters:
//   1. `open-file` is listened for at once, before anything async (6.1: macOS delivers files through
//      open-file, which must be listened for early); in `map` and `check` the file goes to a regular
//      instance (open-file.ts);
//   2. the blueline and app schemes are registered privileged before `ready` (9.1 Registration);
//   3. BLUELINE_USER_DATA overrides userData before `ready` (tests);
//   4. `open` takes the single-instance lock and hands a second launch's files to the running instance
//      (6.1 Mechanics). `map` and `check` never forward: they run standalone, with their own Chromium
//      storage, write their CommandResult to --bl-out and exit.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, session, shell, webContents as allWebContents } from 'electron';
import type { CommandResult } from '@blueline/core/ipc';
import { assetsDir, servedDirs } from './app-paths';
import { parseAppArgs, parseParentArg, validateSecondInstanceData, type ParsedArgs, type SecondInstanceData } from './args';
import { chooseWithDialog, createCliInstallEnv, runInstallCommandLineTool, type CliInstallUi } from './cli-install';
import { ConfigStore } from './config';
import { AppController } from './controller';
import { interruptDiagnostics, openDiagnostics } from './diagnostics';
import { dropResultText, installDropHandler } from './drop';
import { loadEditorDetailed } from './editor-loader';
import { SAMPLE_FILE, configFirstRunSettings, installFirstRun, secondLaunchFocus, type FirstRunController } from './first-run';
import { TrustSettings } from './folders';
import { gitUserName, osUserName, resolvePerson } from './identity';
import { runMapCommand } from './map-command';
import { runPdfCommand } from './pdf-command';
import { installAppMenu } from './menu';
import { appBundleOf, configureNativeHelper, disposeNativeHelper, findHelperBinary, nativeHelper } from './native-helper';
import { pickClosedLoopbackPort } from './network-policy';
import { OpenFileRouter, handOffToRegularInstance, type PendingOpen } from './open-file';
import { registerPrivilegedSchemes, setShellThumbResolver } from './protocol';
import { RecentFiles } from './recent';
import { setRenderHost } from './render-service';
import { appLocationOptions, installSettingsWindow, type SettingsController } from './settings-window';
import { readThumb } from './thumbnails';
import { TrustStore } from './trust-store';
import { docWindowByKey, type AppPaths } from './window';

// ------------------------------------------------------------------------------------------- 1. open-file

// parseAppArgs is pure and synchronous: the command decides where an open-file path goes (open-file.ts).
const parsed: ParsedArgs = parseAppArgs(process.argv, { defaultApp: process.defaultApp === true });
const openFiles = new OpenFileRouter(
  // Only `open` opens documents: a file macOS delivers to map, check or pdf goes to a regular instance.
  () => parsed.cmd,
  // map and check never open documents: a file macOS routes to them goes to a regular instance (6.1).
  (file) =>
    handOffToRegularInstance(file, {
      spawn,
      execPath: process.execPath,
      defaultApp: process.defaultApp === true,
      appPath: app.getAppPath(),
      noSandbox: app.commandLine.hasSwitch('no-sandbox'),
      env: process.env,
      log,
    }),
);
app.on('open-file', (event, p) => openFiles.onOpenFile(event, p));

// ------------------------------------------------------------------------------------------- 2–3. before ready

const TEST = process.env.BLUELINE_TEST === '1';
const log = (msg: string): void => {
  console.error(`[blueline] ${msg}`);
};
// `blueline map` and `check` read the app's stdout and stderr through pipes. When the command dies first, a
// write gets EPIPE; unhandled, that is an uncaught exception, and Electron shows a modal error dialog that
// blocks main for good (map would never delete its probe copy, check never close). Nobody is reading: drop it.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => undefined);

app.setName('Blueline');
registerPrivilegedSchemes();
// Every renderer runs sandboxed, whatever its webPreferences say (9.9 Always; the shell, 9.1). Each view
// also sets sandbox: true itself. With --no-sandbox (development as root only) enableSandbox makes the
// network service crash in a loop ("Running as root without --no-sandbox is not supported"), so it is
// skipped there; the OS sandbox is off in that case anyway.
if (app.commandLine.hasSwitch('no-sandbox')) log('--no-sandbox: the OS sandbox is off (development only)');
else app.enableSandbox();

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

/**
 * A private folder for a map or check run. Chromium still writes into its storage while it shuts down, so
 * the app cannot remove these itself: with --bl-out they go next to the result file, in the folder the
 * `blueline` command made for the run and deletes after the app has exited. Without --bl-out (a manual
 * run) they go to the temp folder and are removed on a best-effort basis.
 */
function privateDir(kind: 'session' | 'userdata'): string {
  if (parsed.cmd !== 'open' && parsed.out && path.isAbsolute(parsed.out)) {
    const d = `${parsed.out}.${kind}`;
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }
  return makeTempDir(`blueline-${kind}-`);
}

const userDataOverride = process.env.BLUELINE_USER_DATA;
if (userDataOverride) {
  const ud = path.resolve(userDataOverride);
  fs.mkdirSync(ud, { recursive: true, mode: 0o700 });
  app.setPath('userData', ud);
} else if (parsed.cmd === 'map' || parsed.cmd === 'pdf') {
  // `map` keeps no session state (section 10, Mutation probe step 1), nor does `pdf`: a private userData.
  app.setPath('userData', privateDir('userdata'));
}
if (parsed.cmd !== 'open') {
  // A standalone run next to a running app must not share its Chromium storage (cookies, caches, the
  // persist: partitions): sessionData goes to a private folder. check.json still goes to userData.
  app.setPath('sessionData', privateDir('session'));
}

function removeTempDirs(): void {
  for (const d of tempDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // Chromium may still hold a file (Windows); the OS cleans its temp folder.
    }
  }
}
app.on('will-quit', removeTempDirs);

// Backstops for every webContents, including ones no module set up (devtools): no webviews, no popups.
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (event) => event.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
});

const distDir = __dirname;
const paths: AppPaths = {
  preloadShell: path.join(distDir, 'preload-shell.cjs'),
  preloadDeck: path.join(distDir, 'preload-deck.cjs'),
  // Served through the confined app:// handler, so a packaged build reads it from app.asar.unpacked (9.10).
  shellDir: servedDirs(distDir, app.isPackaged).shellDir,
};

function denyDefaultSession(): void {
  // Nothing uses the default session; deny it everything in case something ever loads there.
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
}

// ------------------------------------------------------------------------------------------- 4. commands

function writeResult(out: string | null, r: CommandResult): void {
  if (!out) return;
  try {
    fs.writeFileSync(out, JSON.stringify(r, null, 2) + '\n', { mode: 0o600 });
  } catch (e) {
    log(`could not write ${out}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function readExitCode(out: string | null): number | null {
  if (!out) return null;
  try {
    const r = JSON.parse(fs.readFileSync(out, 'utf8')) as { exitCode?: unknown };
    return typeof r.exitCode === 'number' && Number.isInteger(r.exitCode) ? r.exitCode : null;
  } catch {
    return null;
  }
}

async function runCommand(p: Extract<ParsedArgs, { cmd: 'map' | 'check' }>): Promise<number> {
  if (p.errors.length > 0) {
    const text = `blueline ${p.cmd}: ${p.errors.join('; ')}`;
    writeResult(p.out, { command: p.cmd, exitCode: 2, text, json: { error: 'usage', errors: p.errors } });
    log(text);
    return 2;
  }
  if (p.cmd === 'map') {
    if (!p.map || !p.out) {
      const text = 'blueline map: missing --bl-args or --bl-out';
      writeResult(p.out, { command: 'map', exitCode: 2, text, json: { error: 'usage' } });
      log(text);
      return 2;
    }
    return await runMapCommand(p.map, p.out);
  }
  // The Edit menu's roles make Cmd+C and Cmd+V work on macOS (Wispr Flow pastes, D2); undo and redo are
  // the focused field's own. The Diagnostics window routes its app chords itself.
  installAppMenu({
    run: (a) => {
      const wc = allWebContents.getFocusedWebContents();
      if (a === 'undo') wc?.undo();
      else if (a === 'redo') wc?.redo();
    },
    platform: process.platform,
    devTools: !app.isPackaged,
  });
  await openDiagnostics({ auto: p.check.auto, outFile: p.out ?? undefined });
  return readExitCode(p.out) ?? 0;
}

const SIGNAL_EXIT: Readonly<Record<string, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * `check` stops on SIGINT, SIGTERM and SIGHUP (the `blueline` command passes on the ones it receives)
 * instead of Electron's default quit, which closed the window and reported success: check.json is saved if
 * guided steps were recorded, the result says the run was interrupted (128 + n), and the app exits. `map`
 * handles the same signals itself (map-command.ts: it deletes its probe copy first).
 */
function installCheckInterrupts(cmd: Extract<ParsedArgs, { cmd: 'check' }>): (why: string, code: number) => void {
  let stopping = false;
  const stop = (why: string, code: number): void => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      const savedTo = await Promise.race([interruptDiagnostics(), new Promise<null>((r) => setTimeout(() => r(null), 3000))]).catch(() => null);
      const text = `blueline check: interrupted (${why})${savedTo ? `; check.json: ${savedTo}` : '.'}`;
      log(text);
      writeResult(cmd.out, { command: 'check', exitCode: code, text, json: { error: 'interrupted', why, savedTo } });
      removeTempDirs();
      app.exit(code);
    })();
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => stop(sig, SIGNAL_EXIT[sig]));
  return stop;
}

/**
 * Calls `onGone` once the process `pid` (the `blueline` command, --bl-parent) no longer exists. Under
 * xvfb-run the app's parent is xvfb-run, not the command, so a command killed outright (SIGKILL, a crash)
 * is noticed only this way; the run stops instead of leaving a probe run or a Diagnostics window behind.
 */
function watchParent(pid: number, onGone: () => void): void {
  const timer = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return; // EPERM: it exists
      clearInterval(timer);
      onGone();
    }
  }, 500);
  timer.unref();
}

if (parsed.cmd === 'pdf') {
  // `blueline pdf` (6.1, 6.9 Save as PDF): headless like map; pdf-command.ts handles its signals, its parent
  // and its result file.
  const cmd = parsed;
  app.on('window-all-closed', () => undefined);
  void app.whenReady().then(async () => {
    denyDefaultSession();
    let code: number;
    try {
      code = await runPdfCommand(cmd, { parent: parseParentArg(process.argv) });
    } catch (e) {
      log(`blueline pdf failed: ${e instanceof Error ? e.message : String(e)}`);
      code = 1;
    }
    removeTempDirs();
    app.exit(code);
  });
} else if (parsed.cmd === 'map' || parsed.cmd === 'check') {
  const cmd = parsed;
  // `map --reduced-motion`: Chromium switches only take effect before ready. map runs in its own process, so
  // the switch reaches only the render views of this run.
  if (cmd.cmd === 'map' && cmd.map?.reducedMotion === true) app.commandLine.appendSwitch('force-prefers-reduced-motion');
  // Windows a command opens close on their own; the command decides when the app exits.
  app.on('window-all-closed', () => undefined);
  void app.whenReady().then(async () => {
    denyDefaultSession();
    // Installed after ready: while it starts, Electron installs its own SIGINT, SIGTERM and SIGHUP handlers
    // (a graceful quit), which would replace handlers installed earlier.
    const stopCheck = cmd.cmd === 'check' ? installCheckInterrupts(cmd) : null;
    const parent = parseParentArg(process.argv);
    if (parent !== null) {
      watchParent(parent, () => {
        const why = `the command that started blueline ${cmd.cmd} went away`;
        log(why);
        // map stops through its own SIGHUP handler, which deletes the probe copy first (section 10, Mutation
        // probe step 1); before or after the probe there is nothing to delete, and SIGHUP ends the app. On
        // Windows (no xvfb-run) map's own parent watchdog covers it.
        if (stopCheck) stopCheck(why, SIGNAL_EXIT.SIGHUP);
        else if (process.platform !== 'win32') process.kill(process.pid, 'SIGHUP');
      });
    }
    let code: number;
    try {
      code = await runCommand(cmd);
    } catch (e) {
      const text = `blueline ${cmd.cmd} failed: ${e instanceof Error ? e.message : String(e)}`;
      log(text);
      writeResult(cmd.out, { command: cmd.cmd, exitCode: 1, text, json: { error: 'failed', message: text } });
      code = 1;
    }
    // app.exit skips will-quit, so the private folders go now.
    removeTempDirs();
    app.exit(code);
  });
} else {
  startApp(parsed);
}

// ------------------------------------------------------------------------------------------- 4. open

function startApp(p: Extract<ParsedArgs, { cmd: 'open' }>): void {
  for (const e of p.errors) log(`ignored: ${e}`);
  const cwd = process.cwd();
  const files = p.files.map((f) => path.resolve(cwd, f));
  const lockData: SecondInstanceData = { v: 1, cmd: 'open', files, protected: p.protected, cwd };
  if (!app.requestSingleInstanceLock(lockData as unknown as Record<string, unknown>)) {
    // The running instance opens the files (second-instance), as a double-click does (6.1).
    app.quit();
    return;
  }
  for (const f of files) openFiles.queue({ path: f, protected: p.protected });

  app.on('second-instance', (_e, argv, workingDirectory, additionalData) => {
    const d = validateSecondInstanceData(additionalData);
    let opens: PendingOpen[] = [];
    if (d) opens = d.files.map((f) => ({ path: path.resolve(d.cwd, f), protected: d.protected }));
    else {
      // Older or foreign launchers: argv is not exact (Chromium reorders and adds switches), but plain paths survive.
      const a = parseAppArgs(argv, { defaultApp: process.defaultApp === true });
      if (a.cmd === 'open') opens = a.files.map((f) => ({ path: path.resolve(workingDirectory, f), protected: a.protected }));
    }
    if (opens.length === 0) {
      bringForward();
      return;
    }
    for (const o of opens) openFiles.queue(o);
  });

  let controllerRef: AppController | null = null;
  let welcomeRef: FirstRunController | null = null;
  let settingsRef: SettingsController | null = null;
  // A test build shows the Open dialog at a launch without a file (the harness answers it), unless the test asks
  // for the real startup windows.
  const autoWelcome = !TEST || process.env.BLUELINE_TEST_FIRST_RUN === '1';

  /**
   * A launch without a file, or a second launch without one while no Blueline window is open (6.0 First run, as
   * decided for Phase 1; first-run.ts startupWindow): the first-run welcome on the first launch; later the Open
   * window on Windows and Linux, and nothing on macOS (the app stays in the Dock; File › Open works). The app
   * quits when that window closes with no document open (window-all-closed).
   */
  const noFileStart = (): void => {
    const controller = controllerRef;
    if (!controller || controller.all().length > 0) return;
    if (autoWelcome) {
      welcomeRef?.showForLaunch();
      return;
    }
    void controller.showOpenDialog(false).then(() => {
      if (controller.all().length === 0 && process.platform !== 'darwin') app.quit();
    });
  };

  /** Restored, shown and focused: a window behind another app, minimised, or hidden. */
  const raise = (w: BrowserWindow): void => {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  };

  /**
   * A second launch without a file (6.1 Mechanics; review finding 26): the Blueline window that is open comes
   * forward, in the order secondLaunchFocus gives (a document window, the welcome or Open window, Settings, any
   * other such as Diagnostics); with none open, noFileStart. Windows the user never sees (offscreen renders,
   * hidden helpers) do not count.
   */
  const bringForward = (): void => {
    if (!controllerRef) return;
    const doc = controllerRef.focused();
    const settingsWc = settingsRef?.webContentsId();
    const settingsContents = typeof settingsWc === 'number' ? allWebContents.fromId(settingsWc) : undefined;
    const settingsWin = settingsContents ? BrowserWindow.fromWebContents(settingsContents) : null;
    const other =
      BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w !== settingsWin && !w.webContents.isOffscreen() && w.isFocusable() && (w.isVisible() || w.isMinimized()),
      ) ?? null;
    switch (secondLaunchFocus({ document: doc !== null, welcome: welcomeRef?.isOpen() ?? false, settings: settingsWin !== null && !settingsWin.isDestroyed(), other: other !== null })) {
      case 'document':
        doc?.focus();
        return;
      case 'welcome':
        welcomeRef?.focus();
        return;
      case 'settings':
        if (settingsWin) raise(settingsWin);
        return;
      case 'other':
        if (other) raise(other);
        return;
      default:
        noFileStart();
    }
  };

  // 6.1: one window per document; the app quits with its last window, except on macOS.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  void app.whenReady().then(async () => {
    denyDefaultSession();
    const editor = loadEditorDetailed(distDir);
    if (editor.why) log(`Edit capability off: ${editor.why}`);
    const userData = app.getPath('userData');
    const config = ConfigStore.forUserData(userData, (e) => log(`config.json not saved: ${e.message}`));
    const cfg = config.load();
    const { person, patch } = resolvePerson(cfg, { gitName: () => gitUserName(), osName: () => osUserName() });
    if (patch) void config.update(patch);
    let blockPort: number;
    try {
      blockPort = await pickClosedLoopbackPort();
    } catch (e) {
      log(`no loopback port for the Protected proxy: ${e instanceof Error ? e.message : String(e)}`);
      app.exit(1);
      return;
    }
    const devTools = !app.isPackaged || TEST;

    // 9.6 native/: the macOS helper (default app, quarantine) or Windows' Default Apps link; markers read
    // through it from the first open on (trust-native).
    if (process.platform === 'darwin') {
      configureNativeHelper({ binary: findHelperBinary({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, distDir }), appBundle: app.isPackaged ? appBundleOf(app.getPath('exe')) : null, log });
    } else if (process.platform === 'win32') {
      configureNativeHelper({ openExternal: (u) => shell.openExternal(u), log });
    } else {
      configureNativeHelper({ log });
    }
    app.on('will-quit', () => disposeNativeHelper());
    // 6.10: decisions remembered per realpath and marker (trust.json), and Settings › Trust (config.json).
    const trustStore = TrustStore.forUserData(userData, (e) => log(`trust.json not saved: ${e.message}`)).load();
    const trustSettings = new TrustSettings(config, appLocationOptions());
    // 6.1 Open Recent (recent.json, and the system's lists on macOS and Windows).
    const recent = RecentFiles.forUserData(userData, { app, platform: process.platform, log });
    recent.load();
    void recent.refresh();
    // 6.7, 6.9: every render product reads the host (the deck preload, app data for thumbnails, the log).
    setRenderHost({ preload: paths.preloadDeck, userData, log, devTools: false });

    let settings: SettingsController | null = null;
    let firstRun: FirstRunController | null = null;
    const cliUi: CliInstallUi = {
      showMessageBox: (opts) => {
        const parent = controllerRef?.focused()?.win;
        return parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts);
      },
      log,
    };
    const controller = new AppController({
      capabilities: editor.capabilities,
      paths,
      userData,
      config,
      person,
      blockPort,
      test: TEST,
      devTools,
      platform: process.platform,
      log,
      trustStore,
      trustSettings,
      recent,
      // Help › Install Command Line Tool (6.1): links `blueline` to the shipped command (cli-install.ts).
      installCli: () =>
        runInstallCommandLineTool(
          createCliInstallEnv({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, distDir, choose: chooseWithDialog(cliUi) }),
          cliUi,
        ),
      openSettings: (pane) => settings?.open(pane),
      showWelcome: () => firstRun?.show(),
      noteMode: (realpath, mode) => firstRun?.noteMode(realpath, mode),
      onMenuState: () => buildMenu(),
    });
    controllerRef = controller;

    // The app menu follows the focused window (menu.ts MenuState) and the recent list.
    const buildMenu = (): void =>
      installAppMenu({
        run: (a) => controller.run(a),
        platform: process.platform,
        devTools,
        state: controller.menuState(),
        recent: recent.menuItems((p) => void controller.open(p, { protected: false })),
        appName: app.getName(),
      });
    buildMenu();
    recent.onChange(() => controller.menuChanged());
    app.on('browser-window-focus', () => {
      controller.menuChanged();
      void recent.refresh();
    });
    app.on('browser-window-blur', () => controller.menuChanged());

    // The rail's thumbnails: app://shell/thumbs/<docId>/<name>, read from that window's own cache (protocol.ts).
    setShellThumbResolver((key, name) => {
      const w = docWindowByKey(key);
      return w && !w.closing ? readThumb(userData, w.doc.fileKey, name) : Promise.resolve(null);
    });

    // Settings (6.1 General, 6.10 Trust): one window; a change of the strict option or the allowlist re-applies
    // every open document's policy (folders apply at the next open, 6.10 When it applies).
    settings = installSettingsWindow({
      settings: trustSettings,
      helper: nativeHelper,
      preload: path.join(distDir, 'preload-settings.cjs'),
      shellDir: paths.shellDir,
      platform: process.platform,
      devTools,
      // The setting that changed: a folder change shapes no open window's policy, so it rebuilds no render product.
      onTrustSettingsChanged: (change) => controller.trustSettingsChanged(change),
      log,
      test: TEST,
    });
    settingsRef = settings;

    // 6.1 Ways in: files dropped on a window's shell areas (or the welcome window) open as File › Open does.
    installDropHandler({
      open: (p) => controller.open(p, { protected: false }),
      report: (from, r) => {
        const text = dropResultText(r);
        if (!text) return;
        const w = docWindowByKey(from.windowKey);
        if (w) w.toast(text, r.opened > 0 ? 'info' : 'warn');
        else void dialog.showMessageBox({ type: 'warning', message: 'Some files were not opened', detail: text, buttons: ['OK'] }).catch(() => undefined);
      },
      log,
    });

    // 6.0 First run: the welcome window.
    firstRun = installFirstRun({
      settings: configFirstRunSettings(config, () => person.name),
      helper: nativeHelper,
      open: async (p) => (await controller.open(p, { protected: false })) !== null,
      sampleSource: path.join(assetsDir(distDir, app.isPackaged), 'sample', SAMPLE_FILE),
      userData,
      preload: path.join(distDir, 'preload-welcome.cjs'),
      shellDir: paths.shellDir,
      platform: process.platform,
      devTools,
      onNameChanged: (n) => {
        person.name = n;
      },
      log,
      test: TEST,
    });
    welcomeRef = firstRun;

    if (TEST) exposeTestHooks(controller);

    const queued = openFiles.start((o) => void controller.open(o.path, { protected: o.protected }));
    for (const o of queued) await controller.open(o.path, { protected: o.protected });

    if (controller.all().length === 0 && queued.length === 0) {
      // No file given (noFileStart). macOS may still deliver one through open-file right after launch.
      setTimeout(noFileStart, process.platform === 'darwin' ? 600 : 0);
    } else if (controller.all().length === 0 && process.platform !== 'darwin') {
      // Every file failed to open: once the user has read the errors, there is nothing left to show.
      await controller.dialogsSettled();
      if (controller.all().length === 0) app.quit();
    }
    // Started to open a file (or to run a command): no welcome window; the file is what the user wanted.
  });

  app.on('activate', () => {
    // macOS: a click on the Dock icon. With no document window, an open welcome comes forward; with no Blueline
    // window at all, the launch rule applies (noFileStart): the first-run welcome until it has been seen, then
    // nothing (File › Open works from the menu bar). macOS brings any other open window forward itself.
    if (!controllerRef || controllerRef.all().length > 0) return;
    if (welcomeRef?.focus()) return;
    if (BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && !w.webContents.isOffscreen() && w.isFocusable() && (w.isVisible() || w.isMinimized()))) return;
    noFileStart();
  });

  // Notes are written atomically; a write still in flight finishes before the process exits (at most 3 s).
  // With nothing pending, quitting is not delayed at all.
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting || !controllerRef || !controllerRef.writesPending()) return;
    e.preventDefault();
    quitting = true;
    void Promise.race([controllerRef.idle(), new Promise((r) => setTimeout(r, 3000))]).finally(() => app.quit());
  });
}

/**
 * BLUELINE_TEST=1 only: read-only views of main's state for E2E and security tests
 * (`electronApp.evaluate(() => globalThis.__blTest.windows())`).
 */
function exposeTestHooks(controller: AppController): void {
  (globalThis as Record<string, unknown>).__blTest = {
    windows: () =>
      controller.all().map((w) => ({
        docId: w.doc.docId,
        realpath: w.doc.realpath,
        fileName: w.doc.fileName,
        trust: w.doc.trust(),
        trustReason: w.doc.trustReason,
        partition: w.doc.partition,
        networkAllowed: w.doc.networkAllowed(),
        editingAllowed: w.doc.editingAllowed(),
        appMode: w.appMode,
        handshakes: w.handshakes,
        textField: w.deckTextFieldFocused(),
        sessionFile: w.sessionFile,
        windowId: w.win.id,
        shellWebContentsId: w.win.webContents.id,
        deckWebContentsId: w.deck.webContents.id,
        deckUrl: w.deck.webContents.getURL(),
        // The deck view in the window's content coordinates (it sits in a clipping container, views.ts).
        deckBounds: (() => {
          const c = w.slot.getBounds();
          const d = w.deck.getBounds();
          return { x: c.x + d.x, y: c.y + d.y, width: d.width, height: d.height };
        })(),
        containerBounds: w.slot.getBounds(),
        zoomFactor: w.deck.webContents.getZoomFactor(),
        view: w.viewInfo(),
        reloads: w.reloads,
        reloadStatus: w.reloadStatus,
        fullScreen: w.win.isFullScreen(),
        contentSize: w.win.getContentSize(),
        state: w.state(),
      })),
    menu: () => controller.menuState(),
    focusedWebContentsId: () => allWebContents.getFocusedWebContents()?.id ?? null,
    open: (p: string, prot = false) => controller.open(p, { protected: prot }).then((w) => w?.doc.docId ?? null),
    run: (action: string, docId?: string) => {
      const w = docId ? controller.all().find((x) => x.doc.docId === docId) ?? null : controller.focused();
      controller.run(action as Parameters<AppController['run']>[0], w);
    },
    /** The rail: show entry `entry` of a window (as a click on its thumbnail or outline entry does). */
    show: (docId: string, entry: number) => controller.all().find((x) => x.doc.docId === docId)?.showEntry(entry) ?? Promise.resolve(false),
    /** Find (6.9) as the shell calls it. */
    find: (docId: string, query: string) => controller.all().find((x) => x.doc.docId === docId)?.find(query) ?? null,
    findShow: (docId: string, slide: number, matchIndex: number) =>
      controller.all().find((x) => x.doc.docId === docId)?.findShow(slide, matchIndex) ?? Promise.resolve(false),
    /**
     * Blueline's own write of a document (what Phase 2's write queue does: DeckIO.atomicWrite, which sets
     * knownHash), so the tests can check that it never reloads the view (9.2 Watcher step 3).
     */
    ownWrite: async (docId: string, text: string) => {
      const w = controller.all().find((x) => x.doc.docId === docId);
      if (!w) throw new Error('no such window');
      const io = w.doc.io(() => true);
      await io.atomicWrite(new TextEncoder().encode(text), io.sha256(await io.read()));
    },
  };
}
