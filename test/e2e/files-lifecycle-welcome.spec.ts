// First run in the real app (6.0 First run; 9.9 Telemetry; 9.1 Shell view): launched without a file on a fresh
// userData, the app opens the welcome window by itself; it stores the user's name in config.json, records the
// crash-report answer, and opens the sample deck from its copy in app data (Trusted, editable, 8 slides, the tour
// ticking). The next launch without a file shows the Open window instead, without the first-run questions, and
// Help › Welcome to Blueline still shows the whole welcome.
//
// The windows are the app's own: BLUELINE_TEST_FIRST_RUN=1 turns on the startup windows in a test build
// (index.ts), and nothing here installs first run or opens the window itself (review finding 34).

import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_DIR, Scratch, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const DIST = path.join(APP_DIR, 'dist');
const SAMPLE = 'blueline-tour.html';
const FIRST_RUN = { BLUELINE_TEST_FIRST_RUN: '1' };

/** The welcome (or Open) window's page, once the app has opened it; `except` skips a page already seen. */
async function welcomePage(app: BlApp, except: Page | null = null): Promise<Page> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    for (const p of app.electronApp.windows()) {
      if (p === except || p.isClosed() || !p.url().startsWith('app://shell/welcome.html')) continue;
      await p.waitForLoadState('domcontentloaded');
      return p;
    }
    await sleep(100);
  }
  throw new Error(`no welcome page\n${app.logs.slice(-30).join('\n')}`);
}

function readConfig(userData: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function waitConfig(userData: string, pred: (c: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const end = Date.now() + 10_000;
  let c = readConfig(userData);
  while (Date.now() < end) {
    c = readConfig(userData);
    if (pred(c)) return c;
    await sleep(100);
  }
  throw new Error(`config.json never matched; last: ${JSON.stringify(c)}`);
}

const welcomeWc = (app: BlApp) => app.electronApp.evaluate(() => (globalThis as unknown as { __blWelcome: { webContentsId(): number | null } }).__blWelcome.webContentsId());

const scratch = new Scratch(resolveRunAs());
let userData = '';

test.afterAll(() => scratch.cleanup());

test('first launch: the welcome window opens by itself, stores the name and the crash-report answer, and opens the sample deck', async () => {
  const app = await launchApp({ files: [], scratch, env: FIRST_RUN });
  userData = app.userData;
  try {
    const page = await welcomePage(app);

    // 9.1 Shell view: the shell CSP, and only the welcome API (named functions), no Node.
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toBe("default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'");
    const api = await page.evaluate(() => Object.keys((window as unknown as { blueline: Record<string, unknown> }).blueline).sort());
    expect(api).toEqual(['close', 'getState', 'makeDefaultApp', 'onState', 'openFile', 'openSample', 'setCrashReports', 'setName']);
    expect(await page.evaluate(() => typeof (window as unknown as Record<string, unknown>).require)).toBe('undefined');

    // 6.0: three ways to start; on Linux the default app is set in the desktop's settings.
    await expect(page.locator('h1')).toHaveText('Welcome to Blueline');
    await expect(page.locator('#open-file')).toBeEnabled();
    await expect(page.locator('#open-sample')).toBeEnabled();
    await expect(page.locator('#default-status')).toContainText(/Linux|desktop/);
    await expect(page.locator('#make-default')).toBeDisabled();

    // The name on the user's notes (6.8), stored in config.json; the Person id stays as identity made it.
    const personId = (await waitConfig(userData, (c) => typeof c.personId === 'string')).personId;
    await page.locator('#name-input').fill('  Ada  Lovelace ');
    await page.locator('#name-save').click();
    await expect(page.locator('#name-result')).toHaveText('Saved. Your notes will say Ada Lovelace.');
    const c = await waitConfig(userData, (x) => x.name === 'Ada Lovelace');
    expect(c.personId).toBe(personId);

    // 9.9: crash reports, asked once at first run; stored (nothing is sent: there is no crash server in v1).
    await page.locator('#crash-no').check();
    await waitConfig(userData, (x) => x.crashReports === false);
    // Offered once: recorded as soon as it was on screen.
    await waitConfig(userData, (x) => (x.seen as { welcome?: boolean } | undefined)?.welcome === true);

    // Try the sample deck: a copy in app data, opened Trusted and editable (6.0: it must show Edit).
    await expect(page.locator('#tour')).toBeHidden();
    await page.locator('#open-sample').click();
    const deck = await app.waitForDeck(SAMPLE);
    const w = await app.win(deck.docId);
    expect(w.realpath).toBe(path.join(fs.realpathSync(userData), 'sample', SAMPLE));
    expect(w.trust).toBe('trusted');
    expect(w.editingAllowed).toBe(true);
    expect(fs.readFileSync(w.realpath)).toEqual(fs.readFileSync(path.join(DIST, 'assets', 'sample', SAMPLE)));
    await expect(page.locator('#action-result')).toContainText('sample deck is open');
    await expect(page.locator('#tour')).toBeVisible();
    await expect(page.locator('#tour-steps li')).toHaveCount(3);
    await expect(page.locator('#tour-steps li').nth(0)).toHaveAttribute('data-done', 'true');
    await expect(page.locator('#tour-steps li').nth(1)).toHaveAttribute('data-done', 'false');
    // Its slides are detected (8, by hash) and it moves with the arrow keys.
    await expect.poll(async () => (await app.win(deck.docId)).state.slide?.count ?? 0).toBe(8);
    await deck.focus();
    await deck.key('Right');
    await expect.poll(async () => (await app.win(deck.docId)).state.slide?.current ?? -1).toBe(1);
    expect(await deck.eval<string>('location.hash')).toBe('#s-modes');

    // The tour ticks Review when the sample's window switches to it (the views item reports mode changes).
    await app.run('mode-review', deck.docId);
    await expect(page.locator('#tour-steps li').nth(1)).toHaveAttribute('data-done', 'true');

    // Opening it again opens the same copy (its edits and notes are the user's).
    fs.appendFileSync(w.realpath, '\n<!-- the user was here -->\n');
    // Done closes the window it is in, so the click can see its page close before the click's own protocol
    // reply arrives (under load it did: "Target page ... has been closed"). Only that error is tolerated; the
    // window must still close, and the app must still answer below.
    const closed = page.waitForEvent('close');
    await page
      .locator('#done')
      .click()
      .catch((e: unknown) => {
        if (!/has been closed/.test(String(e))) throw e;
      });
    await closed;
    await expect.poll(() => welcomeWc(app)).toBeNull();
    expect(fs.readFileSync(w.realpath, 'utf8')).toContain('the user was here');
  } finally {
    await app.close();
  }
});

test('the next launch without a file: the Open window, not the first-run questions; Help › Welcome to Blueline shows the whole welcome', async () => {
  expect(userData).not.toBe('');
  const app = await launchApp({ files: [], scratch, userData, env: FIRST_RUN });
  try {
    const open = await welcomePage(app);
    await expect(open.locator('#open-file')).toBeEnabled();
    await expect(open.locator('#open-sample')).toBeEnabled();
    for (const id of ['#name-title', '#crash-title', '#tour', '#done']) await expect(open.locator(id)).toBeHidden();
    // The first run's answers stay as they were given.
    expect(readConfig(userData)).toMatchObject({ name: 'Ada Lovelace', crashReports: false, seen: { welcome: true } });

    // Help › Welcome to Blueline: the whole welcome replaces the Open window (the app does not quit in between).
    const openWc = await welcomeWc(app);
    await app.run('welcome');
    const welcome = await welcomePage(app, open);
    await expect.poll(() => welcomeWc(app)).not.toBe(openWc);
    await expect(welcome.locator('#name-title')).toBeVisible();
    await expect(welcome.locator('#crash-title')).toBeVisible();
    await expect(welcome.locator('#name-input')).toHaveValue('Ada Lovelace');
    await expect(welcome.locator('#crash-no')).toBeChecked();
    await expect.poll(() => open.isClosed()).toBe(true);
  } finally {
    await app.close();
  }
});
