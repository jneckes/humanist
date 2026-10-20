// Trust and Settings channels against a compromised renderer (SPEC 9.1 Shell view: "Main accepts trust changes
// only from the shell's trust-bar buttons and Settings"; 9.1 Preload: a deck "has no deck channel that changes
// trust, settings or the allowlist"; 6.10). As the rest of the suite: the app runs as bltest with the OS sandbox
// on (test/helpers/app.ts).
//
// - From a Protected deck view and from a render-mode view of the same document (same preload, mode, partition and
//   origin as the render service's views; built here because the app's own render views never get the test
//   switch that puts ipcRenderer on their isolated world), every SettingsToMain channel is invoked with the
//   arguments the Settings page would send, while the app's own Settings window is open (the app wires it; this
//   suite never installs one of its own). Every call is refused, and config.json, trust.json and the document's
//   trust state do not change. Positive control: the same calls from the Settings page succeed and change
//   config.json.
// - The Settings page's world has only the named Settings functions, no require or ipcRenderer, runs no inline
//   script (the 9.1 CSP) and cannot navigate.
// - A remembered decision does not survive a marker change: with markers injected through the test-only switch
//   BLUELINE_TEST_MARKERS (markers.ts; BLUELINE_TEST=1, unpackaged only), a Protected file's Allow network is
//   remembered for its marker and dropped when the marker changes.
// - A trusted folder opens a marked file Trusted, and an untrusted folder an unmarked file Protected (6.10).
// Every test runs its assertions: none skips itself when the behaviour it checks is missing (review finding 32),
// so a regression in how the app opens files fails the suite.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SettingsToMain } from '../../packages/core/src/ipc-trust';
import { Scratch, launchApp, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';
import { openFixture } from '../helpers/security';
import { DIST, answerFolderDialog, openSettings, readConfig, removeTrustableFolders, trustableFolder, waitConfig } from '../e2e/trust-native-harness';

test.describe.configure({ mode: 'serial' });

/** Arguments the Settings page sends on each channel. A channel added without an entry fails the test. */
function settingsArgs(folder: string): Record<string, unknown[]> {
  return {
    [SettingsToMain.getState]: [],
    [SettingsToMain.makeDefaultApp]: [],
    [SettingsToMain.addFolder]: ['trusted'],
    [SettingsToMain.removeFolder]: ['trusted', folder],
    [SettingsToMain.setStrictProtected]: [true],
    [SettingsToMain.addAllowlistHost]: ['evil.bl-attacker.test'],
    [SettingsToMain.removeAllowlistHost]: ['fonts.googleapis.com'],
    [SettingsToMain.resetAllowlist]: [],
    // Settings › General › Smart punctuation (6.3, Phase 2): config.json's `defaults` must not change either.
    [SettingsToMain.setSmartPunctuation]: [false],
  };
}

/** Invokes a channel from a view's isolated world (999) with __blTestIpc, as a compromised renderer would. */
async function invokeFrom(app: BlApp, wcId: number, channel: string, args: unknown[]): Promise<string> {
  const code = `(async function(){
    var ipc = globalThis.__blTestIpc;
    if (!ipc || typeof ipc.invoke !== 'function') return 'no-ipc';
    try { await ipc.invoke.apply(ipc, ${JSON.stringify([channel, ...args])}); return 'ok'; }
    catch (e) { return 'refused: ' + (e && e.message ? e.message : String(e)); }
  })()`;
  return await app.electronApp.evaluate(
    async ({ webContents }, a) => {
      const wc = webContents.fromId(a.id);
      if (!wc || wc.isDestroyed()) return 'no view';
      const run = wc.executeJavaScriptInIsolatedWorld(999, [{ code: a.code }]).then(
        (v) => String(v),
        (e) => `script error: ${String(e)}`,
      );
      return await Promise.race([run, new Promise<string>((r) => setTimeout(() => r('no answer'), 5000))]);
    },
    { id: wcId, code },
  );
}

/** An offscreen window like the render service's RenderView, on the document's partition and URL, in render mode. */
async function renderModeView(app: BlApp, deck: DeckView): Promise<number> {
  const w = await app.win(deck.docId);
  const id = await app.electronApp.evaluate(
    async ({ BrowserWindow }, a) => {
      const win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
          offscreen: true,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          partition: a.partition,
          preload: a.preload,
          additionalArguments: ['--bl-mode=render', '--bl-test=1'],
          backgroundThrottling: false,
        },
      });
      await win.webContents.loadURL(a.url);
      return win.webContents.id;
    },
    { partition: w.partition, preload: path.join(DIST, 'preload-deck.cjs'), url: w.deckUrl },
  );
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const ready = await app.electronApp.evaluate(async ({ webContents }, wcId) => {
      const wc = webContents.fromId(wcId);
      if (!wc || wc.isLoading()) return false;
      return (await wc.executeJavaScriptInIsolatedWorld(999, [{ code: 'typeof globalThis.__blTestIpc' }])) === 'object';
    }, id);
    if (ready) return id;
    await sleep(100);
  }
  throw new Error('the render-mode view never came up');
}

function snapshotFile(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '(absent)';
  }
}

test('every Settings channel invoked from a Protected deck view and from a render-mode view is refused and changes nothing (the Settings page is the positive control)', async () => {
  const s = new Scratch(resolveRunAs());
  const session = await openFixture({ scratch: s, fixture: 'ipc.html', trust: 'protected' });
  try {
    const { app, deck } = session;
    const folder = trustableFolder('forged', (p) => s.own(p));
    // The app's own Settings window is open (its channels have a window to act on) and the dialog would answer.
    const { page, mode } = await openSettings(app, 'trust');
    expect(mode, "the channels under test must be the app's own").toBe('app');
    await answerFolderDialog(app, folder);
    await sleep(500);
    const configFile = path.join(app.userData, 'config.json');
    const trustFile = path.join(app.userData, 'trust.json');
    const before = { config: snapshotFile(configFile), trust: snapshotFile(trustFile), win: await app.win(session.docId) };
    expect(before.win.trust).toBe('protected');

    const args = settingsArgs(folder);
    const channels = Object.values(SettingsToMain) as string[];
    expect(channels.filter((c) => !(c in args)), 'a SettingsToMain channel has no forged call').toHaveLength(0);
    const render = await renderModeView(app, deck);
    const outcome: Record<string, string> = {};
    for (const c of channels) {
      outcome[`deck ${c}`] = await invokeFrom(app, deck.wcId, c, args[c]);
      outcome[`render ${c}`] = await invokeFrom(app, render, c, args[c]);
    }
    const accepted = Object.entries(outcome).filter(([, v]) => !/^refused: .*Refused$/.test(v));
    expect(accepted, JSON.stringify(outcome, null, 1)).toHaveLength(0);
    await sleep(500);
    // The router logged the drops (test builds) ...
    for (const c of [SettingsToMain.setStrictProtected, SettingsToMain.addFolder, SettingsToMain.addAllowlistHost]) {
      expect(app.logsMatching(new RegExp(`ipc drop ${c} unregistered`)).length, c).toBeGreaterThanOrEqual(2);
    }
    // ... and nothing changed: config.json, trust.json, the document's trust; no folder dialog was shown for them.
    expect(snapshotFile(configFile)).toBe(before.config);
    expect(snapshotFile(trustFile)).toBe(before.trust);
    const after = await app.win(session.docId);
    expect({ trust: after.trust, network: after.networkAllowed, editing: after.editingAllowed }).toEqual({ trust: 'protected', network: false, editing: false });

    // Positive control: the same calls from the Settings page are accepted and change config.json.
    const r = await page.evaluate(async () => {
      const b = (window as unknown as { blueline: Record<string, (...a: unknown[]) => Promise<unknown>> }).blueline;
      await b.setStrictProtected(true);
      const host = await b.addAllowlistHost('fonts.example.com');
      const added = await b.addFolder('trusted');
      return { host, added };
    });
    expect(r.host).toEqual({ ok: true, host: 'fonts.example.com' });
    expect(r.added).toEqual({ ok: true, folder });
    const cfg = await waitConfig(app, (c) => c.strictProtected === true && Array.isArray(c.trustedFolders) && (c.trustedFolders as string[]).includes(folder));
    expect(cfg.cdnAllowlist).toContain('fonts.example.com');
    expect(cfg.cdnAllowlist).not.toContain('evil.bl-attacker.test');
  } finally {
    await session.close();
    s.cleanup();
    removeTrustableFolders();
  }
});

test('the Settings page has only the named Settings functions, runs no inline script and cannot navigate', async () => {
  const s = new Scratch(resolveRunAs());
  const session = await openFixture({ scratch: s, fixture: 'ipc.html', trust: 'protected' });
  try {
    const { page, mode } = await openSettings(session.app);
    expect(mode).toBe('app');
    const world = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const b = w.blueline as Record<string, unknown>;
      return {
        keys: Object.keys(b).sort(),
        allFunctions: Object.values(b).every((v) => typeof v === 'function'),
        require: typeof w.require,
        process: typeof w.process,
        ipc: typeof w.ipcRenderer,
        electron: typeof w.electron,
        frozen: Object.isFrozen(b) || (() => {
          try {
            (b as Record<string, unknown>).getState = () => 'hijacked';
            return (b.getState as () => unknown)() !== 'hijacked';
          } catch {
            return true;
          }
        })(),
      };
    });
    expect(world).toEqual({
      keys: ['addAllowlistHost', 'addFolder', 'getState', 'makeDefaultApp', 'onShowPane', 'onState', 'removeAllowlistHost', 'removeFolder', 'resetAllowlist', 'setSmartPunctuation', 'setStrictProtected'],
      allFunctions: true,
      require: 'undefined',
      process: 'undefined',
      ipc: 'undefined',
      electron: 'undefined',
      frozen: true,
    });
    // The 9.1 CSP: an inline script never runs.
    const inline = await page.evaluate(async () => {
      const sc = document.createElement('script');
      sc.textContent = 'window.__inlineRan = true;';
      document.head.append(sc);
      await new Promise((r) => setTimeout(r, 100));
      return (window as unknown as Record<string, unknown>).__inlineRan === true;
    });
    expect(inline).toBe(false);
    // It never navigates.
    await page.evaluate(() => {
      location.href = 'https://example.com/';
    });
    await sleep(500);
    expect(page.url()).toBe('app://shell/settings.html');
    // The protocol serves the page with the shell CSP header.
    const header = await session.app.electronApp.evaluate(async ({ session: ses }) => {
      const r = await ses.fromPartition('shell').fetch('app://shell/settings.html');
      return r.headers.get('content-security-policy');
    });
    expect(header).toBe("default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'");
  } finally {
    await session.close();
    s.cleanup();
    removeTrustableFolders();
  }
});

test('a remembered decision does not survive a marker change (6.10)', async () => {
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('trust-marker');
  const file = path.join(dir, 'received.html');
  fs.copyFileSync(path.join(__dirname, '../../fixtures/decks/single.html'), file);
  const markers = path.join(s.dir('trust-markers-file'), 'markers.json');
  const setMarker = (m: string | null) => {
    fs.writeFileSync(markers, JSON.stringify({ [fs.realpathSync.native(file)]: m }));
    s.own(markers);
  };
  s.own(dir);
  setMarker('0083;65f1c2a3;Safari;6E1F6E7C-1C1B-4B8E-9D2E-111111111111');
  const env = { BLUELINE_TEST_MARKERS: markers };
  let app = await launchApp({ files: [file], scratch: s, env });
  const userData = app.userData;
  const open = async () => {
    const d = await app.waitForDeck('received.html');
    return await app.win(d.docId);
  };
  try {
    // The injected marker opens the file Protected, with the marker's reason (works with decideTrust too).
    let w = await open();
    expect(w.trust).toBe('protected');
    expect(w.trustReason).toBe('Came from the internet');
    await sleep(500);
    const trustFile = path.join(userData, 'trust.json');
    // 6.8: the first Protected open is remembered (received) in trust.json, with its marker.
    const recorded = fs.existsSync(trustFile) ? (JSON.parse(snapshotFile(trustFile)) as { files?: Record<string, unknown> }).files?.[fs.realpathSync.native(file)] : undefined;
    expect(recorded, 'the first Protected open is recorded in trust.json').toMatchObject({
      marker: '0083;65f1c2a3;Safari;6E1F6E7C-1C1B-4B8E-9D2E-111111111111',
      received: true,
      allowNetwork: false,
    });

    // Allow network, remembered for this marker.
    await app.electronApp.evaluate(async ({ webContents }, id) => {
      await webContents.fromId(id)!.executeJavaScript('window.blueline.allowNetwork()');
    }, w.shellWebContentsId);
    await sleep(500);
    await app.close();
    app = await launchApp({ files: [file], scratch: s, env, userData });
    w = await open();
    expect(w.trust).toBe('protected');
    expect(w.networkAllowed, 'Allow network should be remembered while the marker is the same').toBe(true);
    await app.close();

    // A new download over the same path: a new marker. Protected again, network off, the old decision dropped.
    setMarker('0083;65f1c2b9;Safari;6E1F6E7C-1C1B-4B8E-9D2E-222222222222');
    app = await launchApp({ files: [file], scratch: s, env, userData });
    w = await open();
    expect(w.trust).toBe('protected');
    expect(w.networkAllowed).toBe(false);
    await sleep(500);
    const entry = JSON.parse(snapshotFile(trustFile)).files[fs.realpathSync.native(file)];
    expect(entry.marker).toBe('0083;65f1c2b9;Safari;6E1F6E7C-1C1B-4B8E-9D2E-222222222222');
    expect(entry.allowNetwork).toBe(false);
  } finally {
    await app.close();
    s.cleanup();
    removeTrustableFolders();
  }
});

test('a trusted folder opens a marked file Trusted; an untrusted folder opens an unmarked file Protected (6.10)', async () => {
  const s = new Scratch(resolveRunAs());
  const trusted = trustableFolder('trusted-folder', (p) => s.own(p));
  const marked = path.join(trusted, 'marked.html');
  fs.copyFileSync(path.join(__dirname, '../../fixtures/decks/single.html'), marked);
  s.own(marked);
  const untrustedDir = s.dir('untrusted-folder');
  const plain = path.join(untrustedDir, 'plain.html');
  fs.copyFileSync(path.join(__dirname, '../../fixtures/decks/single.html'), plain);
  s.own(plain);
  const markers = path.join(s.dir('trust-markers-file'), 'markers.json');
  fs.writeFileSync(markers, JSON.stringify({ [fs.realpathSync.native(marked)]: '0083;65f1c2a3;Safari;6E1F6E7C-1C1B-4B8E-9D2E-333333333333' }));
  s.own(markers);
  const env = { BLUELINE_TEST_MARKERS: markers };
  let app = await launchApp({ files: [plain], scratch: s, env });
  const userData = app.userData;
  try {
    await app.waitForDeck('plain.html');
    const { page, mode } = await openSettings(app, 'trust');
    expect(mode).toBe('app');
    await answerFolderDialog(app, trusted);
    await page.locator('#add-trusted').click();
    await answerFolderDialog(app, untrustedDir);
    await page.locator('#add-untrusted').click();
    await waitConfig(app, (c) => Array.isArray(c.untrustedFolders) && (c.untrustedFolders as unknown[]).length === 1 && Array.isArray(c.trustedFolders) && (c.trustedFolders as unknown[]).length === 1);
    expect(readConfig(app).trustedFolders).toEqual([trusted]);
    await app.close();

    app = await launchApp({ files: [marked, plain], scratch: s, env, userData });
    const m = await app.win((await app.waitForDeck('marked.html')).docId);
    const p = await app.win((await app.waitForDeck('plain.html')).docId);
    expect(m.trust, 'a marked file in a trusted folder opens Trusted').toBe('trusted');
    expect(p.trust, 'an unmarked file in an untrusted folder opens Protected').toBe('protected');
    expect(p.trustReason).toBe('In a folder you marked as untrusted');
  } finally {
    await app.close();
    s.cleanup();
    removeTrustableFolders();
  }
});
