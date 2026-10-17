// The Settings window (6.1 Becoming the default app: "Settings › General shows the current default and offers
// the same button"; 6.10 Settings › Trust: trusted and untrusted folders, "Block all network in Protected view";
// 9.9: the CDN allowlist, user-editable).
//
// It is a shell (9.1 Shell view): its own BrowserWindow (one at a time; opening it again focuses it), sandboxed
// and context-isolated in the shared `shell` session, loading app://shell/settings.html (the shell protocol
// sends the 9.1 CSP with every response), never navigating, with its own preload (dist/preload-settings.cjs)
// whose contextBridge API is named, typed functions only. Its channels (core/ipc-trust.ts SettingsToMain) are
// declared once through shellRouter() and answer only the Settings window's own shell: ShellIpc checks the
// sender (a registered shell, its main frame, origin app://shell) and these handlers check that it is the shell
// registered as `settings`, so neither a deck view nor a document window's shell can change a setting (9.1:
// "Main accepts trust changes only from the shell's trust-bar buttons and Settings").
//
// The shell never names a folder to add: main shows the folder dialog itself (Add…). Changes go to config.json
// through TrustSettings (folders.ts), and every change is passed to onTrustSettingsChanged, which re-applies
// every open document's network policy (the views item).

import { app, BrowserWindow, dialog, nativeTheme, session } from 'electron';
import * as os from 'node:os';
import { MainToSettings, SETTINGS_LIMITS, SettingsToMain, type DefaultAppStatus, type FolderKind, type SettingsPane, type SettingsState } from '@blueline/core/ipc-trust';
import { shellRouter } from './channels';
import type { TrustSettings, TrustSettingsChange } from './folders';
import { validateNoArgs, type ArgsValidator, type ShellSender, type Validated } from './ipc-guard';
import type { LocationOptions } from './markers';
import type { NativeHelper } from './native-helper';
import { installShellProtocol, SHELL_ORIGIN, SHELL_SCHEME } from './protocol';
import { installShellPolicy } from './trust-hooks';

/** The ShellIpc key of the Settings window's shell (document windows use their docId, Diagnostics `diagnostics`). */
export const SETTINGS_KEY = 'settings';
export const SETTINGS_URL = `${SHELL_ORIGIN}/settings.html`;
const SHELL_PARTITION = 'shell';

// ---------------------------------------------------------------------------------------------------
// Validators (ipc-guard.ts style: argument lists rebuilt, nothing but the expected primitives accepted)
// ---------------------------------------------------------------------------------------------------

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const FOLDER_KINDS: readonly FolderKind[] = ['trusted', 'untrusted'];

function folderKind(v: unknown): FolderKind | null {
  return typeof v === 'string' && (FOLDER_KINDS as readonly string[]).includes(v) ? (v as FolderKind) : null;
}

/** A string argument: at most `max` UTF-16 units, no NUL or other control character, no lone surrogate. */
function plainString(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) return null;
  if (/[\u0000-\u001f\u007f]/.test(v) || LONE_SURROGATE.test(v)) return null;
  return v;
}

/** addFolder(kind). */
export const validateAddFolder: ArgsValidator<FolderKind> = (args): Validated<FolderKind> => {
  if (args.length !== 1) return { ok: false, why: 'one argument' };
  const kind = folderKind(args[0]);
  return kind ? { ok: true, value: kind } : { ok: false, why: 'kind' };
};

/** removeFolder(kind, folder). */
export const validateRemoveFolder: ArgsValidator<{ kind: FolderKind; folder: string }> = (args) => {
  if (args.length !== 2) return { ok: false, why: 'two arguments' };
  const kind = folderKind(args[0]);
  const folder = plainString(args[1], SETTINGS_LIMITS.folderPath);
  if (!kind) return { ok: false, why: 'kind' };
  if (folder === null) return { ok: false, why: 'folder' };
  return { ok: true, value: { kind, folder } };
};

/** setStrictProtected(on). */
export const validateStrict: ArgsValidator<boolean> = (args) => {
  if (args.length !== 1 || typeof args[0] !== 'boolean') return { ok: false, why: 'one boolean' };
  return { ok: true, value: args[0] };
};

/** addAllowlistHost(host) / removeAllowlistHost(host): the text the user typed; TrustSettings normalizes it. */
export const validateHost: ArgsValidator<string> = (args) => {
  if (args.length !== 1) return { ok: false, why: 'one argument' };
  // Longer than a host name so a pasted URL reaches normalizeAllowlistHost and gets its explanation.
  const h = plainString(args[0], 1024);
  return h === null ? { ok: false, why: 'host' } : { ok: true, value: h };
};

// ---------------------------------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------------------------------

export interface SettingsWindowDeps {
  settings: TrustSettings;
  /** The app's native helper (native-helper.ts nativeHelper). */
  helper: () => NativeHelper;
  /** dist/preload-settings.cjs */
  preload: string;
  /** dist/shell (app-paths.ts servedDirs(…).shellDir) */
  shellDir: string;
  platform: NodeJS.Platform;
  devTools: boolean;
  /**
   * Called after every change of the Trust settings, from Settings or anywhere else: re-apply each open
   * document's policy (DeckSessionHandle.update() for strict and allowlist changes; folder changes apply to the
   * next open, 6.10 When it applies).
   */
  onTrustSettingsChanged(change: TrustSettingsChange): void;
  log(msg: string): void;
  /** BLUELINE_TEST=1: exposes globalThis.__blSettings for the E2E and security suites. */
  test?: boolean;
}

export interface SettingsController {
  /** Opens Settings (or focuses it) on a pane. */
  open(pane?: SettingsPane): BrowserWindow;
  close(): void;
  isOpen(): boolean;
  /** The open window's shell webContents id (tests), or null. */
  webContentsId(): number | null;
}

let installed: SettingsController | null = null;

/**
 * Declares the Settings channels and returns the controller. Call once at startup, after app `ready`, with
 * the app's TrustSettings (the same object trustFor's folder lists and the deck policies read). Calling it
 * again returns the first controller.
 */
export function installSettingsWindow(deps: SettingsWindowDeps): SettingsController {
  if (installed) return installed;
  let current: SettingsWindow | null = null;

  const win = (from: ShellSender): SettingsWindow => {
    // Only the Settings window's own shell: document shells, Diagnostics and the welcome window are refused.
    if (from.windowKey !== SETTINGS_KEY || !current || current.wcId !== from.webContentsId) throw new Error('Refused');
    return current;
  };
  const r = shellRouter();
  r.handle(SettingsToMain.getState, validateNoArgs, (from) => win(from).state());
  r.handle(SettingsToMain.makeDefaultApp, validateNoArgs, (from) => win(from).makeDefault());
  r.handle(SettingsToMain.addFolder, validateAddFolder, (from, kind) => win(from).addFolder(kind));
  r.handle(SettingsToMain.removeFolder, validateRemoveFolder, async (from, p) => {
    const w = win(from);
    await deps.settings.removeFolder(p.kind, p.folder);
    w.push();
  });
  r.handle(SettingsToMain.setStrictProtected, validateStrict, async (from, on) => {
    const w = win(from);
    await deps.settings.setStrict(on);
    w.push();
  });
  r.handle(SettingsToMain.addAllowlistHost, validateHost, async (from, host) => {
    const w = win(from);
    const res = await deps.settings.addAllowlistHost(host);
    w.push();
    return res;
  });
  r.handle(SettingsToMain.removeAllowlistHost, validateHost, async (from, host) => {
    const w = win(from);
    await deps.settings.removeAllowlistHost(host);
    w.push();
  });
  r.handle(SettingsToMain.resetAllowlist, validateNoArgs, async (from) => {
    const w = win(from);
    await deps.settings.resetAllowlist();
    w.push();
  });

  deps.settings.onChange((change) => {
    try {
      deps.onTrustSettingsChanged(change);
    } catch (e) {
      deps.log(`trust settings: applying the change failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    current?.push();
  });

  const controller: SettingsController = {
    open(pane = 'general') {
      if (current && !current.win.isDestroyed()) {
        current.focus(pane);
        return current.win;
      }
      const w = new SettingsWindow(deps, pane, () => {
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
  };
  if (deps.test) (globalThis as Record<string, unknown>).__blSettings = { open: (pane?: SettingsPane) => controller.open(pane).webContents.id, close: () => controller.close(), webContentsId: () => controller.webContentsId() };
  installed = controller;
  return controller;
}

/**
 * The folders refuseAsTrustedFolder compares against, from Electron (6.10): the home folder, Desktop and
 * Downloads as the system names them (Windows folder redirection, localized XDG folders), and the temp folder.
 * Pass it to `new TrustSettings(config, appLocationOptions())`.
 */
export function appLocationOptions(): LocationOptions {
  const get = (name: 'home' | 'desktop' | 'downloads' | 'temp'): string | undefined => {
    try {
      return app.getPath(name);
    } catch {
      return undefined;
    }
  };
  const tmpdirs = [...new Set([get('temp'), os.tmpdir()].filter((t): t is string => typeof t === 'string' && t.length > 0))];
  return { home: get('home') ?? os.homedir(), desktop: get('desktop'), downloads: get('downloads'), tmpdirs };
}

class SettingsWindow {
  readonly win: BrowserWindow;
  readonly wcId: number;
  private defaultApp: DefaultAppStatus | null = null;
  private checking: Promise<void> | null = null;

  constructor(
    private readonly deps: SettingsWindowDeps,
    private pane: SettingsPane,
    onClosed: () => void,
  ) {
    const ses = session.fromPartition(SHELL_PARTITION);
    if (!ses.protocol.isProtocolHandled(SHELL_SCHEME)) installShellProtocol(ses, deps.shellDir);
    this.win = new BrowserWindow({
      width: 760,
      height: 680,
      minWidth: 560,
      minHeight: 460,
      show: false,
      title: 'Settings',
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
    shellRouter().registerShell(wc, { windowKey: SETTINGS_KEY });
    this.win.on('page-title-updated', (e) => e.preventDefault());
    this.win.once('ready-to-show', () => this.win.show());
    wc.on('did-finish-load', () => {
      this.push();
      this.sendPane();
    });
    // Windows: the user chooses the default in Default Apps settings and comes back; look again.
    this.win.on('focus', () => void this.checkDefault());
    this.win.on('closed', onClosed);
    void wc.loadURL(SETTINGS_URL).catch((e) => deps.log(`settings: the page failed to load: ${e instanceof Error ? e.message : String(e)}`));
    void this.checkDefault();
  }

  focus(pane: SettingsPane): void {
    if (this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
    this.pane = pane;
    this.sendPane();
  }

  private sendPane(): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(MainToSettings.showPane, this.pane);
  }

  state(): SettingsState {
    const s = this.deps.settings;
    const lists = { trusted: s.trustedFolders(), untrusted: s.untrustedFolders() };
    const platform = this.deps.platform;
    return {
      platform: platform === 'darwin' || platform === 'win32' || platform === 'linux' ? platform : 'other',
      defaultApp: this.defaultApp ? { ...this.defaultApp } : null,
      trustedFolders: lists.trusted,
      untrustedFolders: lists.untrusted,
      strictProtected: s.strict(),
      allowlist: [...s.allowlist()],
      allowlistIsDefault: s.allowlistIsDefault(),
    };
  }

  push(): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(MainToSettings.state, this.state());
  }

  /** Asks the platform whether Blueline is the default HTML app (one question at a time). */
  checkDefault(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      try {
        this.defaultApp = await this.deps.helper().isDefaultHtmlApp();
      } catch (e) {
        this.defaultApp = { known: false, isDefault: false, current: null, action: 'none', reason: e instanceof Error ? e.message : String(e) };
      } finally {
        this.checking = null;
      }
      this.push();
    })();
    return this.checking;
  }

  /** "Make Blueline your HTML app" (6.1): macOS calls the helper (from 26.4 the system asks); Windows opens Default Apps. */
  async makeDefault() {
    const r = await this.deps.helper().setDefaultHtmlApp();
    if (!r.ok && !r.declined) this.deps.log(`settings: default app not set: ${r.reason ?? 'unknown'}`);
    await this.checkDefault();
    return r;
  }

  /** Add… : main's folder dialog, then TrustSettings.addFolder (realpath, refusals, 6.10). */
  async addFolder(kind: FolderKind) {
    const opts: Electron.OpenDialogOptions = {
      title: kind === 'trusted' ? 'Add a trusted folder' : 'Add an untrusted folder',
      buttonLabel: 'Add',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    };
    const picked = this.win.isDestroyed() ? await dialog.showOpenDialog(opts) : await dialog.showOpenDialog(this.win, opts);
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };
    const res = await this.deps.settings.addFolder(kind, picked.filePaths[0]);
    this.push();
    return res;
  }
}
