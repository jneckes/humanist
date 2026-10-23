// Launching the built app with Playwright's Electron launcher, for the E2E tests and the security suite
// (SPEC section 11; 9.9: "the E2E tests and the security suite run on a test build").
//
// Who the app runs as (recorded in every result, see LaunchInfo):
// - `bltest`: when the runner is root and the user `bltest` exists (the default). The app runs unprivileged
//   with the OS sandbox ON (Chromium's user-namespace sandbox; Playwright's `chromiumSandbox: true`).
// - `root`: as root with `--no-sandbox` (Chromium refuses to run as root otherwise). The OS sandbox is OFF;
//   the in-process sandbox flags (sandbox: true, contextIsolation) still apply. Only for development.
// - `self`: a non-root runner; the app runs as that user with the sandbox on.
// BL_TEST_RUN_AS=root|bltest overrides the choice.
//
// How DNS is observed (LaunchInfo.dns):
// - `namespace` (the default when root): the app runs in a private mount namespace (`unshare --mount`) whose
//   /etc/resolv.conf is bind-mounted to `nameserver 127.0.0.1`, where the suite's DnsServer listens. Every
//   name Chromium resolves (through getaddrinfo or its built-in resolver) reaches that server and is logged,
//   so a DNS leak (dns-prefetch, WebRTC ICE) is observable even when no connection follows. Nothing else in
//   the machine changes; names outside `bl-attacker.test` get NXDOMAIN.
// - `rules`: `--host-resolver-rules=MAP *.bl-attacker.test 127.0.0.1`. Requests by name still reach the test
//   servers, but Chromium then performs no DNS lookup at all, so DNS leaks are NOT observable; the suite skips
//   its DNS assertions with that reason. Used when the runner cannot bind port 53 or create namespaces.
// - `system`: nothing changes (names in the zone do not resolve).
// BL_TEST_DNS=namespace|rules|system overrides the choice.
//
// The app's environment is built from scratch: no proxy variables (Chromium would send names to a proxy
// instead of resolving them, and the dev container's agent proxy must never see test traffic), no tokens.
//
// The app's test switches (environment, read by main; LaunchOptions.env adds them):
// - BLUELINE_TEST=1 (always set here): the test build's hooks: __blTest in main (index.ts), __blTestIpc in the
//   deck preload's isolated world, in the main frame and in every subframe (deck.ts), and the IPC drop logs.
// - BLUELINE_USER_DATA=<dir> (always set here): userData, before `ready`; `blueline pdf` and `map` read its
//   config.json for Settings › Trust (command-trust.ts).
// - BLUELINE_TEST_MARKERS=<file.json>: internet markers by realpath (markers.ts; Linux has none). Never read
//   from app.asar.
// - BLUELINE_TEST_DISABLE_LAYER=<layers>: turns Protected layers off in an unpackaged build (protocol.ts).
// - BLUELINE_TEST_FIRST_RUN=1: the real startup windows at a launch without a file (the first-run welcome, then
//   the Open window on Linux and Windows) and for a file-less second launch, as a packaged app shows them
//   (index.ts noFileStart). Without it a test build shows the Open dialog, which the harness answers.

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { electronBinary } from '../../scripts/electron-binary.cjs';
import { SINK_IP } from './servers';

export const ROOT = path.resolve(__dirname, '../..');
export const APP_DIR = path.join(ROOT, 'packages/app');
export const FIXTURES = path.join(ROOT, 'fixtures');
/**
 * Whether the build under test has the editor (P2-15). A reader-only build ships no dist/editor.cjs; tests that
 * run in both builds check the reader-only behaviour (Edit refused) when it is false.
 */
export const EDIT_BUILD = fs.existsSync(path.join(APP_DIR, 'dist', 'editor.cjs'));

const requireFromApp = createRequire(path.join(APP_DIR, 'package.json'));
/** The Electron binary `npm run install:electron` installed (never downloaded here: scripts/electron-binary.cjs). */
export const ELECTRON_BIN: string = electronBinary(APP_DIR);
/** Playwright's Electron loader: holds `ready` until Playwright is attached, and strips its own switches. */
export const PLAYWRIGHT_LOADER = path.join(path.dirname(requireFromApp.resolve('playwright-core/package.json')), 'lib/server/electron/loader.js');

// ------------------------------------------------------------------------------------------- who runs it

export type RunAsMode = 'bltest' | 'root' | 'self';

export interface RunAs {
  mode: RunAsMode;
  uid: number;
  gid: number;
  /** The OS (Chromium) sandbox is on. */
  sandbox: boolean;
  reason: string;
}

function lookupUser(name: string): { uid: number; gid: number } | null {
  const u = spawnSync('id', ['-u', name], { encoding: 'utf8' });
  const g = spawnSync('id', ['-g', name], { encoding: 'utf8' });
  if (u.status !== 0 || g.status !== 0) return null;
  const uid = Number(u.stdout.trim());
  const gid = Number(g.stdout.trim());
  return Number.isInteger(uid) && Number.isInteger(gid) ? { uid, gid } : null;
}

export function resolveRunAs(requested: string | undefined = process.env.BL_TEST_RUN_AS): RunAs {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const self = { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 };
  if (!isRoot) return { mode: 'self', ...self, sandbox: true, reason: 'runner is not root: the app runs as the runner, sandbox on' };
  if (requested === 'root') return { mode: 'root', ...self, sandbox: false, reason: 'BL_TEST_RUN_AS=root: --no-sandbox (OS sandbox off)' };
  const bl = lookupUser('bltest');
  if (bl && process.platform === 'linux') {
    return { mode: 'bltest', ...bl, sandbox: true, reason: 'root runner: the app runs as bltest with the OS sandbox on' };
  }
  if (requested === 'bltest') throw new Error('BL_TEST_RUN_AS=bltest but the user bltest does not exist');
  return { mode: 'root', ...self, sandbox: false, reason: 'no bltest user: running as root with --no-sandbox (OS sandbox off)' };
}

// ------------------------------------------------------------------------------------------- DNS routing

export type DnsMode = 'namespace' | 'rules' | 'system';

export interface DnsRouting {
  mode: DnsMode;
  reason: string;
  /** DNS queries are observable by the suite's DnsServer. */
  observable: boolean;
}

/**
 * Decides how the app's DNS is routed. `dnsListening` says whether the suite's DnsServer is bound to
 * 127.0.0.1:53 (only then can a resolv.conf point at it).
 */
export function resolveDns(dnsListening: boolean, requested: string | undefined = process.env.BL_TEST_DNS): DnsRouting {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (requested === 'system') return { mode: 'system', reason: 'BL_TEST_DNS=system', observable: false };
  if (requested === 'rules') return { mode: 'rules', reason: 'BL_TEST_DNS=rules: --host-resolver-rules (DNS not observable)', observable: false };
  const canNamespace = process.platform === 'linux' && isRoot && dnsListening && fs.existsSync('/usr/bin/unshare') && fs.existsSync('/etc/resolv.conf');
  if (canNamespace) {
    return { mode: 'namespace', reason: 'private mount namespace with /etc/resolv.conf -> nameserver 127.0.0.1 (the suite DNS server)', observable: true };
  }
  if (requested === 'namespace') throw new Error('BL_TEST_DNS=namespace needs root, Linux, unshare and the DNS server on 127.0.0.1:53');
  const why = !isRoot ? 'runner is not root' : !dnsListening ? 'the DNS server could not bind 127.0.0.1:53' : 'unshare unavailable';
  return { mode: 'rules', reason: `${why}: --host-resolver-rules maps *.bl-attacker.test to 127.0.0.1 (DNS not observable)`, observable: false };
}

// ------------------------------------------------------------------------------------------- temp folders

/** Temp folders for one launch or one test, owned by the user the app runs as (so the app could write there). */
export class Scratch {
  private readonly dirs: string[] = [];

  constructor(readonly runAs: RunAs) {}

  dir(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `bl-${prefix}-`));
    fs.chmodSync(d, 0o755);
    this.dirs.push(d);
    this.own(d);
    return d;
  }

  /** chown -R to the app's user (no-op unless running as bltest). */
  own(p: string): void {
    if (this.runAs.mode !== 'bltest') return;
    const r = spawnSync('chown', ['-R', '-h', `${this.runAs.uid}:${this.runAs.gid}`, p]);
    if (r.status !== 0) throw new Error(`chown ${p} failed: ${String(r.stderr)}`);
  }

  cleanup(): void {
    for (const d of this.dirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}

// ------------------------------------------------------------------------------------------- launching

export interface LaunchOptions {
  files: string[];
  protected?: boolean;
  /** Reuse a userData folder (reopen tests); a fresh one otherwise. */
  userData?: string;
  scratch: Scratch;
  dns?: DnsRouting;
  extraArgs?: string[];
  env?: Record<string, string>;
}

export interface LaunchInfo {
  runAs: RunAsMode;
  sandbox: boolean;
  runAsReason: string;
  dns: DnsMode;
  dnsReason: string;
  electron: string;
  /** The app's HOME and TMPDIR (the env it was launched with; LaunchOptions.env may override TMPDIR). */
  home: string;
  tmpDir: string;
}

/** What `__blTest.windows()` returns for each document window (packages/app/src/main/index.ts). */
export interface WinInfo {
  docId: string;
  realpath: string;
  fileName: string;
  trust: 'protected' | 'trusted';
  trustReason: string | null;
  partition: string;
  networkAllowed: boolean;
  editingAllowed: boolean;
  appMode: 'read' | 'review' | 'edit';
  handshakes: number;
  textField: boolean;
  sessionFile: string;
  windowId: number;
  shellWebContentsId: number;
  deckWebContentsId: number;
  deckUrl: string;
  deckBounds: { x: number; y: number; width: number; height: number };
  state: {
    appMode: string;
    trust: string;
    trustBarVisible: boolean;
    networkAllowed: boolean;
    editingAllowed: boolean;
    banner: string | null;
    notes: {
      id: string;
      status: string;
      text: string;
      kind: string;
      /** Phase 2 (P2-13): edit and verbatim notes. */
      before?: string;
      after?: string;
      summary?: string;
      slide?: number | null;
      line?: number | null;
      locked?: 'ok' | 'violated' | null;
    }[];
    slide: { current: number; count: number; kind: string; titles: string[] } | null;
    layout: Record<string, number>;
    /** Phase 2: Edit's availability (6.3, 6.10), the name chip (6.8), the history list (P2-11). */
    edit?: { available: boolean; reason: string | null; enable: boolean };
    userName?: string;
    history?: { entries: { id: string; at: string; cause: string; size: number }[]; canRestore: boolean; reason: string | null } | null;
  };
}

/** What `__blTest.edit(docId)` returns (Phase 2; packages/app/src/main/index.ts). */
export interface EditInfo {
  version: string;
  knownHash: string;
  undo: { undo: number; redo: number };
  history: { id: string; at: string; cause: string; size: number }[];
  locked: { start: number; end: number; text: string; noteId: string; state: 'ok' | 'violated' }[];
  availability: { available: boolean; reason: string | null; enable: boolean };
  historyOpen: boolean;
}

const RESOLV_CONF = 'nameserver 127.0.0.1\noptions timeout:1 attempts:1\n';

/**
 * The executable Playwright launches. It keeps one process (exec all the way down) so Playwright's process
 * handle is Electron's: [unshare --mount → bind resolv.conf] → [setpriv to bltest] → electron -r loader.
 * Playwright's own switches (--inspect=0 --remote-debugging-port=0, and --no-sandbox when root) follow,
 * exactly as its default launch would order them, so the loader strips them from process.argv.
 */
const WRAPPER = `#!/bin/sh
set -e
if [ -n "$BL_WRAP_RESOLV" ] && [ -z "$BL_WRAP_IN_NS" ]; then
  BL_WRAP_IN_NS=1 exec unshare --mount --propagation private -- "$0" "$@"
fi
if [ -n "$BL_WRAP_IN_NS" ]; then
  mount --bind "$BL_WRAP_RESOLV" /etc/resolv.conf
fi
E="$BL_WRAP_ELECTRON"; L="$BL_WRAP_LOADER"; U="$BL_WRAP_UID"; G="$BL_WRAP_GID"
unset BL_WRAP_RESOLV BL_WRAP_IN_NS BL_WRAP_ELECTRON BL_WRAP_LOADER BL_WRAP_UID BL_WRAP_GID
if [ -n "$U" ]; then
  exec setpriv --reuid="$U" --regid="$G" --clear-groups -- "$E" -r "$L" "$@"
fi
exec "$E" -r "$L" "$@"
`;

let wrapperPath: string | null = null;

function wrapper(): string {
  if (wrapperPath && fs.existsSync(wrapperPath)) return wrapperPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-wrap-'));
  const p = path.join(dir, 'electron-wrapper.sh');
  fs.writeFileSync(p, WRAPPER, { mode: 0o755 });
  wrapperPath = p;
  return p;
}

export async function launchApp(o: LaunchOptions): Promise<BlApp> {
  const runAs = o.scratch.runAs;
  const dns = o.dns ?? { mode: 'system', reason: 'not requested', observable: false };
  const base = o.scratch.dir('run');
  const userData = o.userData ?? path.join(base, 'userData');
  const home = path.join(base, 'home');
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  o.scratch.own(base);
  if (o.userData) o.scratch.own(o.userData);

  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    LANG: 'C.UTF-8',
    TMPDIR: os.tmpdir(),
    BLUELINE_TEST: '1',
    BLUELINE_USER_DATA: userData,
    BL_WRAP_ELECTRON: ELECTRON_BIN,
    BL_WRAP_LOADER: PLAYWRIGHT_LOADER,
    ...(o.env ?? {}),
  };
  if (process.env.DISPLAY) env.DISPLAY = process.env.DISPLAY;
  if (runAs.mode === 'bltest') {
    env.BL_WRAP_UID = String(runAs.uid);
    env.BL_WRAP_GID = String(runAs.gid);
  }
  const args: string[] = [...(o.extraArgs ?? [])];
  if (dns.mode === 'namespace') {
    const resolv = path.join(base, 'resolv.conf');
    fs.writeFileSync(resolv, RESOLV_CONF, { mode: 0o644 });
    env.BL_WRAP_RESOLV = resolv;
  } else if (dns.mode === 'rules') {
    // Map the attacker zone to the non-loopback sink IP: a real attacker host is not loopback (loopback has
    // its own listener, finding 8). SINK_IP is null only on a loopback-only machine, where this falls back to
    // loopback and the WebRTC proxy assertion is skipped with a reason.
    args.push(`--host-resolver-rules=MAP *.bl-attacker.test ${SINK_IP ?? '127.0.0.1'}`);
  }
  args.push(APP_DIR);
  if (o.protected) args.push('--protected');
  args.push(...o.files);

  const logs: string[] = [];
  const app = await electron.launch({
    executablePath: wrapper(),
    args,
    env,
    cwd: base,
    // Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; root needs it, bltest must not have it.
    chromiumSandbox: runAs.sandbox,
    timeout: 60_000,
  });
  const proc = app.process();
  const collect = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) logs.push(line);
    if (logs.length > 20_000) logs.splice(0, logs.length - 20_000);
  };
  proc.stdout?.on('data', collect);
  proc.stderr?.on('data', collect);
  const info: LaunchInfo = {
    runAs: runAs.mode,
    sandbox: runAs.sandbox,
    runAsReason: runAs.reason,
    dns: dns.mode,
    dnsReason: dns.reason,
    electron: ELECTRON_BIN,
    home: env.HOME,
    tmpDir: env.TMPDIR,
  };
  const bl = new BlApp(app, info, userData, logs);
  await bl.installHarness();
  return bl;
}

// ------------------------------------------------------------------------------------------- the app

export interface DialogRecord {
  kind: string;
  message?: string;
  detail?: string;
  buttons?: string[];
  title?: string;
}

/**
 * One will-download, as the harness saw it. Everything is first read synchronously inside will-download,
 * then again 300 ms later (after every listener, the app's included, has run). Electron destroys an item
 * whose will-download was prevented (Protected), and any read of a destroyed item throws "DownloadItem used
 * after being destroyed"; every later read is guarded, so the item is marked `destroyed` instead of an
 * uncaught exception reaching main's error dialog (finding 46).
 */
export interface DownloadRecord {
  url: string;
  filename: string;
  /** getState() inside will-download. */
  stateAtStart?: string;
  /** getSavePath() inside will-download. */
  savePathAtStart?: string;
  /** getState() 300 ms later: 'progressing' while a Trusted download waits for its save dialog. Absent when destroyed. */
  stateAfter?: string;
  /** getSavePath() 300 ms later (else the last value read): '' while no place was chosen. */
  savePath?: string;
  /** The save dialog's title (getSaveDialogOptions().title, or the title the app passed to setSaveDialogOptions). */
  dialogTitle?: string | null;
  /** Paths the app passed to item.setSavePath (recorded by wrapping the item's method). */
  setSavePath?: string[];
  /** will-download was event-prevented (read after every listener ran). */
  prevented?: boolean;
  /** A later read found the item destroyed (expected after a prevented will-download). */
  destroyed?: boolean;
  /** The item's 'done' state: 'cancelled', 'interrupted' or 'completed'. */
  done?: string;
}

export interface DeviceRecord {
  event: string;
  prevented?: boolean;
  devices?: number;
  /** The webContents the chooser was for (select-bluetooth-device only). */
  webContentsId?: number | null;
}

export interface HarnessState {
  dialogs: DialogRecord[];
  external: string[];
  downloads: DownloadRecord[];
  devices: DeviceRecord[];
  windowsOpened: number;
}

export class BlApp {
  constructor(
    readonly electronApp: ElectronApplication,
    readonly info: LaunchInfo,
    readonly userData: string,
    readonly logs: string[],
  ) {}

  /**
   * Test-side spies in main (never decisions): message boxes answer Cancel and are recorded, so a clicked
   * external link's confirmation dialog (9.9) is observable without a person; shell.openExternal and friends
   * are recorded instead of run; download items, device-chooser events and new windows are recorded.
   */
  async installHarness(): Promise<void> {
    await this.electronApp.evaluate((electron) => {
      const { app, dialog, shell, webContents, BrowserWindow } = electron;
      const g = globalThis as unknown as Record<string, unknown>;
      if (g.__blHarness) return;
      const H = {
        dialogs: [] as Record<string, unknown>[],
        external: [] as string[],
        downloads: [] as Record<string, unknown>[],
        devices: [] as Record<string, unknown>[],
        items: [] as Electron.DownloadItem[],
        windowsOpened: 0,
        /** The button message boxes answer: null = their cancelId (the default), or a button index. */
        answer: null as number | null,
      };
      g.__blHarness = H;
      const d = dialog as unknown as Record<string, unknown>;
      const record = (kind: string, args: unknown[]) => {
        const o = args.find((a) => a && typeof a === 'object' && !('webContents' in (a as object))) as Record<string, unknown> | undefined;
        H.dialogs.push({ kind, message: o?.message, detail: o?.detail, buttons: o?.buttons, title: o?.title });
        return o;
      };
      const response = (o: Record<string, unknown> | undefined) => (H.answer !== null ? H.answer : typeof o?.cancelId === 'number' ? o.cancelId : 1);
      d.showMessageBox = async (...a: unknown[]) => {
        const o = record('messageBox', a);
        return { response: response(o), checkboxChecked: false };
      };
      d.showMessageBoxSync = (...a: unknown[]) => {
        const o = record('messageBoxSync', a);
        return response(o);
      };
      d.showOpenDialog = async (...a: unknown[]) => {
        record('open', a);
        return { canceled: true, filePaths: [] };
      };
      d.showSaveDialog = async (...a: unknown[]) => {
        record('save', a);
        return { canceled: true, filePath: '' };
      };
      d.showErrorBox = (title: string, content: string) => {
        H.dialogs.push({ kind: 'error', message: title, detail: content });
      };
      const s = shell as unknown as Record<string, unknown>;
      s.openExternal = async (url: string) => {
        H.external.push(`external:${url}`);
      };
      s.openPath = async (p: string) => {
        H.external.push(`path:${p}`);
        return '';
      };
      s.showItemInFolder = (p: string) => {
        H.external.push(`reveal:${p}`);
      };
      const watchedSessions = new WeakSet<Electron.Session>();
      const watchSession = (ses: Electron.Session) => {
        if (watchedSessions.has(ses)) return;
        watchedSessions.add(ses);
        ses.on('will-download', (e, item) => {
          const rec: Record<string, unknown> = { url: '', filename: '' };
          H.downloads.push(rec);
          H.items.push(item);
          // Every read is guarded: a read of a destroyed item throws (see DownloadRecord).
          const read = (key: string, fn: () => unknown): boolean => {
            try {
              rec[key] = fn();
              return true;
            } catch {
              rec.destroyed = true;
              return false;
            }
          };
          read('url', () => item.getURL().slice(0, 300));
          read('filename', () => item.getFilename());
          read('stateAtStart', () => item.getState());
          read('savePathAtStart', () => item.getSavePath());
          read('savePath', () => item.getSavePath());
          read('dialogTitle', () => item.getSaveDialogOptions().title ?? null);
          // When this listener runs before the app's, record what the app then sets on the item.
          try {
            const it = item as unknown as Record<string, (...a: unknown[]) => unknown>;
            const setSavePath = it.setSavePath;
            const setOpts = it.setSaveDialogOptions;
            it.setSavePath = function (this: unknown, p: unknown) {
              ((rec.setSavePath as string[] | undefined) ?? (rec.setSavePath = [])).push(String(p));
              return setSavePath.call(this, p);
            };
            it.setSaveDialogOptions = function (this: unknown, o: unknown) {
              rec.dialogTitle = ((o ?? {}) as { title?: string }).title ?? null;
              return setOpts.call(this, o);
            };
          } catch {
            // a non-extensible item: the reads above and below still apply
          }
          item.once('done', (_e, st) => {
            rec.done = st;
          });
          // Read the outcome again after every will-download listener (the app's included) has run.
          setTimeout(() => {
            rec.prevented = e.defaultPrevented;
            if (read('stateAfter', () => item.getState())) {
              read('savePath', () => item.getSavePath());
              read('dialogTitle', () => item.getSaveDialogOptions().title ?? rec.dialogTitle ?? null);
            }
          }, 300);
        });
        for (const ev of ['select-hid-device', 'select-serial-port', 'select-usb-device'] as const) {
          (ses as unknown as NodeJS.EventEmitter).on(ev, (e: Electron.Event, details: unknown) => {
            // select-serial-port passes the port list itself; HID and USB pass { deviceList }.
            const list = Array.isArray(details) ? details : ((details ?? {}) as { deviceList?: unknown[] }).deviceList;
            const rec: Record<string, unknown> = { event: ev, devices: Array.isArray(list) ? list.length : -1 };
            H.devices.push(rec);
            setImmediate(() => {
              rec.prevented = e.defaultPrevented;
            });
          });
        }
      };
      const watchedWcs = new WeakSet<Electron.WebContents>();
      const watchWc = (wc: Electron.WebContents) => {
        if (watchedWcs.has(wc)) return;
        watchedWcs.add(wc);
        watchSession(wc.session);
        wc.on('select-bluetooth-device', (e, list) => {
          const rec: Record<string, unknown> = { event: 'select-bluetooth-device', devices: list.length, webContentsId: wc.isDestroyed() ? null : wc.id };
          H.devices.push(rec);
          setImmediate(() => {
            rec.prevented = e.defaultPrevented;
          });
        });
      };
      for (const wc of webContents.getAllWebContents()) watchWc(wc);
      app.on('web-contents-created', (_e, wc) => watchWc(wc));
      app.on('browser-window-created', () => {
        H.windowsOpened++;
      });
      void BrowserWindow;
    });
  }

  async harness(): Promise<HarnessState> {
    return await this.electronApp.evaluate(() => {
      const H = (globalThis as unknown as { __blHarness: Record<string, unknown> }).__blHarness;
      return JSON.parse(
        JSON.stringify({ dialogs: H.dialogs, external: H.external, downloads: H.downloads, devices: H.devices, windowsOpened: H.windowsOpened }),
      ) as HarnessState;
    });
  }

  /** Cancels every download still waiting for its save dialog (Trusted downloads, 9.9). */
  async cancelDownloads(): Promise<number> {
    return await this.electronApp.evaluate(() => {
      const H = (globalThis as unknown as { __blHarness: { items: Electron.DownloadItem[] } }).__blHarness;
      let n = 0;
      for (const i of H.items) {
        try {
          if (i.getState() === 'progressing') {
            i.cancel();
            n++;
          }
        } catch {
          // destroyed (a prevented Protected download): nothing to cancel
        }
      }
      return n;
    });
  }

  /**
   * How the harness answers message boxes from now on: 'cancel' (the default: each box's cancelId) or a
   * button index (e.g. 0, "Open in Browser" of the link dialog, for a positive control that the
   * openExternal spy records what a confirmed link opens).
   */
  async answerDialogs(answer: 'cancel' | number): Promise<void> {
    await this.electronApp.evaluate((_e, a) => {
      const H = (globalThis as unknown as { __blHarness: { answer: number | null } }).__blHarness;
      H.answer = a === 'cancel' ? null : a;
    }, answer);
  }

  /** Main's own idea of the user's folders (app.getPath), e.g. where a download would land by default. */
  async paths(): Promise<{ home: string; temp: string; downloads: string; userData: string }> {
    return await this.electronApp.evaluate(({ app }) => ({
      home: app.getPath('home'),
      temp: app.getPath('temp'),
      downloads: app.getPath('downloads'),
      userData: app.getPath('userData'),
    }));
  }

  async windows(): Promise<WinInfo[]> {
    return await this.electronApp.evaluate(() => {
      const t = (globalThis as unknown as { __blTest?: { windows(): unknown[] } }).__blTest;
      return t ? (JSON.parse(JSON.stringify(t.windows())) as never) : [];
    });
  }

  /**
   * The document ids of every open window, read without touching the deck webContents, so it is safe while
   * a window is closing. __blTest.windows() no longer lists a closing window (finding 23), so it does not throw
   * then; the catch below stays as a guard for closeDoc and waitForGone.
   */
  async docIds(): Promise<string[]> {
    return await this.electronApp.evaluate(() => {
      const t = (globalThis as unknown as { __blTest?: { windows(): { docId: string }[] } }).__blTest;
      if (!t) return [];
      try {
        return t.windows().map((w) => w.docId);
      } catch {
        // A window is mid-close and the hook threw; fall back to the raw window count being non-empty.
        return ['<transition>'];
      }
    });
  }

  async win(docId: string): Promise<WinInfo> {
    const w = (await this.windows()).find((x) => x.docId === docId);
    if (!w) throw new Error(`no window for ${docId}`);
    return w;
  }

  /**
   * Waits for a document window whose file name matches, whose deck finished its preload handshake and
   * finished loading, and returns its DeckView.
   */
  async waitForDeck(fileName: string, o: { timeout?: number; exclude?: string[] } = {}): Promise<DeckView> {
    const end = Date.now() + (o.timeout ?? 30_000);
    let last: WinInfo[] = [];
    while (Date.now() < end) {
      last = await this.windows();
      const w = last.find((x) => x.fileName === fileName && x.handshakes >= 1 && !(o.exclude ?? []).includes(x.docId));
      if (w) {
        const deck = new DeckView(this, w.docId, w.deckWebContentsId, w.windowId);
        if (await deck.loaded()) return deck;
      }
      await sleep(100);
    }
    throw new Error(`deck ${fileName} not ready; windows: ${JSON.stringify(last.map((w) => [w.fileName, w.handshakes, w.deckUrl]))}\n${this.logs.slice(-40).join('\n')}`);
  }

  /** Phase 2: what Edit holds for a window (main's undo stack, history list, locked spans, availability). */
  async editInfo(docId: string): Promise<EditInfo | null> {
    return await this.electronApp.evaluate((_e, id) => {
      const t = (globalThis as unknown as { __blTest?: { edit?(id: string): unknown } }).__blTest;
      return t?.edit ? (JSON.parse(JSON.stringify(t.edit(id))) as never) : null;
    }, docId);
  }

  /** Opens a file in the running app (as a second launch would) and returns its docId. */
  async open(file: string, prot = false): Promise<string | null> {
    return await this.electronApp.evaluate(
      async (_e, a) => {
        const t = (globalThis as unknown as { __blTest: { open(p: string, prot: boolean): Promise<string | null> } }).__blTest;
        return await t.open(a.file, a.prot);
      },
      { file, prot },
    );
  }

  /** Runs an app action (menu, chord or shell button) on a document window. */
  async run(action: string, docId?: string): Promise<void> {
    await this.electronApp.evaluate(
      (_e, a) => {
        const t = (globalThis as unknown as { __blTest: { run(action: string, docId?: string): void } }).__blTest;
        t.run(a.action, a.docId);
      },
      { action, docId },
    );
  }

  /** Closes a document's window and waits until it is gone (or the app quit, if it was the last window). */
  async closeDoc(docId: string): Promise<void> {
    await this.run('close', docId).catch(() => undefined);
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      let ids: string[];
      try {
        ids = await this.docIds();
      } catch {
        // evaluate rejected: the app process is gone (closing its last window quits it) → the window closed.
        return;
      }
      if (!ids.includes(docId) && !ids.includes('<transition>')) return;
      await sleep(100);
    }
    throw new Error(`window ${docId} did not close`);
  }

  /** The shell's Playwright page of a document window. */
  async shellPage(docId: string): Promise<Page> {
    const w = await this.win(docId);
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      for (const p of this.electronApp.windows()) {
        if (!p.url().startsWith('app://shell/')) continue;
        const bw = await this.electronApp.browserWindow(p).catch(() => null);
        const id = bw ? await bw.evaluate((b) => (b as Electron.BrowserWindow).id).catch(() => null) : null;
        if (id === w.windowId) return p;
      }
      await sleep(100);
    }
    throw new Error(`no shell page for ${docId}`);
  }

  /** Lines main logged (the app logs `[blueline] …` to stderr; BLUELINE_TEST adds request and IPC drop logs). */
  logsMatching(re: RegExp): string[] {
    return this.logs.filter((l) => re.test(l));
  }

  /**
   * Evidence that the OS sandbox is on for a deck renderer: its seccomp mode and whether it runs in a user
   * namespace other than main's (Chromium's Linux sandbox). Linux only.
   */
  async sandboxEvidence(deck: DeckView): Promise<{ rendererPid: number; mainPid: number; seccomp: string | null; noNewPrivs: string | null; ownUserNs: boolean | null; uid: string | null }> {
    const pids = await this.electronApp.evaluate(
      ({ webContents }, id) => ({ renderer: webContents.fromId(id)?.getOSProcessId() ?? -1, main: process.pid }),
      deck.wcId,
    );
    const status = (pid: number) => {
      try {
        return fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      } catch {
        return '';
      }
    };
    const field = (s: string, k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(s)?.[1]?.trim() ?? null;
    const st = status(pids.renderer);
    let ownUserNs: boolean | null = null;
    try {
      ownUserNs = fs.readlinkSync(`/proc/${pids.renderer}/ns/user`) !== fs.readlinkSync(`/proc/${pids.main}/ns/user`);
    } catch {
      ownUserNs = null;
    }
    return { rendererPid: pids.renderer, mainPid: pids.main, seccomp: field(st, 'Seccomp'), noNewPrivs: field(st, 'NoNewPrivs'), ownUserNs, uid: field(st, 'Uid') };
  }

  /**
   * Flushes a deck partition's storage to disk (Session.flushStorageData), so a Trusted file's persistent
   * partition is on disk before the app quits. Production flushes on a clean window close; a test's abrupt
   * quit may not, so the reopen test forces it.
   */
  async flushStorage(deck: DeckView): Promise<void> {
    await this.electronApp.evaluate(async ({ webContents }, id) => {
      const wc = webContents.fromId(id);
      if (wc && !wc.isDestroyed()) await wc.session.flushStorageData();
    }, deck.wcId);
  }

  async close(): Promise<void> {
    let proc: ReturnType<ElectronApplication['process']> | null = null;
    try {
      proc = this.electronApp.process();
    } catch {
      // The app already exited (closing its last window quits it): nothing to close.
      return;
    }
    await Promise.race([this.electronApp.close().catch(() => undefined), sleep(15_000)]);
    try {
      if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

// ------------------------------------------------------------------------------------------- one deck view

export type Pt = [number, number];

/**
 * One document's deck view, driven from main: executeJavaScript in the page's main world,
 * executeJavaScriptInIsolatedWorld in the preload's world, and trusted input with sendInputEvent (events
 * the page sees with isTrusted true and transient user activation, which user-activation-gated APIs need).
 */
export class DeckView {
  constructor(
    readonly app: BlApp,
    readonly docId: string,
    readonly wcId: number,
    readonly windowId: number,
  ) {}

  private get e(): ElectronApplication {
    return this.app.electronApp;
  }

  /** The deck finished loading its blueline:// document. */
  async loaded(): Promise<boolean> {
    return await this.e.evaluate(({ webContents }, id) => {
      const wc = webContents.fromId(id);
      return !!wc && !wc.isDestroyed() && !wc.isLoading() && wc.getURL().startsWith('blueline://');
    }, this.wcId);
  }

  async url(): Promise<string> {
    return await this.e.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL() ?? '', this.wcId);
  }

  /** Evaluates `code` in the page's main world (webContents.executeJavaScript). */
  async eval<T = unknown>(code: string, userGesture = false): Promise<T> {
    return (await this.e.evaluate(
      async ({ webContents }, a) => {
        const wc = webContents.fromId(a.id);
        if (!wc || wc.isDestroyed()) throw new Error('deck webContents is gone');
        return await wc.executeJavaScript(a.code, a.userGesture);
      },
      { id: this.wcId, code, userGesture },
    )) as T;
  }

  /** Evaluates `code` in an isolated world (the preload's is 999 in Electron; see the forged-IPC suite). */
  async isolated<T = unknown>(code: string, worldId = 999): Promise<T> {
    return (await this.e.evaluate(
      async ({ webContents }, a) => {
        const wc = webContents.fromId(a.id);
        if (!wc || wc.isDestroyed()) throw new Error('deck webContents is gone');
        return await wc.executeJavaScriptInIsolatedWorld(a.worldId, [{ code: a.code }]);
      },
      { id: this.wcId, code, worldId },
    )) as T;
  }

  /** Polls a main-world expression until it is truthy, and returns its value. */
  async waitFor<T = unknown>(expr: string, timeout = 15_000): Promise<T> {
    const end = Date.now() + timeout;
    let v: unknown = null;
    while (Date.now() < end) {
      v = await this.eval(`(function(){ try { return (${expr}); } catch (e) { return null; } })()`).catch(() => null);
      if (v) return v as T;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${expr} (last: ${JSON.stringify(v)})`);
  }

  /** Focuses the window and the deck view: sendInputEvent needs a focused window. */
  async focus(): Promise<void> {
    await this.e.evaluate(
      ({ webContents, BrowserWindow }, a) => {
        const w = BrowserWindow.fromId(a.win);
        if (w && !w.isDestroyed()) {
          w.show();
          w.focus();
        }
        webContents.fromId(a.id)?.focus();
      },
      { id: this.wcId, win: this.windowId },
    );
  }

  /** Sends raw input events in order, with `gapMs` between them. */
  async input(events: Electron.InputEvent[] | Record<string, unknown>[], gapMs = 0): Promise<void> {
    await this.e.evaluate(
      async ({ webContents }, a) => {
        const wc = webContents.fromId(a.id);
        if (!wc) throw new Error('deck webContents is gone');
        for (const ev of a.events) {
          wc.sendInputEvent(ev as unknown as Electron.MouseInputEvent);
          if (a.gap) await new Promise((r) => setTimeout(r, a.gap));
        }
      },
      { id: this.wcId, events: events as Record<string, unknown>[], gap: gapMs },
    );
  }

  /** A real left click at (x, y) in the view's coordinates. */
  async click(x: number, y: number): Promise<void> {
    await this.focus();
    const X = Math.round(x);
    const Y = Math.round(y);
    await this.input(
      [
        { type: 'mouseMove', x: X, y: Y },
        { type: 'mouseDown', x: X, y: Y, button: 'left', clickCount: 1 },
        { type: 'mouseUp', x: X, y: Y, button: 'left', clickCount: 1 },
      ],
      20,
    );
    await sleep(100);
  }

  /** The bounding box of the first element matching `selector`, or null. */
  async rect(selector: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
    return await this.eval(
      `(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})()`,
    );
  }

  /** A real click at the center of the element matching `selector`. */
  async clickSelector(selector: string): Promise<void> {
    await this.eval(`(function(){var e=document.querySelector(${JSON.stringify(selector)}); if (e && e.scrollIntoView) e.scrollIntoView({block:'center'});})()`);
    const r = await this.rect(selector);
    if (!r) throw new Error(`no element ${selector}`);
    await this.click(r.x + r.w / 2, r.y + r.h / 2);
  }

  /**
   * A real click on the text of the element matching `selector`: the middle of the first line box of its first
   * non-blank text (Phase 2: Edit opens a field only on text, never on an element's empty area). `where` picks the
   * start, middle or end of that line box.
   */
  async clickText(selector: string, where: 'start' | 'middle' | 'end' = 'middle'): Promise<void> {
    await this.eval(`(function(){var e=document.querySelector(${JSON.stringify(selector)}); if (e && e.scrollIntoView) e.scrollIntoView({block:'center'});})()`);
    const r = await this.eval<{ x: number; y: number; w: number; h: number } | null>(
      `(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;var w=document.createTreeWalker(e,4);var t;while((t=w.nextNode())&&!t.data.trim()){}if(!t)return null;var g=document.createRange();g.selectNodeContents(t);var b=g.getClientRects()[0];return b?{x:b.left,y:b.top,w:b.width,h:b.height}:null;})()`,
    );
    if (!r) throw new Error(`no text in ${selector}`);
    const x = where === 'start' ? r.x + 2 : where === 'end' ? r.x + r.w - 2 : r.x + r.w / 2;
    // The page's CSS pixels are the view's times its zoom (Fit zooms a deck's view, 6.9; sendInputEvent takes the
    // view's coordinates).
    const zoom = await this.e.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor() ?? 1, this.wcId);
    await this.click(x * zoom, (r.y + r.h / 2) * zoom);
  }

  /** The edit overlay's state in test builds (preload edit-controller testState, the isolated world). */
  async editState<T = Record<string, unknown>>(): Promise<T> {
    return JSON.parse(await this.isolated<string>('JSON.stringify(globalThis.__blTestEdit ? globalThis.__blTestEdit.state() : null)', 999)) as T;
  }

  /** A key press (keyDown, char for printable keys without command modifiers, keyUp). */
  async key(keyCode: string, modifiers: string[] = []): Promise<void> {
    await this.focus();
    // Electron's sendInputEvent wants accelerator names ('Right', 'Esc'), not DOM `key` values, or the DOM
    // event's `.key` comes through empty. Normalize the common ones; pass single characters straight through.
    const kc = KEYCODE_ALIASES[keyCode] ?? keyCode;
    const evs: Record<string, unknown>[] = [{ type: 'keyDown', keyCode: kc, modifiers }];
    const command = modifiers.some((m) => ['control', 'ctrl', 'meta', 'cmd', 'command', 'alt'].includes(m));
    if (keyCode.length === 1 && !command) evs.push({ type: 'char', keyCode, modifiers });
    evs.push({ type: 'keyUp', keyCode: kc, modifiers });
    await this.input(evs, 10);
    await sleep(80);
  }

  /** The app's command chord: Cmd on macOS, Ctrl elsewhere (6.2). */
  async chord(keyCode: string, extra: string[] = []): Promise<void> {
    await this.key(keyCode, [process.platform === 'darwin' ? 'meta' : 'control', ...extra]);
  }

  /** A pointer drag through `points` with the left button held (a stroke). */
  async drag(points: Pt[], modifiers: string[] = []): Promise<void> {
    await this.focus();
    const [x0, y0] = points[0];
    const evs: Record<string, unknown>[] = [
      { type: 'mouseMove', x: x0, y: y0, modifiers },
      { type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1, modifiers },
    ];
    for (const [x, y] of points.slice(1)) evs.push({ type: 'mouseMove', x, y, button: 'left', modifiers: [...modifiers, 'leftButtonDown'] });
    const [x1, y1] = points[points.length - 1];
    evs.push({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1, modifiers });
    await this.input(evs, 8);
    await sleep(150);
  }

  /** Types text into the focused element as an input method would (webContents.insertText). */
  async insertText(text: string): Promise<void> {
    await this.e.evaluate(async ({ webContents }, a) => {
      await webContents.fromId(a.id)?.insertText(a.text);
    }, { id: this.wcId, text });
  }

  /** Puts `text` on the clipboard and pastes it into the focused element (webContents.paste: insertFromPaste). */
  async paste(text: string): Promise<void> {
    await this.e.evaluate(({ webContents, clipboard }, a) => {
      clipboard.writeText(a.text);
      webContents.fromId(a.id)?.paste();
    }, { id: this.wcId, text });
  }
}

/** DOM `key` value → Electron sendInputEvent keyCode (accelerator) name, for keys that differ. */
const KEYCODE_ALIASES: Readonly<Record<string, string>> = {
  ArrowRight: 'Right',
  ArrowLeft: 'Left',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Escape: 'Esc',
  Enter: 'Return',
  ' ': 'Space',
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A closed loop around a box (a pen ellipse), `n` points. */
export function loopAround(r: { x: number; y: number; w: number; h: number }, pad = 16, n = 36, turn = 0.97): Pt[] {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2 * turn;
    out.push([Math.round(cx + (r.w / 2 + pad) * Math.cos(t)), Math.round(cy + (r.h / 2 + pad) * Math.sin(t))]);
  }
  return out;
}

/** Copies a file or folder into `dir` (for decks opened from a temp folder, never from the repo). */
export function copyInto(src: string, dir: string, name = path.basename(src)): string {
  const dest = path.join(dir, name);
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}
