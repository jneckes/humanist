// First run (6.0 First run; 9.9 Telemetry). On first launch (config.json `seen.welcome` not set) a welcome
// window offers three things: Open a file, Make Blueline your HTML app, and Try the sample deck, with a short
// tour. It also asks for the user's name, used on their notes (6.8), and asks once whether to send crash
// reports (9.9: "None by default. Crash reports are opt-in, asked once at first run"; v1 has no crash server,
// so the answer is stored and nothing is sent). Nothing else is asked, and no account is created.
//
// The welcome window is a shell (9.1 Shell view): its own BrowserWindow (one at a time; showing it again
// focuses it), sandboxed and context-isolated in the shared `shell` session, loading app://shell/welcome.html
// (the shell protocol sends the 9.1 CSP with every response), never navigating, with its own preload
// (dist/preload-welcome.cjs) whose contextBridge API is named, typed functions only. Its channels
// (core/ipc-files.ts WelcomeToMain) are declared once through shellRouter() and answer only the welcome
// window's own shell (windowKey `welcome`, and the webContents of the window that is open). The page never
// names a file: main shows the Open dialog itself, and the sample deck's path is main's.
//
// The sample deck ships in the app (dist/assets/sample, unpacked when packaged). It is not opened there: on
// first use it is copied to <userData>/sample/blueline-tour.html and the copy is opened, because
//   - the sample must be editable to show Edit (6.0: "shows Read, Review and Edit"), and the app bundle is
//     read-only and signed: an edit there would fail, or break the signature;
//   - a downloaded app's files can carry the download's quarantine marker (Archive Utility and a DMG copy mark
//     every file), so the bundled copy could open in Protected view with editing off. The copy is written from
//     the file's bytes, never with fs.copyFile (which copies extended attributes on macOS), so it carries no
//     marker: Blueline made it, and it opens Trusted like the user's own files (6.10);
//   - the user's practice edits and notes stay with their copy across launches and app updates.
// The tour is in the deck itself (its slides say what to press); the welcome window lists the three steps
// (Read → Review → Edit) and ticks each one when the sample's window is switched to that mode by the user with
// the shortcut shown (the views item reports mode changes through noteMode).

import { BrowserWindow, dialog, nativeTheme, session } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppMode } from '@blueline/core/ipc';
import { MainToWelcome, WELCOME_LIMITS, WelcomeToMain, type NameResult, type WelcomeOpenResult, type WelcomeState } from '@blueline/core/ipc-files';
import type { DefaultAppResult, DefaultAppStatus } from '@blueline/core/ipc-trust';
import { atomicWriteFile, readRegularFile } from './atomic-write';
import { shellRouter } from './channels';
import { WELCOME_WINDOW_KEY } from './drop';
import { validateNoArgs, type ArgsValidator, type ShellIpc, type ShellSender } from './ipc-guard';
import { installShellProtocol, SHELL_ORIGIN, SHELL_SCHEME } from './protocol';
import { installShellPolicy } from './trust-hooks';

export const WELCOME_KEY = WELCOME_WINDOW_KEY;
export const WELCOME_URL = `${SHELL_ORIGIN}/welcome.html`;
/** The sample deck's file name, in dist/assets/sample and in <userData>/sample. */
export const SAMPLE_FILE = 'blueline-tour.html';
const SHELL_PARTITION = 'shell';

// ------------------------------------------------------------------------------------------- settings

/** What first run reads and stores (config.json: `name`, `seen.welcome`, `crashReports`). */
export interface FirstRunSettings {
  welcomeSeen(): boolean;
  /** The name on the user's notes now. */
  name(): string;
  crashReports(): boolean | null;
  setName(name: string): Promise<void>;
  setCrashReports(on: boolean): Promise<void>;
  markWelcomeSeen(): Promise<void>;
}

/**
 * The parts of ConfigStore (config.ts) first run uses: `name` (6.8, as today), `seen.welcome` and
 * `crashReports` (the fields config.ts adds for first run; see the files-lifecycle contract request).
 */
export interface WelcomeConfigStore {
  get(): { name?: string; seen?: { welcome?: boolean }; crashReports?: boolean };
  update(patch: { name?: string; seen?: { welcome?: boolean }; crashReports?: boolean }): Promise<void>;
}

/** FirstRunSettings over config.json. `fallbackName` is the Person's name when config.json has none yet. */
export function configFirstRunSettings(config: WelcomeConfigStore, fallbackName: () => string = () => 'Me'): FirstRunSettings {
  return {
    welcomeSeen: () => config.get().seen?.welcome === true,
    name: () => config.get().name ?? fallbackName(),
    crashReports: () => {
      const c = config.get().crashReports;
      return typeof c === 'boolean' ? c : null;
    },
    setName: (name) => config.update({ name }),
    setCrashReports: (on) => config.update({ crashReports: on }),
    markWelcomeSeen: () => config.update({ seen: { welcome: true } }),
  };
}

// ------------------------------------------------------------------------------------------- validators

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A name as config.json stores it: trimmed, 1 to 200 characters, no control characters or lone surrogates. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > WELCOME_LIMITS.name * 4) return null;
  // Line breaks, tabs and other controls refuse the name (it is one line on a note), before runs of spaces collapse.
  if (CONTROL.test(v) || LONE_SURROGATE.test(v)) return null;
  const t = v.trim().replace(/\s+/g, ' ');
  if (t.length === 0 || t.length > WELCOME_LIMITS.name) return null;
  return t;
}

/** setName(name). The text the user typed; refused when cleanName cannot keep it. */
export const validateSetName: ArgsValidator<string> = (args) => {
  if (args.length !== 1 || typeof args[0] !== 'string') return { ok: false, why: 'one string' };
  if (args[0].length > WELCOME_LIMITS.name * 4) return { ok: false, why: 'too long' };
  return { ok: true, value: args[0] };
};

/** setCrashReports(on). */
export const validateCrashReports: ArgsValidator<boolean> = (args) => {
  if (args.length !== 1 || typeof args[0] !== 'boolean') return { ok: false, why: 'one boolean' };
  return { ok: true, value: args[0] };
};

// ------------------------------------------------------------------------------------------- the sample deck

function errCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
}

/**
 * <userData>/sample/blueline-tour.html: the user's copy of the bundled sample deck, made on first use from the
 * bundled file's bytes (no extended attributes, so no quarantine marker; see the module comment). An existing
 * copy is kept as it is (the user's edits and notes). Returns the copy's realpath.
 */
export async function ensureSampleCopy(source: string, userData: string): Promise<string> {
  const dir = path.join(userData, 'sample');
  const dest = path.join(dir, SAMPLE_FILE);
  try {
    const st = await fs.promises.lstat(dest);
    if (st.isFile()) return await fs.promises.realpath(dest);
    // Something else sits there (a folder, a link someone made): never follow or replace it.
    throw new Error(`${dest} is not a regular file`);
  } catch (e) {
    if (errCode(e) !== 'ENOENT') throw e;
  }
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const bytes = await readRegularFile(source, 16 * 1024 * 1024);
  // A new file: atomicWriteFile copies no attributes when there is no file yet, and writes it whole or not at all.
  await atomicWriteFile(dest, bytes, { newFileMode: 0o644 });
  return await fs.promises.realpath(dest);
}

// ------------------------------------------------------------------------------------------- the window

/** "Make Blueline your HTML app" (native-helper.ts NativeHelper; built by trust-native). */
export interface DefaultAppHelper {
  isDefaultHtmlApp(): Promise<DefaultAppStatus>;
  setDefaultHtmlApp(): Promise<DefaultAppResult>;
}

export interface FirstRunDeps {
  settings: FirstRunSettings;
  /** The app's native helper (native-helper.ts nativeHelper). */
  helper: () => DefaultAppHelper;
  /** File › Open's path: AppController.open(p, { protected: false }); true when a window shows the file. */
  open(p: string): Promise<boolean>;
  /** The bundled sample deck: dist/assets/sample/blueline-tour.html (app.asar.unpacked when packaged). */
  sampleSource: string;
  /** app.getPath('userData'). */
  userData: string;
  /** dist/preload-welcome.cjs */
  preload: string;
  /** dist/shell (app-paths.ts servedDirs(…).shellDir) */
  shellDir: string;
  platform: NodeJS.Platform;
  devTools: boolean;
  /** The user changed their name: the running app's Person takes it, for the notes made from now on (6.8). */
  onNameChanged?(name: string): void;
  log(msg: string): void;
  /** BLUELINE_TEST=1: exposes globalThis.__blWelcome for the E2E tests. */
  test?: boolean;
  /** The shell router (default shellRouter(); tests pass their own). */
  router?: ShellIpc;
}

export interface FirstRunController {
  /** First launch (`seen.welcome` not set): shows the welcome window. Returns whether it did. */
  maybeShow(): boolean;
  /** Shows the welcome window, or focuses it (Help › Welcome to Blueline; macOS `activate` with no window). */
  show(): BrowserWindow;
  close(): void;
  isOpen(): boolean;
  /** The open window's shell webContents id (tests), or null. */
  webContentsId(): number | null;
  /** A document window switched mode (the views item calls it): the tour ticks the step for the sample's window. */
  noteMode(realpath: string, mode: AppMode): void;
  /** The realpath of the user's sample copy, once it exists. */
  samplePath(): string | null;
}

function platformName(p: NodeJS.Platform): WelcomeState['platform'] {
  return p === 'darwin' || p === 'win32' || p === 'linux' ? p : 'other';
}

let installed: FirstRunController | null = null;

/** Declares the welcome channels and returns the controller. Call once after app `ready`; again returns the first. */
export function installFirstRun(deps: FirstRunDeps): FirstRunController {
  if (installed) return installed;
  let current: WelcomeWindow | null = null;
  const tour = { opened: false, modesSeen: new Set<AppMode>() };
  let sampleReal: string | null = null;

  const win = (from: ShellSender): WelcomeWindow => {
    // Only the welcome window's own shell: document shells, Settings and Diagnostics are refused.
    if (from.windowKey !== WELCOME_KEY || !current || current.wcId !== from.webContentsId) throw new Error('Refused');
    return current;
  };

  const state = (w: WelcomeWindow): WelcomeState => ({
    platform: platformName(deps.platform),
    name: deps.settings.name(),
    crashReports: deps.settings.crashReports(),
    defaultApp: w.defaultApp ? { ...w.defaultApp } : null,
    sample: { opened: tour.opened, modesSeen: (['read', 'review', 'edit'] as const).filter((m) => tour.modesSeen.has(m)) },
  });
  const push = () => current?.push(state(current));

  const r = deps.router ?? shellRouter();
  r.handle(WelcomeToMain.getState, validateNoArgs, (from) => state(win(from)));
  r.handle(WelcomeToMain.openFile, validateNoArgs, async (from): Promise<WelcomeOpenResult> => {
    const w = win(from);
    const opts: Electron.OpenDialogOptions = {
      title: 'Open',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'HTML documents', extensions: ['html', 'htm'] }],
    };
    const picked = w.win.isDestroyed() ? await dialog.showOpenDialog(opts) : await dialog.showOpenDialog(w.win, opts);
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };
    let opened = 0;
    for (const f of picked.filePaths) if (await deps.open(f)) opened++;
    if (opened === 0) return { ok: false, reason: 'The file could not be opened.' };
    // The user is on their way: the welcome window has done its job (its answers are already saved).
    w.win.close();
    return { ok: true };
  });
  r.handle(WelcomeToMain.makeDefaultApp, validateNoArgs, async (from) => {
    const w = win(from);
    let res: DefaultAppResult;
    try {
      res = await deps.helper().setDefaultHtmlApp();
    } catch (e) {
      res = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    // 6.1: from macOS 26.4 the system asks, and a declined prompt is "not now".
    if (!res.ok && !res.declined) deps.log(`welcome: default app not set: ${res.reason ?? 'unknown'}`);
    await w.checkDefault(push);
    return res;
  });
  r.handle(WelcomeToMain.openSample, validateNoArgs, async (from): Promise<WelcomeOpenResult> => {
    win(from);
    let p: string;
    try {
      p = await ensureSampleCopy(deps.sampleSource, deps.userData);
    } catch (e) {
      deps.log(`welcome: sample deck not copied: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, reason: 'The sample deck could not be copied into Blueline’s folder.' };
    }
    sampleReal = p;
    if (!(await deps.open(p))) return { ok: false, reason: 'The sample deck could not be opened.' };
    tour.opened = true;
    // It opens in Read: the tour's first step is done by opening it.
    tour.modesSeen.add('read');
    push();
    return { ok: true };
  });
  r.handle(WelcomeToMain.setName, validateSetName, async (from, raw): Promise<NameResult> => {
    win(from);
    const name = cleanName(raw);
    if (name === null) return { ok: false, name: deps.settings.name(), reason: `A name is 1 to ${WELCOME_LIMITS.name} characters, on one line.` };
    if (name !== deps.settings.name()) {
      await deps.settings.setName(name);
      try {
        deps.onNameChanged?.(name);
      } catch (e) {
        deps.log(`welcome: name change: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    push();
    return { ok: true, name };
  });
  r.handle(WelcomeToMain.setCrashReports, validateCrashReports, async (from, on) => {
    win(from);
    // 9.9 Telemetry: stored; v1 has no crash server, so nothing is sent whatever the answer.
    await deps.settings.setCrashReports(on);
    push();
  });
  r.handle(WelcomeToMain.close, validateNoArgs, (from) => {
    win(from).win.close();
  });

  const controller: FirstRunController = {
    maybeShow() {
      if (deps.settings.welcomeSeen()) return false;
      controller.show();
      return true;
    },
    show() {
      if (current && !current.win.isDestroyed()) {
        current.focus();
        return current.win;
      }
      const w = new WelcomeWindow(deps, r, push, () => {
        if (current === w) current = null;
      });
      current = w;
      return w.win;
    },
    close() {
      if (current && !current.win.isDestroyed()) current.win.close();
    },
    isOpen: () => current !== null && !current.win.isDestroyed(),
    webContentsId: () => (current && !current.win.isDestroyed() ? current.wcId : null),
    noteMode(realpath, mode) {
      if (!sampleReal || realpath !== sampleReal || tour.modesSeen.has(mode)) return;
      tour.modesSeen.add(mode);
      push();
    },
    samplePath: () => sampleReal,
  };
  if (deps.test) {
    (globalThis as Record<string, unknown>).__blWelcome = {
      show: () => controller.show().webContents.id,
      maybeShow: () => controller.maybeShow(),
      close: () => controller.close(),
      webContentsId: () => controller.webContentsId(),
      samplePath: () => controller.samplePath(),
      noteMode: (p: string, m: AppMode) => controller.noteMode(p, m),
    };
  }
  installed = controller;
  return controller;
}

class WelcomeWindow {
  readonly win: BrowserWindow;
  readonly wcId: number;
  defaultApp: DefaultAppStatus | null = null;
  private checking: Promise<void> | null = null;

  constructor(
    private readonly deps: FirstRunDeps,
    router: ShellIpc,
    private readonly pushState: () => void,
    onClosed: () => void,
  ) {
    const ses = session.fromPartition(SHELL_PARTITION);
    if (!ses.protocol.isProtocolHandled(SHELL_SCHEME)) installShellProtocol(ses, deps.shellDir);
    this.win = new BrowserWindow({
      width: 640,
      height: 760,
      minWidth: 520,
      minHeight: 520,
      show: false,
      title: 'Welcome to Blueline',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f2024' : '#f5f6f8',
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: SHELL_PARTITION,
        preload: deps.preload,
        spellcheck: false,
        devTools: deps.devTools,
        navigateOnDragDrop: false,
        webviewTag: false,
        safeDialogs: true,
      },
    });
    const wc = this.win.webContents;
    this.wcId = wc.id;
    installShellPolicy(ses, wc);
    // Registered before anything loads (9.1).
    router.registerShell(wc, { windowKey: WELCOME_KEY });
    this.win.on('page-title-updated', (e) => e.preventDefault());
    this.win.once('ready-to-show', () => {
      this.win.show();
      // Offered once (6.0 "On first launch"): recorded as soon as it is on screen, so a quit right away still
      // counts. Its answers are saved as they are given.
      void deps.settings.markWelcomeSeen().catch((e) => deps.log(`welcome: seen not saved: ${e instanceof Error ? e.message : String(e)}`));
    });
    wc.on('did-finish-load', () => this.pushState());
    // Windows: the user chooses the default in Default Apps settings and comes back; look again.
    this.win.on('focus', () => void this.checkDefault(this.pushState));
    this.win.on('closed', onClosed);
    void wc.loadURL(WELCOME_URL).catch((e) => deps.log(`welcome: the page failed to load: ${e instanceof Error ? e.message : String(e)}`));
    void this.checkDefault(this.pushState);
  }

  focus(): void {
    if (this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  push(s: WelcomeState): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(MainToWelcome.state, s);
  }

  /** Asks the platform whether Blueline is the default HTML app (one question at a time). */
  checkDefault(after: () => void): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      try {
        this.defaultApp = await this.deps.helper().isDefaultHtmlApp();
      } catch (e) {
        this.defaultApp = { known: false, isDefault: false, current: null, action: 'none', reason: e instanceof Error ? e.message : String(e) };
      } finally {
        this.checking = null;
      }
      after();
    })();
    return this.checking;
  }
}
