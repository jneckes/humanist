// Shared by the trust-native E2E specs and the trust security specs: opens the Settings window in a running app
// and finds its Playwright page.
//
// When the app wires Settings itself (the views item calls installSettingsWindow at startup; under
// BLUELINE_TEST=1 that exposes globalThis.__blSettings), the specs use that. Until it does, this harness bundles
// the Settings modules (settings-window.ts with config.ts, folders.ts and native-helper.ts) with esbuild and
// loads them into the running main process, against the same userData, dist/preload-settings.cjs and
// dist/shell/settings.html the app ships, so the window, its preload, its CSP, its channels and config.json are
// the real ones. `mode` in the result says which ran.

import type { Page } from '@playwright/test';
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_DIR, ROOT, sleep, type BlApp } from '../helpers/app';

export const DIST = path.join(APP_DIR, 'dist');

let bundled: Promise<string> | null = null;

/** Bundles the Settings modules into test-results/trust-native/ (once per test process). */
export function settingsHarnessBundle(): Promise<string> {
  if (bundled) return bundled;
  bundled = (async () => {
    const outDir = path.join(ROOT, 'test-results', 'trust-native');
    fs.mkdirSync(outDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(outDir, 0o755);
    const out = path.join(outDir, `settings-harness-${process.pid}.cjs`);
    const coreSubpaths: esbuild.Plugin = {
      name: 'core-subpaths',
      setup(build) {
        build.onResolve({ filter: /^@blueline\/core\// }, (a) => ({ path: path.join(ROOT, 'packages/core/src', a.path.slice('@blueline/core/'.length) + '.ts') }));
        build.onResolve({ filter: /^@blueline\/core$/ }, () => ({ path: path.join(ROOT, 'packages/core/src/index.ts') }));
      },
    };
    await esbuild.build({
      stdin: {
        contents: `
          import * as path from 'node:path';
          import { ConfigStore } from './packages/app/src/main/config';
          import { TrustSettings } from './packages/app/src/main/folders';
          import { nativeHelper } from './packages/app/src/main/native-helper';
          import { servedDirs } from './packages/app/src/main/app-paths';
          import { appLocationOptions, installSettingsWindow } from './packages/app/src/main/settings-window';
          export function install(o: { userData: string; dist: string }) {
            const config = ConfigStore.forUserData(o.userData);
            config.load();
            const settings = new TrustSettings(config, appLocationOptions());
            const changes: string[] = [];
            installSettingsWindow({
              settings,
              helper: nativeHelper,
              preload: path.join(o.dist, 'preload-settings.cjs'),
              shellDir: servedDirs(o.dist, false).shellDir,
              platform: process.platform,
              devTools: true,
              onTrustSettingsChanged: (c) => changes.push(c),
              log: (m) => console.error('[blueline] ' + m),
              test: true,
            });
            (globalThis as Record<string, unknown>).__blSettingsHarness = { changes };
          }
        `,
        resolveDir: ROOT,
        loader: 'ts',
        sourcefile: 'settings-harness.ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['electron'],
      outfile: out,
      logLevel: 'silent',
      plugins: [coreSubpaths],
    });
    fs.chmodSync(out, 0o644);
    return out;
  })();
  return bundled;
}

export interface OpenedSettings {
  page: Page;
  webContentsId: number;
  /** `app`: the app's own wiring (__blSettings); `harness`: loaded by this file. */
  mode: 'app' | 'harness';
}

/** Whether the app wired Settings itself (BLUELINE_TEST=1 exposes __blSettings). */
export async function appHasSettings(app: BlApp): Promise<boolean> {
  return await app.electronApp.evaluate(() => typeof (globalThis as Record<string, unknown>).__blSettings === 'object');
}

/** Makes the Settings window's channels exist: the app's, or the harness's. */
export async function ensureSettings(app: BlApp): Promise<'app' | 'harness'> {
  if (await appHasSettings(app)) return 'app';
  const bundle = await settingsHarnessBundle();
  await app.electronApp.evaluate(
    (_e, a) => {
      const g = globalThis as Record<string, unknown>;
      if (g.__blSettings) return;
      const req = (process as unknown as { mainModule?: { require(id: string): unknown } }).mainModule?.require;
      if (!req) throw new Error('no main module require');
      (req(a.bundle) as { install(o: { userData: string; dist: string }): void }).install({ userData: a.userData, dist: a.dist });
    },
    { bundle, userData: app.userData, dist: DIST },
  );
  return 'harness';
}

/** Opens Settings (or focuses it) and returns its page. */
export async function openSettings(app: BlApp, pane?: 'general' | 'trust'): Promise<OpenedSettings> {
  const mode = await ensureSettings(app);
  const id = await app.electronApp.evaluate((_e, p) => {
    const s = (globalThis as unknown as { __blSettings: { open(pane?: string): number } }).__blSettings;
    return s.open(p);
  }, pane);
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    for (const p of app.electronApp.windows()) {
      if (!p.url().startsWith('app://shell/settings.html')) continue;
      const wcId = await app.electronApp
        .browserWindow(p)
        .then((bw) => bw.evaluate((b) => (b as Electron.BrowserWindow).webContents.id))
        .catch(() => null);
      if (wcId === id) {
        await p.waitForLoadState('domcontentloaded');
        return { page: p, webContentsId: id, mode };
      }
    }
    await sleep(100);
  }
  throw new Error(`no Settings page for webContents ${id}\n${app.logs.slice(-30).join('\n')}`);
}

/** Makes main's folder dialog answer with `folder` (or Cancel when null). */
export async function answerFolderDialog(app: BlApp, folder: string | null): Promise<void> {
  await app.electronApp.evaluate(({ dialog }, f) => {
    (dialog as unknown as Record<string, unknown>).showOpenDialog = async () => (f === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [f] });
  }, folder);
}

/** config.json as the app wrote it. */
export function readConfig(app: BlApp): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.userData, 'config.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Polls config.json until `pred` holds. */
export async function waitConfig(app: BlApp, pred: (c: Record<string, unknown>) => boolean, timeout = 10_000): Promise<Record<string, unknown>> {
  const end = Date.now() + timeout;
  let c = readConfig(app);
  while (Date.now() < end) {
    c = readConfig(app);
    if (pred(c)) return c;
    await sleep(100);
  }
  throw new Error(`config.json never matched; last: ${JSON.stringify(c)}`);
}

/**
 * A folder outside every temporary folder (a trusted folder there is refused, 6.10), readable by the user the
 * app runs as: under the repo's test-results.
 */
export function trustableFolder(label: string, owner?: (p: string) => void): string {
  const base = path.join(ROOT, 'test-results', 'trust-native');
  fs.mkdirSync(base, { recursive: true });
  fs.chmodSync(base, 0o755);
  const dir = fs.mkdtempSync(path.join(base, `${label}-`));
  fs.chmodSync(dir, 0o755);
  owner?.(dir);
  made.push(dir);
  return fs.realpathSync.native(dir);
}

const made: string[] = [];

/** Removes the folders trustableFolder made. */
export function removeTrustableFolders(): void {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}
