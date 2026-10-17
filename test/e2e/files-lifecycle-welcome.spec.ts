// First run in the real app (6.0 First run; 9.9 Telemetry; 9.1 Shell view): on a fresh userData the welcome
// window opens, stores the user's name in config.json, records the crash-report answer, and opens the sample
// deck from its copy in app data (Trusted, editable, 8 slides, the tour ticking); on the next launch it does
// not open again.
//
// The welcome window is the app's own when the app wires first run (the views item calls installFirstRun at
// startup, and BLUELINE_TEST=1 exposes globalThis.__blWelcome). Until it does, this file bundles first-run.ts
// (with config.ts and native-helper.ts) and loads it into the running main process, against the same userData,
// dist/preload-welcome.cjs, dist/shell/welcome.html and dist/assets/sample the app ships, so the window, its
// preload, its CSP, its channels and config.json are the real ones; the test says which ran.

import { expect, test, type Page } from '@playwright/test';
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_DIR, FIXTURES, ROOT, Scratch, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';
import { sanitizeConfig } from '../../packages/app/src/main/config';

test.describe.configure({ mode: 'serial' });

const DIST = path.join(APP_DIR, 'dist');
const SAMPLE = 'blueline-tour.html';

/** config.ts keeps seen.welcome and crashReports (the files-lifecycle contract request). */
const configKeepsFirstRun = (() => {
  const c = sanitizeConfig({ seen: { welcome: true }, crashReports: false }) as { seen?: { welcome?: boolean }; crashReports?: boolean };
  return c.seen?.welcome === true && c.crashReports === false;
})();

let bundled: Promise<string> | null = null;

/** Bundles first run into test-results/files-lifecycle/ (once per test process), readable by the app's user. */
function harnessBundle(): Promise<string> {
  if (bundled) return bundled;
  bundled = (async () => {
    const outDir = path.join(ROOT, 'test-results', 'files-lifecycle');
    fs.mkdirSync(outDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(path.join(ROOT, 'test-results'), 0o755);
    fs.chmodSync(outDir, 0o755);
    const out = path.join(outDir, `welcome-harness-${process.pid}.cjs`);
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
          import { configFirstRunSettings, installFirstRun, SAMPLE_FILE } from './packages/app/src/main/first-run';
          import { nativeHelper } from './packages/app/src/main/native-helper';
          import { servedDirs } from './packages/app/src/main/app-paths';
          export function install(o: { userData: string; dist: string }) {
            const config = ConfigStore.forUserData(o.userData);
            config.load();
            const t = (globalThis as any).__blTest;
            installFirstRun({
              settings: configFirstRunSettings(config as any, () => 'Me'),
              helper: nativeHelper,
              open: async (p: string) => (await t.open(p, false)) !== null,
              sampleSource: path.join(o.dist, 'assets', 'sample', SAMPLE_FILE),
              userData: o.userData,
              preload: path.join(o.dist, 'preload-welcome.cjs'),
              shellDir: servedDirs(o.dist, false).shellDir,
              platform: process.platform,
              devTools: true,
              log: (m: string) => console.error('[blueline] ' + m),
              test: true,
            });
          }
        `,
        resolveDir: ROOT,
        loader: 'ts',
        sourcefile: 'welcome-harness.ts',
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

/** Makes first run exist in the app: its own wiring, or the harness. */
async function ensureFirstRun(app: BlApp): Promise<'app' | 'harness'> {
  const wired = await app.electronApp.evaluate(() => typeof (globalThis as Record<string, unknown>).__blWelcome === 'object');
  if (wired) return 'app';
  const bundle = await harnessBundle();
  await app.electronApp.evaluate(
    (_e, a) => {
      const req = (process as unknown as { mainModule?: { require(id: string): unknown } }).mainModule?.require;
      if (!req) throw new Error('no main module require');
      (req(a.bundle) as { install(o: { userData: string; dist: string }): void }).install({ userData: a.userData, dist: a.dist });
    },
    { bundle, userData: app.userData, dist: DIST },
  );
  return 'harness';
}

async function welcomePage(app: BlApp): Promise<Page> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    for (const p of app.electronApp.windows()) if (p.url().startsWith('app://shell/welcome.html')) {
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

async function launch(s: Scratch, userData?: string): Promise<BlApp> {
  // A file, so the app does not ask for one at startup (the welcome window replaces that ask once wired).
  const dir = s.dir('files-lifecycle-deck');
  const file = path.join(dir, 'single.html');
  fs.copyFileSync(path.join(FIXTURES, 'decks', 'single.html'), file);
  s.own(file);
  const app = await launchApp({ files: [file], scratch: s, userData });
  await app.waitForDeck('single.html');
  return app;
}

const scratch = new Scratch(resolveRunAs());
let userData = '';

test.afterAll(() => scratch.cleanup());

test('first launch: the welcome window opens, stores the name and the crash-report answer, and opens the sample deck', async () => {
  const app = await launch(scratch);
  userData = app.userData;
  try {
    const mode = await ensureFirstRun(app);
    test.info().annotations.push({ type: 'welcome-window', description: mode === 'app' ? "the app's own wiring" : 'loaded by this spec (the app does not wire first run yet)' });
    expect(await app.electronApp.evaluate(() => (globalThis as unknown as { __blWelcome: { maybeShow(): boolean } }).__blWelcome.maybeShow())).toBe(true);
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

    // 9.9: crash reports, asked once; stored (nothing is sent: there is no crash server in v1).
    await page.locator('#crash-no').check();
    if (configKeepsFirstRun) await waitConfig(userData, (x) => x.crashReports === false);
    else test.info().annotations.push({ type: 'fixme', description: 'config.ts does not keep crashReports and seen.welcome yet (contract request)' });

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
    await app.electronApp.evaluate(
      (_e, p) => (globalThis as unknown as { __blWelcome: { noteMode(p: string, m: string): void } }).__blWelcome.noteMode(p, 'review'),
      w.realpath,
    );
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
    await expect.poll(async () => app.electronApp.evaluate(() => (globalThis as unknown as { __blWelcome: { webContentsId(): number | null } }).__blWelcome.webContentsId())).toBeNull();
    expect(fs.readFileSync(w.realpath, 'utf8')).toContain('the user was here');
  } finally {
    await app.close();
  }
});

test('the next launch: the welcome window does not open again', async () => {
  test.fixme(!configKeepsFirstRun, 'config.ts drops seen.welcome until the files-lifecycle contract request (AppConfig.seen.welcome, crashReports) lands');
  expect(userData).not.toBe('');
  const app = await launch(scratch, userData);
  try {
    await ensureFirstRun(app);
    expect(await app.electronApp.evaluate(() => (globalThis as unknown as { __blWelcome: { maybeShow(): boolean } }).__blWelcome.maybeShow())).toBe(false);
    expect(app.electronApp.windows().some((p) => p.url().startsWith('app://shell/welcome.html'))).toBe(false);
    const c = readConfig(userData);
    expect(c).toMatchObject({ name: 'Ada Lovelace', crashReports: false, seen: { welcome: true } });
  } finally {
    await app.close();
  }
});
