// The Settings window (6.1 Settings › General, 6.10 Settings › Trust, 9.9 allowlist and strict option; 9.1 Shell
// view): its validators, its channels with a fake Electron (only the Settings shell is answered), its preload
// API, the page's shell rules, the help text, and the packaging pieces: the electron-builder entries and a static
// check that installer.nsh removes everything it writes. Phase 2: Settings › General › Smart punctuation (6.3), the
// settings default in config.json.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

// ------------------------------------------------------------------------------------------- a fake Electron

const fake = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const windows: unknown[] = [];
  const state = { dialogResult: { canceled: true, filePaths: [] as string[] }, dialogCalls: [] as unknown[] };
  let nextId = 100;
  class FakeWebContents {
    id = nextId++;
    mainFrame = { processId: 1, routingId: this.id, origin: 'app://shell', parent: null };
    sent: [string, unknown][] = [];
    urls: string[] = [];
    private listeners = new Map<string, ((...a: unknown[]) => void)[]>();
    destroyed = false;
    isDestroyed() {
      return this.destroyed;
    }
    on(ev: string, fn: (...a: unknown[]) => void) {
      this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), fn]);
      return this;
    }
    once(ev: string, fn: (...a: unknown[]) => void) {
      return this.on(ev, fn);
    }
    emit(ev: string, ...a: unknown[]) {
      for (const fn of this.listeners.get(ev) ?? []) fn(...a);
    }
    send(channel: string, payload: unknown) {
      this.sent.push([channel, payload]);
    }
    async loadURL(u: string) {
      this.urls.push(u);
    }
    setWindowOpenHandler() {}
  }
  class BrowserWindow {
    webContents = new FakeWebContents();
    options: Record<string, unknown>;
    shown = 0;
    focused = 0;
    private listeners = new Map<string, ((...a: unknown[]) => void)[]>();
    destroyed = false;
    constructor(o: Record<string, unknown>) {
      this.options = o;
      windows.push(this);
    }
    on(ev: string, fn: (...a: unknown[]) => void) {
      this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), fn]);
      return this;
    }
    once(ev: string, fn: (...a: unknown[]) => void) {
      return this.on(ev, fn);
    }
    emit(ev: string, ...a: unknown[]) {
      for (const fn of this.listeners.get(ev) ?? []) fn(...a);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    restore() {}
    show() {
      this.shown++;
    }
    focus() {
      this.focused++;
    }
    close() {
      this.destroyed = true;
      this.webContents.destroyed = true;
      this.emit('closed');
      this.webContents.emit('destroyed');
    }
  }
  const fakeSession = {
    protocol: { isProtocolHandled: () => true, handle() {}, unhandle() {} },
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    setDevicePermissionHandler() {},
    webRequest: { onBeforeRequest() {} },
    on() {},
  };
  return { handlers, windows, state, BrowserWindow, FakeWebContents, fakeSession };
});

vi.mock('electron', () => ({
  ipcMain: {
    on() {},
    handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) {
      fake.handlers.set(channel, fn);
    },
  },
  BrowserWindow: fake.BrowserWindow,
  session: { fromPartition: () => fake.fakeSession },
  nativeTheme: { shouldUseDarkColors: false },
  dialog: {
    showOpenDialog: async (...a: unknown[]) => {
      fake.state.dialogCalls.push(a);
      return fake.state.dialogResult;
    },
  },
  app: { getPath: (n: string) => `/fake/${n}` },
}));

import { MainToSettings, PROTECTED_VIEW_HELP, SettingsToMain, protectedViewHelpText, type SettingsState } from '@blueline/core/ipc-trust';
import { shellRouter } from '../../../packages/app/src/main/channels';
import { ConfigStore, configGeneralSettings, sanitizeConfig, type GeneralSettingsState } from '../../../packages/app/src/main/config';
import { TrustSettings } from '../../../packages/app/src/main/folders';
import { createNativeHelper, REGISTERED_APP_NAME, WINDOWS_PROG_ID } from '../../../packages/app/src/main/native-helper';
import { DEFAULT_ALLOWLIST } from '../../../packages/app/src/main/network-policy';
import {
  SETTINGS_GENERAL_CHANNELS,
  SETTINGS_KEY,
  SETTINGS_URL,
  appLocationOptions,
  installSettingsWindow,
  validateAddFolder,
  validateHost,
  validateRemoveFolder,
  validateSmartPunctuation,
  validateStrict,
  type SettingsWindowState,
} from '../../../packages/app/src/main/settings-window';

const repo = path.resolve(__dirname, '../../..');

// ------------------------------------------------------------------------------------------- validators

describe('Settings validators (9.1: every argument checked in main)', () => {
  it('addFolder(kind)', () => {
    expect(validateAddFolder(['trusted'])).toEqual({ ok: true, value: 'trusted' });
    expect(validateAddFolder(['untrusted'])).toEqual({ ok: true, value: 'untrusted' });
    for (const bad of [[], ['TRUSTED'], ['other'], [1], ['trusted', '/x'], [{ kind: 'trusted' }]]) expect(validateAddFolder(bad).ok, JSON.stringify(bad)).toBe(false);
  });
  it('removeFolder(kind, folder)', () => {
    expect(validateRemoveFolder(['trusted', '/Users/j/Decks'])).toEqual({ ok: true, value: { kind: 'trusted', folder: '/Users/j/Decks' } });
    for (const bad of [['trusted'], ['trusted', ''], ['trusted', 42], ['x', '/a'], ['trusted', '/a\0b'], ['trusted', '/a\nb'], ['trusted', 'x'.repeat(4097)], ['trusted', '/\uD800'], ['trusted', '/a', 'extra']]) {
      expect(validateRemoveFolder(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it('setStrictProtected(on)', () => {
    expect(validateStrict([true])).toEqual({ ok: true, value: true });
    expect(validateStrict([false])).toEqual({ ok: true, value: false });
    for (const bad of [[], ['true'], [1], [true, false], [null]]) expect(validateStrict(bad).ok).toBe(false);
  });
  it('setSmartPunctuation(on)', () => {
    expect(validateSmartPunctuation([true])).toEqual({ ok: true, value: true });
    expect(validateSmartPunctuation([false])).toEqual({ ok: true, value: false });
    for (const bad of [[], ['true'], [0], [true, true], [null], [{ on: true }]]) expect(validateSmartPunctuation(bad).ok).toBe(false);
  });
  it('allowlist host', () => {
    expect(validateHost(['cdn.example.com'])).toEqual({ ok: true, value: 'cdn.example.com' });
    expect(validateHost(['https://cdn.example.com/x'])).toEqual({ ok: true, value: 'https://cdn.example.com/x' }); // TrustSettings explains
    for (const bad of [[], [''], [5], ['a\tb'], ['x'.repeat(1025)], ['a', 'b']]) expect(validateHost(bad).ok).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- the channels

describe('Settings channels: only the Settings window’s own shell is answered', () => {
  let root: string;
  let userData: string;
  let decks: string;
  let config: ConfigStore;
  let settings: TrustSettings;
  const changes: string[] = [];
  const generalChanges: GeneralSettingsState[] = [];
  let controller: ReturnType<typeof installSettingsWindow>;

  beforeAll(() => {
    const base = path.join(repo, 'test-results');
    fs.mkdirSync(base, { recursive: true });
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'unit-settings-')));
    userData = path.join(root, 'userData');
    decks = path.join(root, 'home', 'Decks');
    fs.mkdirSync(decks, { recursive: true });
    config = ConfigStore.forUserData(userData);
    config.load();
    settings = new TrustSettings(config, { platform: 'linux', home: path.join(root, 'home'), tmpdirs: ['/nonexistent-tmp'], env: {} });
    controller = installSettingsWindow({
      settings,
      helper: () => createNativeHelper({ platform: 'linux' }),
      preload: '/dist/preload-settings.cjs',
      shellDir: '/dist/shell',
      platform: 'linux',
      devTools: false,
      onTrustSettingsChanged: (c) => changes.push(c),
      general: configGeneralSettings(config),
      onGeneralSettingsChanged: (g) => generalChanges.push(g),
      log: () => undefined,
      test: true,
    });
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  type Win = InstanceType<typeof fake.BrowserWindow>;
  const settingsWin = () => fake.windows[0] as Win;
  const eventFrom = (wc: { id: number; mainFrame: unknown }) => ({ sender: wc, senderFrame: wc.mainFrame });
  const call = (channel: string, event: unknown, ...args: unknown[]) => fake.handlers.get(channel)!(event, ...args);

  const allChannels = () => [...Object.values(SettingsToMain), ...Object.values(SETTINGS_GENERAL_CHANNELS)];

  it('declares every SettingsToMain channel and Settings › General’s', () => {
    for (const c of allChannels()) expect(fake.handlers.has(c), c).toBe(true);
    expect(SETTINGS_GENERAL_CHANNELS.setSmartPunctuation).toBe('bl:settings:set-smart-punctuation');
  });

  it('opens one sandboxed window on app://shell/settings.html with its own preload; opening again focuses it', () => {
    controller.open('trust');
    expect(fake.windows).toHaveLength(1);
    const w = settingsWin();
    const prefs = w.options.webPreferences as Record<string, unknown>;
    expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: 'shell', preload: '/dist/preload-settings.cjs', devTools: false });
    expect(w.webContents.urls).toEqual([SETTINGS_URL]);
    expect(SETTINGS_URL).toBe('app://shell/settings.html');
    controller.open('general');
    expect(fake.windows).toHaveLength(1);
    expect(w.focused).toBe(1);
    expect(w.webContents.sent).toContainEqual([MainToSettings.showPane, 'general']);
    expect(controller.isOpen()).toBe(true);
    expect(controller.webContentsId()).toBe(w.webContents.id);
    expect((globalThis as Record<string, unknown>).__blSettings).toBeDefined();
  });

  it('getState from the Settings shell', async () => {
    const w = settingsWin();
    const s = (await call(SettingsToMain.getState, eventFrom(w.webContents))) as SettingsWindowState;
    expect(s).toMatchObject({ platform: 'linux', trustedFolders: [], untrustedFolders: [], strictProtected: false, allowlist: [...DEFAULT_ALLOWLIST], allowlistIsDefault: true, smartPunctuation: true });
  });

  it('refuses a document window’s shell, an unregistered sender (a deck view), another frame and another origin', async () => {
    const doc = new fake.FakeWebContents();
    shellRouter().registerShell(doc as never, { windowKey: '0123456789abcdef' });
    const deck = new fake.FakeWebContents();
    deck.mainFrame.origin = 'blueline://0123456789abcdef';
    const w = settingsWin();
    const subframe = { sender: w.webContents, senderFrame: { processId: 1, routingId: 999, origin: 'app://shell', parent: w.webContents.mainFrame } };
    const wrongOrigin = { sender: w.webContents, senderFrame: { ...w.webContents.mainFrame, origin: 'blueline://0123456789abcdef' } };
    for (const c of allChannels()) {
      const args = c === SettingsToMain.addFolder ? ['trusted'] : c === SettingsToMain.removeFolder ? ['trusted', decks] : c === SettingsToMain.setStrictProtected ? [true] : c === SETTINGS_GENERAL_CHANNELS.setSmartPunctuation ? [false] : c.includes('host') ? ['evil.example'] : [];
      for (const ev of [eventFrom(doc), eventFrom(deck), subframe, wrongOrigin]) await expect(call(c, ev, ...args), c).rejects.toThrow('Refused');
    }
    expect(settings.strict()).toBe(false);
    expect(config.get().defaults).toBeUndefined();
    expect(generalChanges).toEqual([]);
    expect(settings.allowlist()).not.toContain('evil.example');
    expect(fake.state.dialogCalls).toHaveLength(0);
    expect(changes).toEqual([]);
  });

  it('refuses malformed arguments from the Settings shell too', async () => {
    const ev = eventFrom(settingsWin().webContents);
    await expect(call(SettingsToMain.setStrictProtected, ev, 'yes')).rejects.toThrow('Refused');
    await expect(call(SettingsToMain.addFolder, ev, '/Users/j')).rejects.toThrow('Refused');
    await expect(call(SettingsToMain.removeFolder, ev, 'trusted')).rejects.toThrow('Refused');
    await expect(call(SettingsToMain.getState, ev, 'extra')).rejects.toThrow('Refused');
    await expect(call(SETTINGS_GENERAL_CHANNELS.setSmartPunctuation, ev, 'off')).rejects.toThrow('Refused');
    await expect(call(SETTINGS_GENERAL_CHANNELS.setSmartPunctuation, ev)).rejects.toThrow('Refused');
    expect(settings.strict()).toBe(false);
    expect(config.get().defaults).toBeUndefined();
  });

  it('Smart punctuation (6.3): the default in config.json, pushed to the page, and main is told to update the decks', async () => {
    const w = settingsWin();
    const ev = eventFrom(w.webContents);
    await call(SETTINGS_GENERAL_CHANNELS.setSmartPunctuation, ev, false);
    await config.idle();
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).defaults).toEqual({ smartPunctuation: false });
    expect(generalChanges).toEqual([{ smartPunctuation: false }]);
    const pushed = w.webContents.sent.filter(([c]) => c === MainToSettings.state).map(([, st]) => st as SettingsWindowState);
    expect(pushed[pushed.length - 1].smartPunctuation).toBe(false);
    expect(((await call(SettingsToMain.getState, ev)) as SettingsWindowState).smartPunctuation).toBe(false);
    // Setting it to what it is changes nothing.
    await call(SETTINGS_GENERAL_CHANNELS.setSmartPunctuation, ev, false);
    expect(generalChanges).toHaveLength(1);
    await call(SETTINGS_GENERAL_CHANNELS.setSmartPunctuation, ev, true);
    expect(generalChanges).toEqual([{ smartPunctuation: false }, { smartPunctuation: true }]);
    // Trust changes are not general ones.
    expect(changes).toEqual([]);
  });

  it('Add… shows main’s folder dialog; the shell never names the folder', async () => {
    const w = settingsWin();
    fake.state.dialogResult = { canceled: true, filePaths: [] };
    expect(await call(SettingsToMain.addFolder, eventFrom(w.webContents), 'trusted')).toEqual({ ok: false, canceled: true });
    fake.state.dialogResult = { canceled: false, filePaths: [decks] };
    expect(await call(SettingsToMain.addFolder, eventFrom(w.webContents), 'trusted')).toEqual({ ok: true, folder: decks });
    const [parent, opts] = fake.state.dialogCalls[1] as [unknown, { properties: string[] }];
    expect(parent).toBe(w);
    expect(opts.properties).toContain('openDirectory');
    expect(opts.properties).not.toContain('openFile');
    expect(changes).toEqual(['folders']);
    // The state pushed to the Settings shell lists it.
    const pushed = w.webContents.sent.filter(([c]) => c === MainToSettings.state).map(([, s]) => s as SettingsState);
    expect(pushed[pushed.length - 1].trustedFolders).toEqual([decks]);
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).trustedFolders).toEqual([decks]);
  });

  it('a refused folder comes back with its reason', async () => {
    fake.state.dialogResult = { canceled: false, filePaths: [path.join(root, 'home')] };
    expect(await call(SettingsToMain.addFolder, eventFrom(settingsWin().webContents), 'trusted')).toMatchObject({ ok: false, reason: 'The home folder cannot be a trusted folder.' });
  });

  it('Remove, strict and the allowlist change config.json and notify the policy owner', async () => {
    const ev = eventFrom(settingsWin().webContents);
    await call(SettingsToMain.removeFolder, ev, 'trusted', decks);
    await call(SettingsToMain.setStrictProtected, ev, true);
    expect(await call(SettingsToMain.addAllowlistHost, ev, 'Fonts.Example.com')).toEqual({ ok: true, host: 'fonts.example.com' });
    expect(await call(SettingsToMain.addAllowlistHost, ev, 'http://x.example/')).toMatchObject({ ok: false });
    await call(SettingsToMain.removeAllowlistHost, ev, 'unpkg.com');
    await config.idle();
    const disk = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    expect(disk.trustedFolders).toEqual([]);
    expect(disk.strictProtected).toBe(true);
    expect(disk.cdnAllowlist).toContain('fonts.example.com');
    expect(disk.cdnAllowlist).not.toContain('unpkg.com');
    await call(SettingsToMain.resetAllowlist, ev);
    expect(settings.allowlistIsDefault()).toBe(true);
    expect(changes).toEqual(['folders', 'folders', 'strict', 'allowlist', 'allowlist', 'allowlist']);
    expect(generalChanges).toHaveLength(2);
  });

  it('Make Blueline your HTML app goes to the helper (Linux: unsupported)', async () => {
    const r = await call(SettingsToMain.makeDefaultApp, eventFrom(settingsWin().webContents));
    expect(r).toMatchObject({ ok: false });
  });

  it('after the window closes, its shell is refused', async () => {
    const w = settingsWin();
    controller.close();
    expect(controller.isOpen()).toBe(false);
    await expect(call(SettingsToMain.getState, eventFrom(w.webContents))).rejects.toThrow('Refused');
    // A new window gets its own registration.
    controller.open();
    const w2 = fake.windows[1] as Win;
    await expect(call(SettingsToMain.getState, eventFrom(w2.webContents))).resolves.toBeDefined();
    expect(SETTINGS_KEY).toBe('settings');
  });

  it('appLocationOptions takes the home, Desktop, Downloads and temp folders from Electron', () => {
    expect(appLocationOptions()).toMatchObject({ home: '/fake/home', desktop: '/fake/desktop', downloads: '/fake/downloads' });
    expect(appLocationOptions().tmpdirs).toContain('/fake/temp');
  });
});

// ------------------------------------------------------------------------------------------- the preload

describe('preload-settings (9.1: named functions only)', () => {
  it('exposes window.blueline with the SettingsApi functions, each invoking its own channel', async () => {
    const exposed: Record<string, unknown> = {};
    const invoke = vi.fn(async (..._a: unknown[]) => undefined as unknown);
    const listeners = new Map<string, (e: unknown, p: unknown) => void>();
    vi.resetModules();
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (k: string, v: unknown) => (exposed[k] = v) },
      ipcRenderer: { invoke: (...a: unknown[]) => invoke(...a), on: (ch: string, fn: (e: unknown, p: unknown) => void) => listeners.set(ch, fn) },
    }));
    await import('../../../packages/app/src/preload/settings');
    expect(Object.keys(exposed)).toEqual(['blueline']);
    const api = exposed.blueline as Record<string, (...a: unknown[]) => unknown>;
    expect(Object.keys(api).sort()).toEqual(['addAllowlistHost', 'addFolder', 'getState', 'makeDefaultApp', 'onShowPane', 'onState', 'removeAllowlistHost', 'removeFolder', 'resetAllowlist', 'setSmartPunctuation', 'setStrictProtected']);
    for (const k of Object.keys(api)) expect(typeof api[k]).toBe('function');
    await api.getState();
    await api.makeDefaultApp();
    await api.addFolder('trusted');
    await api.removeFolder('untrusted', '/x');
    await api.setStrictProtected(true);
    await api.addAllowlistHost('a.example');
    await api.removeAllowlistHost('a.example');
    await api.resetAllowlist();
    await api.setSmartPunctuation(false);
    expect(invoke.mock.calls).toEqual([
      [SettingsToMain.getState],
      [SettingsToMain.makeDefaultApp],
      [SettingsToMain.addFolder, 'trusted'],
      [SettingsToMain.removeFolder, 'untrusted', '/x'],
      [SettingsToMain.setStrictProtected, true],
      [SettingsToMain.addAllowlistHost, 'a.example'],
      [SettingsToMain.removeAllowlistHost, 'a.example'],
      [SettingsToMain.resetAllowlist],
      // The preload's own copy of the channel name is main's (settings-window.ts SETTINGS_GENERAL_CHANNELS).
      [SETTINGS_GENERAL_CHANNELS.setSmartPunctuation, false],
    ]);
    const got: unknown[] = [];
    api.onState((s: unknown) => got.push(s));
    api.onShowPane((p: unknown) => got.push(p));
    listeners.get(MainToSettings.state)!({ sender: 'secret' }, { strictProtected: true });
    listeners.get(MainToSettings.showPane)!({ sender: 'secret' }, 'trust');
    expect(got).toEqual([{ strictProtected: true }, 'trust']);
    vi.doUnmock('electron');
  });
});

// ------------------------------------------------------------------------------------------- the page

describe('the Settings page follows 9.1 Shell view', () => {
  it('settings.html: the CSP, no inline script, style or handler', () => {
    const html = fs.readFileSync(path.join(repo, 'packages/app/src/shell/settings.html'), 'utf8');
    expect(html).toContain("default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toMatch(/<script src="settings\.js" defer><\/script>/);
    // Settings › General › Smart punctuation (6.3), off until main's state says it is offered.
    expect(html).toMatch(/<input id="smart-punctuation" type="checkbox" disabled>/);
  });

  it('settings.ts and preload/settings.ts use no HTML or style-string sinks and no raw ipcRenderer in the page', () => {
    const page = fs.readFileSync(path.join(repo, 'packages/app/src/shell/settings.ts'), 'utf8');
    expect(page).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML|cssText)\b|document\.write|setAttribute\(\s*['"]style['"]/);
    expect(page).not.toMatch(/ipcRenderer|require\(/);
    const preload = fs.readFileSync(path.join(repo, 'packages/app/src/preload/settings.ts'), 'utf8');
    expect(preload).toMatch(/contextBridge\.exposeInMainWorld\('blueline', api\)/);
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/);
  });

  it('the build bundles the page and its preload (scripts/build.mjs)', () => {
    const build = fs.readFileSync(path.join(repo, 'scripts/build.mjs'), 'utf8');
    expect(build).toContain("packages/app/src/preload/settings.ts");
    expect(build).toContain("'preload-settings.cjs'");
    expect(build).toContain("packages/app/src/shell/settings.ts");
  });
});

describe('About Protected view (6.10, 9.9, SECURITY.md)', () => {
  it('states what Protected view blocks and the two DNS channels that remain', () => {
    const text = protectedViewHelpText();
    for (const s of ['CDN allowlist', 'Block all network in Protected view', 'fetch', 'WebSocket', 'localhost', 'Downloads are blocked', 'cleared when its window closes', 'Enable editing']) expect(text).toContain(s);
    expect(PROTECTED_VIEW_HELP.remain).toHaveLength(2);
    expect(PROTECTED_VIEW_HELP.remain[0]).toMatch(/dns-prefetch/);
    expect(PROTECTED_VIEW_HELP.remain[1]).toMatch(/TURN/);
    expect(PROTECTED_VIEW_HELP.remainOutro).toMatch(/does not change these two/);
    expect(text).toMatch(/250 characters/);
    // 6.10 Remembered: what resets Allow network and Enable editing, and the limit (review findings 5, 28).
    expect(text).toMatch(/remembered for this file until another file takes its place/);
    expect(text).toMatch(/writes new content into the same file/);
    expect(text).toMatch(/On Windows/);
  });
});

// ------------------------------------------------------------------------------------------- config.json

describe('config.json Trust settings (sanitizeConfig)', () => {
  it('keeps valid folder lists, strict and the allowlist; drops invalid entries', () => {
    expect(
      sanitizeConfig({
        trustedFolders: ['/Users/j/Decks', 'relative', '/Users/j/Decks', 42, '/a\0b', '/x\ny'],
        untrustedFolders: ['/Users/j/Inbox'],
        strictProtected: true,
        cdnAllowlist: ['FONTS.googleapis.com', 'https://evil/', '127.0.0.1', 'fonts.googleapis.com', 'cdn.example.com'],
      }),
    ).toEqual({ trustedFolders: ['/Users/j/Decks'], untrustedFolders: ['/Users/j/Inbox'], strictProtected: true, cdnAllowlist: ['fonts.googleapis.com', 'cdn.example.com'] });
    expect(sanitizeConfig({ trustedFolders: '/Users/j', strictProtected: 'yes', cdnAllowlist: {} })).toEqual({});
    expect(sanitizeConfig({ trustedFolders: Array.from({ length: 900 }, (_, i) => `/d/${i}`) }).trustedFolders).toHaveLength(500);
  });
});

// ------------------------------------------------------------------------------------------- packaging

const req = createRequire(path.join(repo, 'package.json'));

describe('electron-builder entries for the helpers (6.1, 9.10)', () => {
  const builder = req('./packages/app/electron-builder.config.cjs');
  it('the macOS helper ships in Resources/helper only when it is built; the CLI entry is untouched', () => {
    const built = fs.existsSync(path.join(repo, 'native/macos/build/blueline-helper'));
    expect(builder.mac.extraResources).toEqual(built ? [{ from: path.join(repo, 'native/macos/build'), to: 'helper', filter: ['blueline-helper'] }] : []);
    expect(builder.extraResources).toEqual([expect.objectContaining({ to: 'cli' })]);
  });
  it('the NSIS include is build/installer.nsh, and the installer offers both install modes', () => {
    expect(builder.nsis.include).toBe(path.join(repo, 'packages/app/build/installer.nsh'));
    expect(fs.existsSync(builder.nsis.include)).toBe(true);
    expect(builder.nsis.oneClick).toBe(false);
    expect(builder.nsis.perMachine).toBe(false);
  });
  it('the helper looks in the place the config ships it', () => {
    const src = fs.readFileSync(path.join(repo, 'packages/app/src/main/native-helper.ts'), 'utf8');
    expect(src).toMatch(/path\.join\(o\.resourcesPath, 'helper', HELPER_NAME\)/);
    expect(src).toMatch(/'native', 'macos', 'build', HELPER_NAME/);
  });
});

describe('installer.nsh (6.1): every key written is removed on uninstall, in the same hive', () => {
  const nsh = fs.readFileSync(path.join(repo, 'packages/app/build/installer.nsh'), 'utf8');
  const code = nsh
    .split('\n')
    .map((l) => l.replace(/^\s*;.*$/, ''))
    .join('\n');
  const defines = new Map<string, string>();
  for (const m of code.matchAll(/!define\s+(\w+)\s+"([^"]*)"/g)) defines.set(m[1], m[2]);
  const expand = (s: string) => s.replace(/\$\{(\w+)\}/g, (all, k: string) => defines.get(k) ?? all);
  const macro = (name: string) => {
    const m = new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`).exec(code);
    if (!m) throw new Error(`no macro ${name}`);
    return m[1];
  };
  const args = (line: string) => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const install = macro('customInstall');
  const uninstall = macro('customUnInstall');
  const writes = install
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^WriteReg(Str|ExpandStr|DWORD|None|Bin)\b/.test(l))
    .map((l) => {
      const [, root, key, value] = args(l);
      return { root, key: expand(key), value: expand(value) };
    });
  const deletes = uninstall
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^DeleteReg(Key|Value)\b/.test(l))
    .map((l) => {
      const a = args(l);
      const ifempty = a[1] === '/ifempty';
      const rest = ifempty ? a.slice(2) : a.slice(1);
      return { kind: a[0], ifempty, root: rest[0], key: expand(rest[1]), value: rest[2] === undefined ? undefined : expand(rest[2]) };
    });
  const under = (key: string, parent: string) => key.toLowerCase() === parent.toLowerCase() || key.toLowerCase().startsWith(`${parent.toLowerCase()}\\`);

  it('uses electron-builder 26’s macros', () => {
    expect(code).toMatch(/!macro customInstall\b/);
    expect(code).toMatch(/!macro customUnInstall\b/);
    const templates = path.join(repo, 'node_modules/app-builder-lib/templates/nsis');
    expect(fs.readFileSync(path.join(templates, 'installSection.nsh'), 'utf8')).toContain('!insertmacro customInstall');
    expect(fs.readFileSync(path.join(templates, 'uninstaller.nsh'), 'utf8')).toContain('!insertmacro customUnInstall');
    expect(fs.readFileSync(path.join(templates, 'installSection.nsh'), 'utf8')).toContain('StrCpy $appExe');
  });

  it('writes the ProgID, OpenWithProgids, Capabilities and the RegisteredApplications value', () => {
    const progid = WINDOWS_PROG_ID;
    const has = (key: string, value: string) => writes.some((w) => w.key === key && w.value === value);
    expect(has(`Software\\Classes\\${progid}\\shell\\open\\command`, '')).toBe(true);
    expect(has(`Software\\Classes\\${progid}\\DefaultIcon`, '')).toBe(true);
    expect(has('Software\\Classes\\.html\\OpenWithProgids', progid)).toBe(true);
    expect(has('Software\\Classes\\.htm\\OpenWithProgids', progid)).toBe(true);
    expect(has('Software\\Blueline\\Capabilities', 'ApplicationName')).toBe(true);
    expect(has('Software\\Blueline\\Capabilities', 'ApplicationDescription')).toBe(true);
    expect(has('Software\\Blueline\\Capabilities\\FileAssociations', '.html')).toBe(true);
    expect(has('Software\\Blueline\\Capabilities\\FileAssociations', '.htm')).toBe(true);
    expect(has('Software\\RegisteredApplications', REGISTERED_APP_NAME)).toBe(true);
    const reg = install.split('\n').find((l) => l.includes('RegisteredApplications'))!;
    expect(expand(args(reg.trim())[4])).toBe('Software\\Blueline\\Capabilities');
    const assoc = install.split('\n').filter((l) => l.includes('FileAssociations'));
    for (const l of assoc) expect(expand(args(l.trim())[4])).toBe(progid);
    // The open command quotes the executable and the file.
    expect(install).toContain(`'"$appExe" "%1"'`);
  });

  it('every write goes to SHELL_CONTEXT (HKCU per user, HKLM per machine), never a fixed hive', () => {
    expect(writes.length).toBeGreaterThan(10);
    for (const w of writes) expect(w.root).toBe('SHELL_CONTEXT');
    for (const d of deletes) expect(d.root).toBe('SHELL_CONTEXT');
    expect(code).not.toMatch(/\b(HKLM|HKCU|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER)\b/);
  });

  it('every key and value written is removed on uninstall', () => {
    for (const w of writes) {
      const removed = deletes.some((d) => (d.kind === 'DeleteRegKey' && !d.ifempty && under(w.key, d.key)) || (d.kind === 'DeleteRegValue' && d.key === w.key && d.value === w.value));
      expect(removed, `${w.key} :: ${w.value}`).toBe(true);
    }
  });

  it('never deletes an extension’s key or a shared key outright', () => {
    for (const d of deletes.filter((x) => x.kind === 'DeleteRegKey' && !x.ifempty)) {
      expect(d.key).not.toMatch(/^Software\\Classes\\\.html?$/i);
      expect(d.key).not.toMatch(/^Software\\RegisteredApplications$/i);
      expect(d.key).not.toMatch(/^Software\\Classes$/i);
      expect(d.key).not.toMatch(/OpenWithProgids$/i);
    }
  });

  it('keeps the registration during an update (deleting the ProgID would reset the user’s choice)', () => {
    expect(uninstall.trim().split('\n')[0].trim()).toBe('${ifNot} ${isUpdated}');
    expect(uninstall.trim().split('\n').pop()!.trim()).toBe('${endIf}');
  });

  it('tells the shell the associations changed, after install and after uninstall', () => {
    expect(install).toMatch(/SHChangeNotify\(i, i, i, i\) v \(0x08000000/);
    expect(uninstall).toMatch(/SHChangeNotify\(i, i, i, i\) v \(0x08000000/);
  });
});
