// Launching without a file, through the app's own startup path (6.0 First run; 6.1 Mechanics; review findings
// 24, 26 and 34). BLUELINE_TEST_FIRST_RUN=1 turns the real startup windows on in a test build; nothing here
// installs or calls a window itself.
//
// - The first launch (a fresh userData) shows the first-run welcome by itself: the name and the crash-report
//   question, and config.json records seen.welcome.
// - A later launch without a file shows the Open window on Windows and Linux (the welcome window without the
//   first-run questions: the app has no other UI there); macOS shows nothing (startup-window.test.ts).
// - A launch with a file shows neither.
// - A second launch without a file brings forward the Blueline window that is open: the Open window, or
//   Settings when only Settings is open (a document window first, as before).

import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_DIR, ELECTRON_BIN, FIXTURES, Scratch, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

/** The real startup windows in a test build (index.ts). */
const FIRST_RUN = { BLUELINE_TEST_FIRST_RUN: '1' };
let userData = '';

function readConfig(dir: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The welcome or Open window's page, once the app has opened it by itself. */
async function welcomePage(app: BlApp, ms = 15_000): Promise<Page> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const p of app.electronApp.windows()) {
      if (!p.url().startsWith('app://shell/welcome.html')) continue;
      await p.waitForLoadState('domcontentloaded');
      return p;
    }
    await sleep(100);
  }
  throw new Error(`no welcome or Open window\n${app.logs.slice(-30).join('\n')}`);
}

/** Main's view of a shell window, by its webContents id: shown, focused, its title. */
async function winState(app: BlApp, wcId: number | null): Promise<{ visible: boolean; focused: boolean; title: string } | null> {
  return await app.electronApp.evaluate(({ BrowserWindow, webContents }, id) => {
    if (id === null) return null;
    const wc = webContents.fromId(id);
    const w = wc ? BrowserWindow.fromWebContents(wc) : null;
    return w && !w.isDestroyed() ? { visible: w.isVisible(), focused: w.isFocused(), title: w.getTitle() } : null;
  }, wcId);
}

const welcomeWc = (app: BlApp) => app.electronApp.evaluate(() => (globalThis as unknown as { __blWelcome: { webContentsId(): number | null } }).__blWelcome.webContentsId());
const settingsWc = (app: BlApp) => app.electronApp.evaluate(() => (globalThis as unknown as { __blSettings: { webContentsId(): number | null } }).__blSettings.webContentsId());

/** Hides a shell window (a stand-in for "behind another app": Xvfb has no window manager to minimise it). */
async function hide(app: BlApp, wcId: number): Promise<void> {
  // The window shows itself on ready-to-show (first-run.ts), which can come after its page's DOMContentLoaded: a
  // hide before that would be undone by the show. Wait until it is shown.
  await expect.poll(async () => (await winState(app, wcId))?.visible ?? false).toBe(true);
  await app.electronApp.evaluate(({ BrowserWindow, webContents }, id) => {
    const wc = webContents.fromId(id);
    BrowserWindow.fromWebContents(wc!)!.hide();
  }, wcId);
  await expect.poll(async () => (await winState(app, wcId))?.visible).toBe(false);
}

/**
 * A second `electron packages/app` with no file, as the same user and with the same userData: it hands the
 * launch to the running app (second-instance) and exits.
 */
function secondLaunch(app: BlApp): { status: number | null; stderr: string } {
  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: app.info.home,
    LANG: 'C.UTF-8',
    TMPDIR: app.info.tmpDir,
    BLUELINE_TEST: '1',
    BLUELINE_USER_DATA: app.userData,
  };
  if (process.env.DISPLAY) env.DISPLAY = process.env.DISPLAY;
  const runAs = scratch.runAs;
  const electronArgs = [...(runAs.sandbox ? [] : ['--no-sandbox']), APP_DIR];
  const r =
    runAs.mode === 'bltest'
      ? spawnSync('setpriv', [`--reuid=${runAs.uid}`, `--regid=${runAs.gid}`, '--clear-groups', '--', ELECTRON_BIN, ...electronArgs], { env, cwd: app.info.home, timeout: 60_000, encoding: 'utf8' })
      : spawnSync(ELECTRON_BIN, electronArgs, { env, cwd: app.info.home, timeout: 60_000, encoding: 'utf8' });
  return { status: r.status, stderr: String(r.stderr ?? '') };
}

test('the first launch without a file: the first-run welcome opens by itself and records seen.welcome', async () => {
  const app = await launchApp({ files: [], scratch, env: FIRST_RUN });
  userData = app.userData;
  try {
    const page = await welcomePage(app);
    // The first-run questions (6.0: the name; 9.9: crash reports, asked once at first run).
    await expect(page.locator('h1')).toHaveText('Welcome to Blueline');
    await expect(page.locator('#name-title')).toBeVisible();
    await expect(page.locator('#name-input')).toBeVisible();
    await expect(page.locator('#crash-title')).toBeVisible();
    await expect(page.locator('#open-file')).toBeVisible();
    await expect(page.locator('#open-sample')).toBeVisible();
    expect((await winState(app, await welcomeWc(app)))?.title).toBe('Welcome to Blueline');
    await expect.poll(() => (readConfig(userData).seen as { welcome?: boolean } | undefined)?.welcome ?? false).toBe(true);
  } finally {
    await app.close();
  }
});

test('a later launch without a file: the Open window, without the first-run questions (Windows and Linux)', async () => {
  expect(userData).not.toBe('');
  const app = await launchApp({ files: [], scratch, userData, env: FIRST_RUN });
  try {
    const page = await welcomePage(app);
    await expect(page.locator('#open-file')).toBeVisible();
    await expect(page.locator('#open-sample')).toBeVisible();
    await expect(page.locator('#make-default')).toBeVisible();
    // No name, no crash-report question, no tour: those are the first run's.
    await expect(page.locator('#name-title')).toBeHidden();
    await expect(page.locator('#name-input')).toBeHidden();
    await expect(page.locator('#crash-title')).toBeHidden();
    await expect(page.locator('#tour')).toBeHidden();
    expect((await winState(app, await welcomeWc(app)))?.title).toBe('Blueline');
    // Main answers the Open window's page only for what it shows: the first-run answers are refused there.
    const name = readConfig(userData).name;
    const refused = await page.evaluate(() =>
      (window as unknown as { blueline: { setName(n: string): Promise<unknown> } }).blueline.setName('Mallory').then(
        () => false,
        () => true,
      ),
    );
    expect(refused).toBe(true);
    expect(readConfig(userData).name).toBe(name);
  } finally {
    await app.close();
  }
});

test('a launch with a file: neither the welcome nor the Open window', async () => {
  const dir = scratch.dir('launch-deck');
  const file = path.join(dir, 'single.html');
  fs.copyFileSync(path.join(FIXTURES, 'decks', 'single.html'), file);
  scratch.own(file);
  const app = await launchApp({ files: [file], scratch, userData, env: FIRST_RUN });
  try {
    await app.waitForDeck('single.html');
    await sleep(1500);
    expect(app.electronApp.windows().some((p) => p.url().startsWith('app://shell/welcome.html'))).toBe(false);
    expect(await welcomeWc(app)).toBeNull();
  } finally {
    await app.close();
  }
});

test('a second launch without a file shows and focuses the Open window when it is the only window', async () => {
  const app = await launchApp({ files: [], scratch, userData, env: FIRST_RUN });
  try {
    await welcomePage(app);
    const wc = await welcomeWc(app);
    expect(wc).not.toBeNull();
    await hide(app, wc!);
    const r = secondLaunch(app);
    expect(r.status, r.stderr).toBe(0);
    await expect.poll(async () => await winState(app, wc), { timeout: 10_000 }).toMatchObject({ visible: true, focused: true });
    // The same window, not a second one.
    expect(app.electronApp.windows().filter((p) => p.url().startsWith('app://shell/welcome.html'))).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test('a second launch without a file shows and focuses Settings when only Settings is open', async () => {
  const app = await launchApp({ files: [], scratch, userData, env: FIRST_RUN });
  try {
    await welcomePage(app);
    const settings = await app.electronApp.evaluate(() => (globalThis as unknown as { __blSettings: { open(): number } }).__blSettings.open());
    await expect.poll(async () => (await winState(app, settings))?.visible ?? false).toBe(true);
    // Close the Open window: Settings is now the only window (the app stays: a window is open).
    await app.electronApp.evaluate(() => (globalThis as unknown as { __blWelcome: { close(): void } }).__blWelcome.close());
    await expect.poll(() => welcomeWc(app)).toBeNull();
    expect(await settingsWc(app)).toBe(settings);
    await hide(app, settings);
    const r = secondLaunch(app);
    expect(r.status, r.stderr).toBe(0);
    await expect.poll(async () => await winState(app, settings), { timeout: 10_000 }).toMatchObject({ visible: true, focused: true });
    // Settings is what was open: no Open window is added next to it.
    await sleep(500);
    expect(await welcomeWc(app)).toBeNull();
  } finally {
    await app.close();
  }
});
