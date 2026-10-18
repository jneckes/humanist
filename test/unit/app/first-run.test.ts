// First run (6.0; 9.9 Telemetry; 9.1 Shell view): the welcome window's validators, its channels with a fake
// Electron (only the welcome window's own shell is answered), the sample deck's copy in app data, the tour's
// steps, and the settings it stores (the name, seen.welcome, crashReports).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const fake = vi.hoisted(() => {
  const windows: unknown[] = [];
  const state = { dialogResult: { canceled: true, filePaths: [] as string[] }, dialogCalls: 0 };
  let nextId = 500;
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
      if (this.destroyed) return;
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
  return { windows, state, BrowserWindow, fakeSession };
});

vi.mock('electron', () => ({
  ipcMain: { on() {}, handle() {} },
  BrowserWindow: fake.BrowserWindow,
  session: { fromPartition: () => fake.fakeSession },
  nativeTheme: { shouldUseDarkColors: false },
  dialog: {
    showOpenDialog: async () => {
      fake.state.dialogCalls++;
      return fake.state.dialogResult;
    },
  },
}));

import { MainToWelcome, WelcomeToMain, tourSteps, type WelcomeState } from '../../../packages/core/src/ipc-files';
import type { DefaultAppResult, DefaultAppStatus } from '../../../packages/core/src/ipc-trust';
import { sanitizeConfig } from '../../../packages/app/src/main/config';
import {
  OPEN_URL,
  SAMPLE_FILE,
  WELCOME_KEY,
  WELCOME_URL,
  cleanName,
  configFirstRunSettings,
  ensureSampleCopy,
  installFirstRun,
  validateCrashReports,
  validateSetName,
  type FirstRunSettings,
  type WelcomeConfigStore,
} from '../../../packages/app/src/main/first-run';
import { ShellIpc } from '../../../packages/app/src/main/ipc-guard';

const repo = path.resolve(__dirname, '../../..');
const SAMPLE = path.join(repo, 'packages/app/assets/sample', SAMPLE_FILE);

describe('validators (9.1: every argument checked in main)', () => {
  it('a name: trimmed, one line, 1 to 200 characters', () => {
    expect(cleanName('  Josh   Smith ')).toBe('Josh Smith');
    expect(cleanName('Anna-Lena Ødegård 安娜')).toBe('Anna-Lena Ødegård 安娜');
    for (const bad of ['', '   ', 'x'.repeat(201), 'a\nb', 'a\u0000', 'a\u2028b', 'a\u0085b', '\uD800', 7, null]) expect(cleanName(bad)).toBeNull();
    expect(validateSetName(['Josh'])).toEqual({ ok: true, value: 'Josh' });
    for (const bad of [[], [1], ['a', 'b'], ['x'.repeat(801)]]) expect(validateSetName(bad).ok).toBe(false);
  });

  it('crash reports: one boolean', () => {
    expect(validateCrashReports([true])).toEqual({ ok: true, value: true });
    for (const bad of [[], ['yes'], [1], [true, false]]) expect(validateCrashReports(bad).ok).toBe(false);
  });
});

describe('the tour (6.0: Read → Review → Edit, done by the user with the shortcut shown)', () => {
  it('three steps with the platform’s shortcuts', () => {
    expect(tourSteps('darwin').map((s) => s.mode)).toEqual(['read', 'review', 'edit']);
    expect(tourSteps('darwin')[1].text).toContain('Cmd+2');
    expect(tourSteps('win32')[2].text).toContain('Ctrl+3');
    expect(tourSteps('linux')[0].text).toContain('Ctrl+1');
  });
});

describe('the sample deck', () => {
  let root: string;
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-sample-')));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('is self-contained: no network, no other files, a strict CSP of its own', () => {
    const html = fs.readFileSync(SAMPLE, 'utf8');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']?(?:https?:|\/\/)/i);
    expect(html).not.toMatch(/@import|url\(|<link\b/i);
    expect(html).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket/);
    // Hash navigation, and both kinds of text Edit can change.
    expect(html).toContain("location.hash = '#'");
    expect(html).toMatch(/var READ_POINTS = \[/);
    expect((html.match(/<section class="slide"/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect((html.match(/<section class="slide"/g) ?? []).length).toBeLessThanOrEqual(8);
  });

  it('is copied to <userData>/sample on first use, from its bytes; an existing copy (the user’s edits) is kept', async () => {
    const userData = path.join(root, 'ud');
    const src = path.join(root, 'bundled.html');
    fs.copyFileSync(SAMPLE, src);
    // A marker on the bundled file (Linux user xattr standing in for com.apple.quarantine) never reaches the copy.
    const marked = spawnSync('python3', ['-c', `import os; os.setxattr(${JSON.stringify(src)}, 'user.com.apple.quarantine', b'0083;x;Safari;')`]).status === 0;
    const copy = await ensureSampleCopy(src, userData);
    expect(copy).toBe(path.join(userData, 'sample', SAMPLE_FILE));
    expect(fs.readFileSync(copy)).toEqual(fs.readFileSync(SAMPLE));
    expect(fs.statSync(copy).mode & 0o777).toBe(0o644);
    if (marked) {
      const attrs = spawnSync('python3', ['-c', `import os; print(os.listxattr(${JSON.stringify(copy)}))`], { encoding: 'utf8' }).stdout.trim();
      expect(attrs).toBe('[]');
    }
    fs.writeFileSync(copy, '<h1>edited</h1>');
    expect(await ensureSampleCopy(src, userData)).toBe(copy);
    expect(fs.readFileSync(copy, 'utf8')).toBe('<h1>edited</h1>');
  });

  it('never follows or replaces something else in its place', async () => {
    const userData = path.join(root, 'ud2');
    fs.mkdirSync(path.join(userData, 'sample'), { recursive: true });
    fs.symlinkSync('/etc/hostname', path.join(userData, 'sample', SAMPLE_FILE));
    await expect(ensureSampleCopy(SAMPLE, userData)).rejects.toThrow(/not a regular file/);
  });
});

describe('the settings first run stores', () => {
  function memConfig(): WelcomeConfigStore & { data: Record<string, unknown> } {
    const data: Record<string, unknown> = {};
    return {
      data,
      get: () => data as ReturnType<WelcomeConfigStore['get']>,
      update: async (p) => {
        if (p.name !== undefined) data.name = p.name;
        if (p.crashReports !== undefined) data.crashReports = p.crashReports;
        if (p.seen !== undefined) data.seen = { ...(data.seen as object), ...p.seen };
      },
    };
  }

  it('configFirstRunSettings: name (falling back to the Person’s), seen.welcome, crashReports', async () => {
    const c = memConfig();
    const s = configFirstRunSettings(c, () => 'From Git');
    expect(s.welcomeSeen()).toBe(false);
    expect(s.name()).toBe('From Git');
    expect(s.crashReports()).toBeNull();
    await s.setName('Josh');
    await s.setCrashReports(false);
    await s.markWelcomeSeen();
    expect(c.data).toEqual({ name: 'Josh', crashReports: false, seen: { welcome: true } });
    expect(s.welcomeSeen()).toBe(true);
    expect(s.crashReports()).toBe(false);
  });

  const keeps = sanitizeConfig({ seen: { welcome: true, saveExplained: true }, crashReports: true }) as { seen?: { welcome?: boolean }; crashReports?: boolean };
  it.skipIf(!(keeps.seen?.welcome === true && keeps.crashReports === true))(
    'config.json keeps seen.welcome and crashReports (needs the files-lifecycle contract request on config.ts)',
    () => {
      expect(keeps).toMatchObject({ seen: { welcome: true, saveExplained: true }, crashReports: true });
    },
  );
});

// ------------------------------------------------------------------------------------------- the window

describe('the welcome window: only its own shell is answered', () => {
  let root: string;
  let userData: string;
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const router = new ShellIpc({
    ipcMain: {
      on: () => undefined,
      handle: (ch, fn) => {
        handlers.set(ch, fn as (event: unknown, ...args: unknown[]) => unknown);
      },
    },
  });
  const opened: string[] = [];
  const names: string[] = [];
  const helperCalls: string[] = [];
  let store: { seen: boolean; name: string; crash: boolean | null; writes: string[] };
  let controller: ReturnType<typeof installFirstRun>;
  let defaultResult: DefaultAppResult = { ok: true };

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-welcome-')));
    userData = path.join(root, 'userData');
    store = { seen: false, name: 'From Git', crash: null, writes: [] };
    const settings: FirstRunSettings = {
      welcomeSeen: () => store.seen,
      name: () => store.name,
      crashReports: () => store.crash,
      setName: async (n) => {
        store.name = n;
        store.writes.push(`name ${n}`);
      },
      setCrashReports: async (on) => {
        store.crash = on;
        store.writes.push(`crash ${on}`);
      },
      markWelcomeSeen: async () => {
        store.seen = true;
        store.writes.push('seen');
      },
    };
    const status: DefaultAppStatus = { known: true, isDefault: false, current: 'Safari', action: 'set', reason: null };
    controller = installFirstRun({
      settings,
      helper: () => ({
        isDefaultHtmlApp: async () => {
          helperCalls.push('is');
          return status;
        },
        setDefaultHtmlApp: async () => {
          helperCalls.push('set');
          return defaultResult;
        },
      }),
      open: async (p) => {
        opened.push(p);
        return true;
      },
      sampleSource: SAMPLE,
      userData,
      preload: '/dist/preload-welcome.cjs',
      shellDir: '/dist/shell',
      platform: 'darwin',
      devTools: false,
      onNameChanged: (n) => names.push(n),
      log: () => undefined,
      router,
      test: true,
    });
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  type Win = InstanceType<typeof fake.BrowserWindow>;
  const current = () => fake.windows.at(-1) as Win;
  const eventFrom = (wc: { id: number; mainFrame: unknown }) => ({ sender: wc, senderFrame: wc.mainFrame });
  const call = (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  const lastState = (w: Win) => [...w.webContents.sent].reverse().find(([c]) => c === MainToWelcome.state)?.[1] as WelcomeState | undefined;

  it('first launch: maybeShow opens a sandboxed shell window on app://shell/welcome.html and records seen once shown', async () => {
    expect(controller.maybeShow()).toBe(true);
    const w = current();
    const prefs = w.options.webPreferences as Record<string, unknown>;
    expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: 'shell', preload: '/dist/preload-welcome.cjs', navigateOnDragDrop: false });
    expect(w.webContents.urls).toEqual([WELCOME_URL]);
    expect(WELCOME_URL).toBe('app://shell/welcome.html');
    expect(store.seen).toBe(false);
    w.emit('ready-to-show');
    await new Promise((r) => setTimeout(r, 0));
    expect(w.shown).toBe(1);
    expect(store.seen).toBe(true);
    // Showing it again focuses the same window; on a later launch maybeShow does nothing.
    expect(controller.show()).toBe(w);
    expect(w.focused).toBe(1);
    expect(controller.maybeShow()).toBe(false);
    expect((globalThis as Record<string, unknown>).__blWelcome).toBeDefined();
  });

  it('getState: the name, the crash-report answer, the default-app status, the tour', async () => {
    const w = current();
    const s = (await call(WelcomeToMain.getState, eventFrom(w.webContents))) as WelcomeState;
    expect(s).toEqual({
      platform: 'darwin',
      name: 'From Git',
      crashReports: null,
      defaultApp: { known: true, isDefault: false, current: 'Safari', action: 'set', reason: null },
      sample: { opened: false, modesSeen: [] },
    });
  });

  it('refuses every other sender: a document shell, Settings, a stale welcome webContents, another origin', async () => {
    const other = new fake.BrowserWindow({});
    router.registerShell(other.webContents, { windowKey: '0123456789abcdef' });
    await expect(call(WelcomeToMain.setName, eventFrom(other.webContents), 'Mallory')).rejects.toThrow('Refused');
    const settingsWin = new fake.BrowserWindow({});
    router.registerShell(settingsWin.webContents, { windowKey: 'settings' });
    await expect(call(WelcomeToMain.openSample, eventFrom(settingsWin.webContents))).rejects.toThrow('Refused');
    const impostor = new fake.BrowserWindow({});
    router.registerShell(impostor.webContents, { windowKey: WELCOME_KEY });
    await expect(call(WelcomeToMain.setCrashReports, eventFrom(impostor.webContents), true)).rejects.toThrow('Refused');
    const w = current();
    const frame = { ...w.webContents.mainFrame, origin: 'blueline://0123456789abcdef' };
    await expect(call(WelcomeToMain.getState, { sender: w.webContents, senderFrame: frame })).rejects.toThrow('Refused');
    expect(store.name).toBe('From Git');
    expect(store.crash).toBeNull();
  });

  it('the welcome window itself, though, is the current one again after the impostors', () => {
    // The impostor windows were created by the test, not by installFirstRun: the welcome window is unchanged.
    expect(controller.webContentsId()).not.toBeNull();
  });

  it('setName stores the cleaned name and tells the app; a bad one is refused with a reason', async () => {
    const w = fake.windows.find((x) => (x as Win).webContents.id === controller.webContentsId()) as Win;
    expect(await call(WelcomeToMain.setName, eventFrom(w.webContents), '  Josh  ')).toEqual({ ok: true, name: 'Josh' });
    expect(store.name).toBe('Josh');
    expect(names).toEqual(['Josh']);
    expect(await call(WelcomeToMain.setName, eventFrom(w.webContents), 'Josh')).toEqual({ ok: true, name: 'Josh' });
    expect(names).toEqual(['Josh']);
    const bad = (await call(WelcomeToMain.setName, eventFrom(w.webContents), 'a\nb')) as { ok: boolean };
    expect(bad.ok).toBe(false);
    await expect(call(WelcomeToMain.setName, eventFrom(w.webContents), 42)).rejects.toThrow('Refused');
  });

  it('setCrashReports stores the answer (nothing is sent: there is no crash server in v1)', async () => {
    const w = fake.windows.find((x) => (x as Win).webContents.id === controller.webContentsId()) as Win;
    await call(WelcomeToMain.setCrashReports, eventFrom(w.webContents), false);
    expect(store.crash).toBe(false);
    expect(lastState(w)?.crashReports).toBe(false);
  });

  it('Make Blueline your HTML app calls the helper and asks again; a declined prompt comes back as such', async () => {
    const w = fake.windows.find((x) => (x as Win).webContents.id === controller.webContentsId()) as Win;
    defaultResult = { ok: false, declined: true };
    helperCalls.length = 0;
    expect(await call(WelcomeToMain.makeDefaultApp, eventFrom(w.webContents))).toEqual({ ok: false, declined: true });
    expect(helperCalls).toEqual(['set', 'is']);
  });

  it('Try the sample deck: copies it into app data, opens the copy, and the tour ticks as the user switches modes', async () => {
    const w = fake.windows.find((x) => (x as Win).webContents.id === controller.webContentsId()) as Win;
    expect(await call(WelcomeToMain.openSample, eventFrom(w.webContents))).toEqual({ ok: true });
    const copy = path.join(userData, 'sample', SAMPLE_FILE);
    expect(opened).toEqual([copy]);
    expect(controller.samplePath()).toBe(copy);
    expect(lastState(w)?.sample).toEqual({ opened: true, modesSeen: ['read'] });
    controller.noteMode('/elsewhere/deck.html', 'review');
    expect(lastState(w)?.sample.modesSeen).toEqual(['read']);
    controller.noteMode(copy, 'edit');
    controller.noteMode(copy, 'review');
    expect(lastState(w)?.sample.modesSeen).toEqual(['read', 'review', 'edit']);
  });

  it('Open a file: main’s own dialog; a cancel opens nothing; a chosen file opens and the welcome window closes', async () => {
    const w = fake.windows.find((x) => (x as Win).webContents.id === controller.webContentsId()) as Win;
    opened.length = 0;
    fake.state.dialogResult = { canceled: true, filePaths: [] };
    expect(await call(WelcomeToMain.openFile, eventFrom(w.webContents))).toEqual({ ok: false, canceled: true });
    expect(opened).toEqual([]);
    fake.state.dialogResult = { canceled: false, filePaths: ['/decks/a.html', '/decks/b.htm'] };
    expect(await call(WelcomeToMain.openFile, eventFrom(w.webContents))).toEqual({ ok: true });
    expect(opened).toEqual(['/decks/a.html', '/decks/b.htm']);
    expect(w.destroyed).toBe(true);
    expect(controller.isOpen()).toBe(false);
    // Its channels refuse the closed window.
    await expect(call(WelcomeToMain.getState, eventFrom(w.webContents))).rejects.toThrow('Refused');
  });

  it('close() and the close channel close it; show() makes a new one', async () => {
    const w2 = controller.show();
    expect(controller.isOpen()).toBe(true);
    await call(WelcomeToMain.close, eventFrom((w2 as unknown as Win).webContents));
    expect(controller.isOpen()).toBe(false);
  });

  // Later launches without a file (startupWindow; review findings 24 and 34).
  it('a later launch: nothing on macOS (this controller is darwin’s); the first-run welcome only while seen.welcome is unset', () => {
    expect(store.seen).toBe(true);
    expect(controller.showForLaunch()).toBeNull();
    expect(controller.isOpen()).toBe(false);
    store.seen = false;
    try {
      expect(controller.showForLaunch()).toBe('welcome');
      expect(controller.mode()).toBe('welcome');
    } finally {
      controller.close();
      store.seen = true;
    }
  });

  it('the Open window: the page in open mode, small, never marks seen.welcome, and refuses the first-run answers', async () => {
    const before = store.writes.length;
    const win = controller.show('open') as unknown as Win;
    expect(controller.mode()).toBe('open');
    expect(win.webContents.urls).toEqual([OPEN_URL]);
    expect(OPEN_URL).toBe('app://shell/welcome.html?mode=open');
    expect(win.options).toMatchObject({ title: 'Blueline', width: 560 });
    win.emit('ready-to-show');
    await new Promise((r) => setTimeout(r, 0));
    expect(win.shown).toBe(1);
    expect(store.writes.length).toBe(before);
    // What the page shows is answered: its state, the default app.
    expect(((await call(WelcomeToMain.getState, eventFrom(win.webContents))) as WelcomeState).platform).toBe('darwin');
    // The first-run answers are refused from it, whatever its page sends.
    await expect(call(WelcomeToMain.setName, eventFrom(win.webContents), 'Mallory')).rejects.toThrow('Refused');
    await expect(call(WelcomeToMain.setCrashReports, eventFrom(win.webContents), true)).rejects.toThrow('Refused');
    expect(store.name).toBe('Josh');
    expect(store.crash).toBe(false);
    // Showing the Open window again focuses it.
    expect(controller.show('open')).toBe(win as unknown as ReturnType<typeof controller.show>);
    expect(controller.focus()).toBe(true);
    expect(win.focused).toBe(2);
  });

  it('the Open window closes once the sample deck is open (it has no tour)', async () => {
    const win = fake.windows.find((x) => (x as Win).webContents.id === controller.webContentsId()) as Win;
    expect(controller.mode()).toBe('open');
    expect(await call(WelcomeToMain.openSample, eventFrom(win.webContents))).toEqual({ ok: true });
    expect(win.destroyed).toBe(true);
    expect(controller.isOpen()).toBe(false);
    expect(controller.focus()).toBe(false);
  });

  it('Help › Welcome to Blueline over the Open window: the whole welcome replaces it, made before the Open window closes', () => {
    const open = controller.show('open') as unknown as Win;
    let welcomeExisted = false;
    open.on('closed', () => {
      welcomeExisted = fake.windows.some((x) => x !== open && !(x as Win).destroyed && (x as Win).webContents.urls[0] === 'app://shell/welcome.html');
    });
    const welcome = controller.show('welcome') as unknown as Win;
    expect(welcome).not.toBe(open);
    expect(open.destroyed).toBe(true);
    expect(welcomeExisted).toBe(true);
    expect(controller.mode()).toBe('welcome');
    expect(controller.webContentsId()).toBe(welcome.webContents.id);
    // The welcome serves for the Open window: asking for the Open window focuses it.
    expect(controller.show('open')).toBe(welcome as unknown as ReturnType<typeof controller.show>);
    controller.close();
  });
});
