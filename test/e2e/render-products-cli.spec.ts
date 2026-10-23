// `blueline pdf deck.html [-o out.pdf]`, the app side (6.1; 6.9 Save as PDF "without opening a window"): the
// app started with --bl-cmd=pdf, --bl-args=<base64url JSON PdfArgs> and --bl-out, exactly as `map` is started.
// When the CLI side (packages/cli, files-lifecycle item) knows `pdf`, the last test also runs it end to end.
// The app runs as root with --no-sandbox here, as the map E2E tests run the `blueline` command. The command
// reads the user's Trust settings from the app's userData (command-trust.ts), so every run gets an empty
// XDG_CONFIG_HOME of its own: the runner's own Blueline settings never change what is tested.

import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { electronBinary } from '../../scripts/electron-binary.cjs';

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'packages/app');
const CLI = path.join(ROOT, 'packages/cli/dist/blueline.cjs');
const FIXTURES = path.join(ROOT, 'fixtures');
const ELECTRON: string = electronBinary(APP);

test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run through `npm run test:e2e` (its global setup starts Xvfb)');
test.setTimeout(180_000);

const tmpDirs: string[] = [];
test.afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-pdf-cli-'));
  tmpDirs.push(d);
  return d;
}

/** The environment of a run: no test switch, and an empty settings folder (XDG_CONFIG_HOME: the app's userData on Linux). */
function runEnv(): NodeJS.ProcessEnv {
  return { ...process.env, BLUELINE_TEST: '', XDG_CONFIG_HOME: tmp() };
}

function encode(v: unknown): string {
  return Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
}

function appArgs(args: string[]): string[] {
  return [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), APP, ...args];
}

interface Result {
  code: number | null;
  json: { command: string; exitCode: number; text: string; json: Record<string, unknown> } | null;
  stderr: string;
}

function runPdf(pdfArgs: unknown, raw?: string): Result {
  const d = tmp();
  const out = path.join(d, 'result.json');
  const args = appArgs(['--bl-cmd=pdf', `--bl-args=${raw ?? encode(pdfArgs)}`, `--bl-out=${out}`]);
  const r = spawnSync(ELECTRON, args, { encoding: 'utf8', env: runEnv(), timeout: 150_000 });
  return { code: r.status, json: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null, stderr: r.stderr };
}

function deckIn(name: string): string {
  const d = tmp();
  const src = path.join(FIXTURES, name);
  const dst = path.join(d, path.basename(src));
  fs.copyFileSync(src, dst);
  return dst;
}

test('--bl-cmd=pdf writes <deck>.pdf next to the deck and reports the pages and the mode', () => {
  const deck = deckIn('decks/generic-index.html');
  const r = runPdf({ file: deck, out: null });
  expect(r.code, r.stderr.slice(-2000)).toBe(0);
  const pdf = path.join(path.dirname(deck), 'generic-index.pdf');
  expect(r.json).toEqual({
    command: 'pdf',
    exitCode: 0,
    text: `blueline pdf: wrote ${pdf} (6 pages, one page per slide)`,
    json: { out: pdf, pages: 6, mode: 'raster', title: 'Q3 business review', missed: [] },
  });
  expect(fs.readFileSync(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  // Nothing else is written next to the deck (no temp files, no probe copies).
  expect(fs.readdirSync(path.dirname(deck)).sort()).toEqual(['generic-index.html', 'generic-index.pdf']);
});

test('-o, --protected, and a print-CSS deck', () => {
  const deck = deckIn('render/page-css.html');
  const out = path.join(tmp(), 'slides.pdf');
  const r = runPdf({ file: deck, out, protected: true });
  expect(r.code, r.stderr.slice(-2000)).toBe(0);
  expect(r.json?.json).toMatchObject({ out, pages: 3, mode: 'print-css', title: 'Print CSS deck' });
  expect(r.stderr).toContain('page-css.html: protected (Opened at your request; rule requested)');
  expect(fs.existsSync(out)).toBe(true);
});

test('refuses to overwrite the deck, a non-.pdf name, a missing file and bad arguments (exit 2)', () => {
  const deck = deckIn('render/page-css.html');
  const before = fs.readFileSync(deck);
  const self = runPdf({ file: deck, out: deck });
  expect(self.code).toBe(2);
  expect(self.json).toMatchObject({ command: 'pdf', exitCode: 2, json: { error: 'usage' } });
  expect(self.json?.text).toMatch(/overwrite the document itself/);
  expect(fs.readFileSync(deck).equals(before)).toBe(true);

  const txt = runPdf({ file: deck, out: path.join(path.dirname(deck), 'x.txt') });
  expect(txt.code).toBe(2);
  expect(txt.json?.text).toMatch(/not a \.pdf/);

  const missing = runPdf({ file: path.join(path.dirname(deck), 'nope.html'), out: null });
  expect(missing.code).toBe(2);
  expect(missing.json?.text).toMatch(/was not found/);

  const bad = runPdf(null, encode({ file: 'relative.html', out: null }));
  expect(bad.code).toBe(2);
  expect(bad.json).toMatchObject({ exitCode: 2, json: { error: 'usage' } });
  expect(fs.readdirSync(path.dirname(deck))).toEqual(['page-css.html']);
});

test('a signal stops the run: 128 + n, the result says so, and no PDF is left', async () => {
  const d = tmp();
  fs.cpSync(path.join(FIXTURES, 'decks/reveal-hash'), d, { recursive: true });
  const deck = path.join(d, 'index.html');
  const out = path.join(tmp(), 'result.json');
  const child = spawn(ELECTRON, appArgs(['--bl-cmd=pdf', `--bl-args=${encode({ file: deck, out: null })}`, `--bl-out=${out}`]), { stdio: ['ignore', 'ignore', 'pipe'], env: runEnv() });
  let err = '';
  child.stderr?.on('data', (b: Buffer) => (err += b.toString('utf8')));
  // Wait until the walk is under way.
  const end = Date.now() + 60_000;
  while (!err.includes('index: ') && !err.includes('slide index') && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  child.kill('SIGTERM');
  const code = await new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
  expect(code, err.slice(-2000)).toBe(143);
  const res = JSON.parse(fs.readFileSync(out, 'utf8'));
  expect(res).toMatchObject({ command: 'pdf', exitCode: 143, json: { error: 'interrupted' } });
  expect(fs.existsSync(path.join(d, 'index.pdf'))).toBe(false);
  expect(fs.readdirSync(d).filter((f) => f.startsWith('.bl-write-'))).toEqual([]);
});

/** The CLI knows `pdf` once the files-lifecycle item wires it (packages/cli). */
function cliKnowsPdf(): boolean {
  if (!fs.existsSync(CLI)) return false;
  const r = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8', timeout: 20_000 });
  return /blueline pdf deck\.html/.test(`${r.stdout}${r.stderr}`) && !/arrive in later phases[^\n]*pdf|pdf[^\n]*later phases/.test(`${r.stdout}${r.stderr}`);
}

test('blueline pdf end to end through the command', () => {
  test.skip(!cliKnowsPdf(), 'the CLI side of `blueline pdf` (packages/cli) is not built yet; the app side is tested above');
  const deck = deckIn('render/title-escape.html');
  const out = path.join(path.dirname(deck), 'out.pdf');
  const r = spawnSync(process.execPath, [CLI, 'pdf', deck, '-o', out], { encoding: 'utf8', env: runEnv(), timeout: 150_000 });
  expect(r.status, `${r.stdout}\n${r.stderr}`.slice(-2000)).toBe(0);
  expect(fs.existsSync(out)).toBe(true);
  expect(`${r.stdout}${r.stderr}`).toContain('3 pages');
  const def = spawnSync(process.execPath, [CLI, 'pdf', deck], { encoding: 'utf8', env: runEnv(), timeout: 150_000 });
  expect(def.status, def.stderr.slice(-2000)).toBe(0);
  expect(fs.existsSync(path.join(path.dirname(deck), 'title-escape.pdf'))).toBe(true);
});
