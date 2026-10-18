// `blueline pdf deck.html [-o out.pdf]` through the installed command (6.1 The command line tool; 6.9 Save as
// PDF "without opening a window"): the POSIX shim packages/cli/dist/blueline finds Node 22+, runs blueline.cjs,
// which starts the app with --bl-cmd=pdf, prints the app's line and exits with its code. Each run's folder in
// the temp folder is gone afterwards, also after a SIGTERM, and a folder that a killed command left behind more
// than a day ago is swept by the next run. The app runs as root with --no-sandbox here, as the other E2E tests
// of the command do, on the display the global setup started. The command reads the user's Trust settings from
// the app's userData (command-trust.ts): each run gets an empty XDG_CONFIG_HOME, so the runner's own Blueline
// settings never change what is tested.

import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';

const ROOT = path.resolve(__dirname, '../..');
const SHIM = path.join(ROOT, 'packages/cli/dist/blueline');
const SAMPLE = path.join(ROOT, 'packages/app/dist/assets/sample/blueline-tour.html');

test.skip(process.platform === 'win32', 'the POSIX shim');
test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run through `npm run test:e2e` (its global setup starts Xvfb)');
test.setTimeout(180_000);

const dirs: string[] = [];
test.afterAll(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function deckCopy(): string {
  const d = tmp('bl-fl-pdf-deck-');
  const p = path.join(d, 'blueline-tour.html');
  fs.copyFileSync(SAMPLE, p);
  return p;
}

interface Run {
  code: number | null;
  out: string;
  err: string;
}

function blueline(args: string[], o: { cwd?: string; tmpdir: string }): Run {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: o.tmpdir, XDG_CONFIG_HOME: tmp('bl-fl-pdf-xdg-') };
  delete env.BLUELINE_USER_DATA;
  delete env.BLUELINE_TEST;
  const r = spawnSync(SHIM, args, { cwd: o.cwd, env, encoding: 'utf8', timeout: 150_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function pages(pdf: string): Promise<number> {
  return (await PDFDocument.load(fs.readFileSync(pdf))).getPageCount();
}

function runFolders(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.startsWith('blueline-cli-'));
}

test('blueline pdf deck.html: one page per slide next to the deck; the run folder is gone', async () => {
  expect(fs.statSync(SHIM).mode & 0o111).not.toBe(0);
  const deck = deckCopy();
  const t = tmp('bl-fl-pdf-tmp-');
  const r = blueline(['pdf', deck], { tmpdir: t });
  const pdf = deck.replace(/\.html$/, '.pdf');
  expect(r.code, r.err).toBe(0);
  expect(r.out).toBe(`blueline pdf: wrote ${pdf} (8 pages, one page per slide)\n`);
  expect(await pages(pdf)).toBe(8);
  expect(runFolders(t)).toEqual([]);
});

test('-o: a relative name, a folder, and --json', async () => {
  const deck = deckCopy();
  const t = tmp('bl-fl-pdf-tmp-');
  const cwd = tmp('bl-fl-pdf-cwd-');
  let r = blueline(['pdf', deck, '-o', 'handout.pdf'], { tmpdir: t, cwd });
  expect(r.code, r.err).toBe(0);
  expect(await pages(path.join(cwd, 'handout.pdf'))).toBe(8);
  const folder = tmp('bl-fl-pdf-out-');
  r = blueline(['pdf', deck, '--out', folder, '--json'], { tmpdir: t });
  expect(r.code, r.err).toBe(0);
  const json = JSON.parse(r.out) as { out: string; pages: number; mode: string; title: string; missed: number[] };
  expect(json).toEqual({ out: path.join(folder, 'blueline-tour.pdf'), pages: 8, mode: 'raster', title: 'Blueline sample deck', missed: [] });
  expect(runFolders(t)).toEqual([]);
});

test("refusals: a missing file (1, before the app starts) and the app's own (2)", () => {
  const t = tmp('bl-fl-pdf-tmp-');
  let r = blueline(['pdf', path.join(t, 'nope.html')], { tmpdir: t });
  expect(r.code).toBe(1);
  expect(r.err).toContain('no such file');
  const txt = path.join(tmp('bl-fl-pdf-txt-'), 'notes.txt');
  fs.writeFileSync(txt, 'hello');
  r = blueline(['pdf', txt], { tmpdir: t });
  expect(r.code).toBe(2);
  expect(r.out).toMatch(/blueline pdf: .*not an HTML file/);
  r = blueline(['pdf', deckCopy(), '-o', path.join(t, 'missing-folder', 'x.pdf')], { tmpdir: t });
  expect(r.code).toBe(2);
  expect(runFolders(t)).toEqual([]);
});

test('SIGTERM to the command stops the run (143), writes no PDF, and removes the run folder', async () => {
  const deck = deckCopy();
  const t = tmp('bl-fl-pdf-tmp-');
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: t, XDG_CONFIG_HOME: tmp('bl-fl-pdf-xdg-') };
  delete env.BLUELINE_USER_DATA;
  const child = spawn(SHIM, ['pdf', deck], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (c: Buffer) => (err += c.toString()));
  // Wait until the run folder exists (the app is starting), then signal the command alone.
  const end = Date.now() + 20_000;
  while (runFolders(t).length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  expect(runFolders(t)).toHaveLength(1);
  await new Promise((r) => setTimeout(r, 300));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  child.kill('SIGTERM');
  expect(await exited, err).toBe(143);
  expect(runFolders(t)).toEqual([]);
  expect(fs.existsSync(deck.replace(/\.html$/, '.pdf'))).toBe(false);
});

test('a run folder a killed command left more than a day ago is swept by the next run; a recent one is kept', () => {
  const t = tmp('bl-fl-pdf-tmp-');
  const stale = path.join(t, 'blueline-cli-STALE1');
  const recent = path.join(t, 'blueline-cli-RECENT');
  for (const d of [stale, recent]) {
    fs.mkdirSync(path.join(d, 'result.json.session'), { recursive: true });
    // A pid that cannot be running: above the kernel's pid_max.
    fs.writeFileSync(path.join(d, 'owner.pid'), '99999999\n');
  }
  const twoDaysAgo = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
  const r = blueline(['pdf', deckCopy()], { tmpdir: t });
  expect(r.code, r.err).toBe(0);
  expect(fs.existsSync(stale)).toBe(false);
  expect(fs.existsSync(recent)).toBe(true);
  expect(runFolders(t)).toEqual(['blueline-cli-RECENT']);
});
