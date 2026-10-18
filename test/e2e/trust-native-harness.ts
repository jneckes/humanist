// Shared by the trust-native E2E specs and the trust security specs: opens the app's own Settings window in a
// running app and finds its Playwright page.
//
// The app wires Settings itself (index.ts calls installSettingsWindow at startup; under BLUELINE_TEST=1 that
// exposes globalThis.__blSettings). The specs only ever drive that window: nothing here installs a Settings
// window of its own, so a test can never pass against test-installed channels (review finding 32). When the app
// does not expose __blSettings, openSettings throws and the test fails.

import type { Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_DIR, ROOT, sleep, type BlApp } from '../helpers/app';

export const DIST = path.join(APP_DIR, 'dist');

export interface OpenedSettings {
  page: Page;
  webContentsId: number;
  /** Always `app`: the app's own wiring (__blSettings). The specs assert it. */
  mode: 'app';
}

/** Whether the app wired Settings itself (BLUELINE_TEST=1 exposes __blSettings). */
export async function appHasSettings(app: BlApp): Promise<boolean> {
  return await app.electronApp.evaluate(() => typeof (globalThis as Record<string, unknown>).__blSettings === 'object');
}

/** The app's own Settings channels exist; throws when the app does not wire Settings. */
export async function ensureSettings(app: BlApp): Promise<'app'> {
  if (await appHasSettings(app)) return 'app';
  throw new Error(`the app does not wire its Settings window (no __blSettings under BLUELINE_TEST=1)\n${app.logs.slice(-30).join('\n')}`);
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
