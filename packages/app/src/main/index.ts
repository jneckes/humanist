// Electron main entry (dist/main.cjs). Order matters:
//   1. `open-file` is listened for at once, before anything async (6.1: macOS delivers files through
//      open-file, which must be listened for early);
//   2. the blueline and app schemes are registered privileged before `ready` (9.1 Registration);
//   3. BLUELINE_USER_DATA overrides userData before `ready` (tests);
//   4. `open` takes the single-instance lock and hands a second launch's files to the running instance
//      (6.1 Mechanics). `map` and `check` never forward: they run standalone, with their own Chromium
//      storage, write their CommandResult to --bl-out and exit.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, session, webContents as allWebContents } from 'electron';
import type { CommandResult } from '@blueline/core/ipc';
import { parseAppArgs, validateSecondInstanceData, type ParsedArgs, type SecondInstanceData } from './args';
import { ConfigStore } from './config';
import { AppController } from './controller';
import { openDiagnostics } from './diagnostics';
import { loadEditorDetailed } from './editor-loader';
import { gitUserName, osUserName, resolvePerson } from './identity';
import { runMapCommand } from './map-command';
import { installAppMenu } from './menu';
import { pickClosedLoopbackPort } from './network-policy';
import { registerPrivilegedSchemes } from './protocol';
import type { AppPaths } from './window';

// ------------------------------------------------------------------------------------------- 1. open-file

interface PendingOpen {
  path: string;
  protected: boolean;
}
const early: PendingOpen[] = [];
let deliver: ((o: PendingOpen) => void) | null = null;
app.on('open-file', (event, p) => {
  event.preventDefault();
  const o = { path: p, protected: false };
  if (deliver) deliver(o);
  else early.push(o);
});

// ------------------------------------------------------------------------------------------- 2–3. before ready

const TEST = process.env.BLUELINE_TEST === '1';
const log = (msg: string): void => {
  console.error(`[blueline] ${msg}`);
};

app.setName('Blueline');
registerPrivilegedSchemes();
// Every renderer runs sandboxed, whatever its webPreferences say (9.9 Always; the shell, 9.1). Each view
// also sets sandbox: true itself. With --no-sandbox (development as root only) enableSandbox makes the
// network service crash in a loop ("Running as root without --no-sandbox is not supported"), so it is
// skipped there; the OS sandbox is off in that case anyway.
if (app.commandLine.hasSwitch('no-sandbox')) log('--no-sandbox: the OS sandbox is off (development only)');
else app.enableSandbox();

const parsed: ParsedArgs = parseAppArgs(process.argv, { defaultApp: process.defaultApp === true });
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
} else if (parsed.cmd === 'map') {
  // `map` keeps no session state (section 10, Mutation probe step 1): a private userData.
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
  shellDir: path.join(distDir, 'shell'),
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

if (parsed.cmd === 'map' || parsed.cmd === 'check') {
  const cmd = parsed;
  // Windows a command opens close on their own; the command decides when the app exits.
  app.on('window-all-closed', () => undefined);
  void app.whenReady().then(async () => {
    denyDefaultSession();
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
  for (const f of files) early.push({ path: f, protected: p.protected });

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
      controllerRef?.focused()?.focus();
      return;
    }
    for (const o of opens) {
      if (deliver) deliver(o);
      else early.push(o);
    }
  });

  let controllerRef: AppController | null = null;

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
    const controller = new AppController({
      capabilities: editor.capabilities,
      paths,
      userData,
      config,
      person,
      blockPort,
      test: TEST,
      devTools: !app.isPackaged || TEST,
      platform: process.platform,
      log,
    });
    controllerRef = controller;
    installAppMenu({ run: (a) => controller.run(a), platform: process.platform, devTools: !app.isPackaged || TEST });
    if (TEST) exposeTestHooks(controller);

    deliver = (o) => void controller.open(o.path, { protected: o.protected });
    const queued = early.splice(0);
    for (const o of queued) await controller.open(o.path, { protected: o.protected });

    if (controller.all().length === 0 && queued.length === 0) {
      // No file given. macOS may still deliver one through open-file right after launch; elsewhere ask.
      // Phase 1 replaces this with the first-run welcome window (6.0).
      setTimeout(
        () => {
          if (controller.all().length === 0) {
            void controller.showOpenDialog(false).then(() => {
              if (controller.all().length === 0 && process.platform !== 'darwin') app.quit();
            });
          }
        },
        process.platform === 'darwin' ? 600 : 0,
      );
    } else if (controller.all().length === 0 && process.platform !== 'darwin') {
      // Every file failed to open: once the user has read the errors, there is nothing left to show.
      await controller.dialogsSettled();
      if (controller.all().length === 0) app.quit();
    }
  });

  app.on('activate', () => {
    // macOS: clicking the Dock icon with no window open asks for a file (Phase 1: the welcome window).
    if (controllerRef && controllerRef.all().length === 0) void controllerRef.showOpenDialog(false);
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
        deckBounds: w.deck.getBounds(),
        state: w.state(),
      })),
    focusedWebContentsId: () => allWebContents.getFocusedWebContents()?.id ?? null,
    open: (p: string, prot = false) => controller.open(p, { protected: prot }).then((w) => w?.doc.docId ?? null),
    run: (action: string, docId?: string) => {
      const w = docId ? controller.all().find((x) => x.doc.docId === docId) ?? null : controller.focused();
      controller.run(action as Parameters<AppController['run']>[0], w);
    },
  };
}
