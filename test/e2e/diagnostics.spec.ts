// The Diagnostics window and `blueline check` (SPEC section 10, Phase 0, Diagnostics window).
// - `blueline check --auto` runs the automatic checks headless and writes check.json to app data.
// - The interactive window: the diagnostics shell page beside a deck view on the bundled reveal.js deck,
//   with the real key router and mode switching; guided steps are recorded with Pass and Fail.
// Run with `npm run test:e2e` (global setup starts Xvfb on Linux).

import { _electron as electron, expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'packages/cli/dist/blueline.cjs');
const APP_DIR = path.join(ROOT, 'packages/app');
const ELECTRON_BIN = createRequire(path.join(APP_DIR, 'package.json'))('electron') as string;
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;

test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run through `npm run test:e2e` (its global setup starts Xvfb)');
test.describe.configure({ mode: 'serial' });

const AUTO = ['key-order', 'stop-propagation', 'app-chords', 'offscreen-keys', 'capture-size', 'fit-zoom'];

let base = '';
test.beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-diag-e2e-'));
});
test.afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

test('blueline check --auto: every automatic check passes and check.json is written', async () => {
  test.setTimeout(180_000);
  const userData = path.join(base, 'auto');
  const r = spawnSync(process.execPath, [CLI, 'check', '--auto', '--json'], { encoding: 'utf8', env: { ...process.env, BLUELINE_USER_DATA: userData }, timeout: 170_000 });
  expect(r.status, r.stderr.slice(-3000)).toBe(0);
  const j = JSON.parse(r.stdout);
  expect(j.steps.map((s: { id: string }) => s.id)).toEqual(AUTO);
  for (const s of j.steps) expect(s.result, `${s.id}: ${s.detail}`).toBe('pass');
  const file = path.join(userData, 'check.json');
  expect(j.savedTo).toBe(file);
  const check = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(Object.keys(check)).toEqual(['app', 'electron', 'chrome', 'os', 'at', 'steps', 'log']);
  expect(check.electron).toBe(process.versions.electron ?? check.electron);
  const capture = check.log.find((e: { event: string }) => e.event === 'check:capture-size');
  expect(capture.data).toMatchObject({ width: 3200, height: 1800 });
  const fit = check.log.find((e: { event: string }) => e.event === 'check:fit-zoom');
  expect(['setZoomFactor', 'css-zoom', 'both']).toContain(fit.data.matches);
});

test('the Diagnostics window: guided steps, mode chords on the deck, Pass, Save', async () => {
  test.setTimeout(180_000);
  const userData = path.join(base, 'window');
  const out = path.join(base, 'window-result.json');
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [...(ROOT_USER ? ['--no-sandbox'] : []), APP_DIR, '--bl-cmd=check', `--bl-out=${out}`],
    env: { ...process.env, BLUELINE_USER_DATA: userData },
    timeout: 60_000,
  });
  const exited = new Promise<void>((r) => app.process().once('exit', () => r()));
  // The window's own webContents is the shell; the deck view is a second page, and either may come first.
  let page = app.windows().find((w) => w.url().startsWith('app://shell/diagnostics.html'));
  for (let i = 0; !page && i < 300; i++) {
    await new Promise((r) => setTimeout(r, 100));
    page = app.windows().find((w) => w.url().startsWith('app://shell/diagnostics.html'));
  }
  if (!page) throw new Error('the diagnostics shell page never loaded');
  await expect(page.locator('#guided .step')).toHaveCount(6);
  await expect(page.locator('#automatic .step')).toHaveCount(6);
  await expect(page.locator('#mode')).toHaveText('Read');

  // The deck view: the bundled reveal.js deck, served over blueline:// with the diagnostics preload.
  await expect
    .poll(
      () =>
        app.evaluate(({ webContents }) => {
          const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('blueline://'));
          return wc && !wc.isLoading() ? wc.getURL() : '';
        }),
      { timeout: 30_000 },
    )
    .toMatch(/^blueline:\/\/[0-9a-f]{16}\/index\.html/);
  await page.waitForTimeout(500);

  // Cmd+2 / Ctrl+2 on the deck: main takes the chord in before-input-event and switches to Review (6.2).
  await app.evaluate(({ webContents }, mac) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('blueline://'))!;
    wc.focus();
    const modifiers = [mac ? 'meta' : 'control'] as ('meta' | 'control')[];
    wc.sendInputEvent({ type: 'keyDown', keyCode: '2', modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: '2', modifiers });
  }, process.platform === 'darwin');
  await expect(page.locator('#mode')).toHaveText('Review');
  await expect(page.locator('#log')).toContainText('app-mode');

  const step = page.locator('li[data-step="dictate-body-review"]');
  await step.locator('button[data-result="pass"]').click();
  await expect(step.locator('.badge')).toHaveText('pass');
  await expect(step.locator('.step-detail')).toContainText('evidence: mode review');

  await page.locator('#save').click();
  const file = path.join(userData, 'check.json');
  await expect(page.locator('#status')).toContainText(file);
  const check = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(check.steps.find((s: { id: string }) => s.id === 'dictate-body-review').result).toBe('pass');

  // Closing the window ends `blueline check`: the CommandResult goes to --bl-out.
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.close();
  });
  await exited;
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  expect(result).toMatchObject({ command: 'check', exitCode: 0 });
  expect(result.json.steps.find((s: { id: string }) => s.id === 'dictate-body-review').result).toBe('pass');
});

test('the Diagnostics deck: the heading logs beforeinput, the card takes text, strokes join the open note', async () => {
  test.setTimeout(180_000);
  const userData = path.join(base, 'deck');
  const out = path.join(base, 'deck-result.json');
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [...(ROOT_USER ? ['--no-sandbox'] : []), APP_DIR, '--bl-cmd=check', `--bl-out=${out}`],
    env: { ...process.env, BLUELINE_USER_DATA: userData },
    timeout: 60_000,
  });
  const exited = new Promise<void>((r) => app.process().once('exit', () => r()));
  const find = async (prefix: string) => {
    for (let i = 0; i < 300; i++) {
      const p = app.windows().find((w) => w.url().startsWith(prefix));
      if (p) return p;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no page at ${prefix}`);
  };
  const shell = await find('app://shell/diagnostics.html');
  const deck = await find('blueline://');
  await deck.waitForLoadState('load');
  await deck.waitForTimeout(800);
  const log = async () => (await shell.evaluate(() => window.blueline.diag.getState())).log;
  const events = async (name: string) => (await log()).filter((e) => e.event === name);

  // The heading becomes contenteditable="plaintext-only" on a click and logs each beforeinput.inputType.
  const box = (await deck.locator('#diag-heading').boundingBox())!;
  await deck.mouse.click(box.x + 20, box.y + box.height / 2);
  await expect.poll(async () => (await events('heading-input')).some((e) => e.data.began === true)).toBe(true);
  await deck.keyboard.type('ab', { delay: 50 });
  await expect.poll(async () => (await events('beforeinput')).map((e) => e.data.inputType)).toEqual(['insertText', 'insertText']);
  await deck.keyboard.press('Escape');
  await expect.poll(async () => (await events('heading-input')).some((e) => e.data.cancelled === true)).toBe(true);

  // Review through the app chord. Keys Playwright dispatches over CDP skip before-input-event, so the chord
  // goes in as trusted input from main, as a real key press does.
  await app.evaluate(({ webContents }, mac) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('blueline://'))!;
    wc.focus();
    const modifiers = [mac ? 'meta' : 'control'] as ('meta' | 'control')[];
    wc.sendInputEvent({ type: 'keyDown', keyCode: '2', modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: '2', modifiers });
  }, process.platform === 'darwin');
  await expect(shell.locator('#mode')).toHaveText('Review');

  // Pen, a new note on the hovered element, text in the card, then two strokes: all on one note.
  await deck.keyboard.press('1');
  await deck.mouse.move(400, 400);
  await deck.waitForTimeout(150);
  await deck.keyboard.press('n');
  await expect.poll(async () => (await events('note')).some((e) => e.data.op === 'create' && e.data.ok === true)).toBe(true);
  await deck.keyboard.type('hello', { delay: 30 });
  await expect.poll(async () => (await events('card-input')).at(-1)?.data.value).toBe('hello');
  for (const y of [300, 500]) {
    await deck.mouse.move(300, y);
    await deck.mouse.down();
    for (let i = 1; i <= 10; i++) await deck.mouse.move(300 + i * 20, y + i * 5);
    await deck.mouse.up();
    await deck.waitForTimeout(200);
  }
  await expect.poll(async () => (await events('mark-added')).filter((e) => e.data.noteId === 'n-0001').length).toBe(2);
  const notes = (await events('note')).filter((e) => e.data.ok === true);
  expect(new Set(notes.map((e) => e.data.id))).toEqual(new Set(['n-0001']));
  // The pin N placed is only the note's anchor: the first stroke takes its place, so the two strokes are
  // marks 1 and 2, as the dictate-strokes step says (6.4).
  expect(notes.at(-1)!.data).toMatchObject({ id: 'n-0001', text: 5, marks: 2 });

  const step = shell.locator('li[data-step="dictate-strokes"]');
  await step.locator('button[data-result="pass"]').click();
  await expect(step.locator('.step-detail')).toContainText('newest note: 5 characters, 2 mark(s)');

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.close();
  });
  await exited;
  expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toMatchObject({ command: 'check', exitCode: 0 });
});

test('the Diagnostics card logs a real paste: the wispr-card evidence says 1 paste (section 10; finding 17)', async () => {
  test.setTimeout(180_000);
  const userData = path.join(base, 'wispr-card');
  const out = path.join(base, 'wispr-card-result.json');
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [...(ROOT_USER ? ['--no-sandbox'] : []), APP_DIR, '--bl-cmd=check', `--bl-out=${out}`],
    env: { ...process.env, BLUELINE_USER_DATA: userData },
    timeout: 60_000,
  });
  const exited = new Promise<void>((r) => app.process().once('exit', () => r()));
  const find = async (prefix: string) => {
    for (let i = 0; i < 300; i++) {
      const p = app.windows().find((w) => w.url().startsWith(prefix));
      if (p) return p;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no page at ${prefix}`);
  };
  const shell = await find('app://shell/diagnostics.html');
  const deck = await find('blueline://');
  await deck.waitForLoadState('load');
  await deck.waitForTimeout(800);
  const events = async (name: string) => (await shell.evaluate(() => window.blueline.diag.getState())).log.filter((e) => e.event === name);

  // Review, then N on the slide: the card opens with focus (the step's own instructions).
  await app.evaluate(({ webContents }, mac) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('blueline://'))!;
    wc.focus();
    const modifiers = [mac ? 'meta' : 'control'] as ('meta' | 'control')[];
    wc.sendInputEvent({ type: 'keyDown', keyCode: '2', modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: '2', modifiers });
  }, process.platform === 'darwin');
  await expect(shell.locator('#mode')).toHaveText('Review');
  await deck.mouse.move(400, 400);
  await deck.waitForTimeout(150);
  await deck.keyboard.press('n');
  await expect.poll(async () => (await events('note')).some((e) => e.data.op === 'create' && e.data.ok === true)).toBe(true);

  // A real clipboard paste into the card, as Wispr Flow does (main writes the clipboard, then pastes).
  await app.evaluate(({ webContents, clipboard }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('blueline://'))!;
    clipboard.writeText('dictated by wispr');
    wc.paste();
  });
  await expect.poll(async () => (await events('card-input')).at(-1)?.data.value).toBe('dictated by wispr');
  expect((await events('paste')).map((e) => e.data)).toEqual([{ length: 17, field: 'card' }]);
  expect((await events('beforeinput')).map((e) => [e.data.inputType, e.data.field])).toEqual([['insertFromPaste', 'card']]);

  const step = shell.locator('li[data-step="wispr-card"]');
  await step.locator('button[data-result="pass"]').click();
  await expect(step.locator('.step-detail')).toContainText('1 paste, 1 card-input event(s)');

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.close();
  });
  await exited;
  expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toMatchObject({ command: 'check', exitCode: 0 });
});
