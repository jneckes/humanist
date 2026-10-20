// The `blueline` command with the real app (SPEC 6.1 The command line tool; section 10: map deletes its
// probe copy when interrupted, and on Linux CI the app runs under xvfb-run).
//
// - A signal sent to the command alone (a CI timeout, a parent's child.kill()) stops the whole run: the
//   command exits 128 + n within seconds, map's probe copy is gone, and no Electron or Xvfb process of the
//   run is left. DISPLAY is unset, so the command starts the app under xvfb-run, as on CI.
// - A command killed outright (SIGKILL) leaves no app behind either: the app watches the command's pid.
// - `blueline open` exits 1 when the app cannot start, with or without xvfb-run.
//
// Each run's processes are found by a marker in their environment (the command, xvfb-run, Xvfb and
// Electron's main process inherit it) and by their sessions (Chromium's helpers). Each run gets a private
// TMPDIR, which must be empty afterwards: the command's run folder, xvfb-run's folder and the app's temp
// folders all went.

// Tests tagged @edit assert results of the mutation probe, which writes through the editor (dist/editor.cjs): the
// reader-only gate (npm run test:reader-only, P2-15) leaves them out.

import { _electron as electron, expect, test } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'packages/cli/dist/blueline.cjs');
const DECKS = path.join(ROOT, 'fixtures/decks');
const APP_DIR = path.join(ROOT, 'packages/app');
const ELECTRON_BIN = createRequire(path.join(APP_DIR, 'package.json'))('electron') as string;
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;

const hasXvfbRun = process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).status === 0;
test.skip(!hasXvfbRun, 'needs Linux with xvfb-run (the command runs the app under it when there is no display)');

const tmpDirs: string[] = [];
test.afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function sha256(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

interface Proc {
  pid: number;
  sid: number;
  cmd: string;
  marked: boolean;
}

/** Every process (Linux /proc): its session, command line, and whether its environment has BL_E2E_RUN=<mark>. */
function procs(mark: string): Proc[] {
  const out: Proc[] = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${n}/stat`, 'latin1');
      const sid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]);
      const cmd = fs.readFileSync(`/proc/${n}/cmdline`, 'latin1').split('\0').join(' ').trim().slice(0, 160);
      let marked = false;
      try {
        marked = fs.readFileSync(`/proc/${n}/environ`, 'latin1').split('\0').includes(`BL_E2E_RUN=${mark}`);
      } catch {
        // not readable
      }
      out.push({ pid: Number(n), sid, cmd, marked });
    } catch {
      // gone
    }
  }
  return out;
}

/**
 * The processes of a run: the ones carrying its marker (the command, xvfb-run, Xvfb, Electron's main
 * process) and every process in their sessions (Chromium starts its helpers with a cleaned environment,
 * but in the same session). `sessions` collects the sessions seen so far, so orphans are still found
 * after their parents have exited.
 */
function runProcs(mark: string, sessions: Set<number>): Proc[] {
  const all = procs(mark);
  for (const p of all) if (p.marked) sessions.add(p.sid);
  return all.filter((p) => p.marked || sessions.has(p.sid));
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

interface Run {
  child: ChildProcess;
  mark: string;
  sessions: Set<number>;
  tmpdir: string;
  out: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
  /** The run's processes now (see runProcs). */
  procs: () => Proc[];
}

/**
 * Starts `blueline <args>` with no display (so under xvfb-run), in its own session, as a CI job's step
 * runs: a signal sent to its pid reaches it alone.
 */
function startCli(args: string[], extraEnv: Record<string, string> = {}): Run {
  const mark = randomUUID();
  const tmpdir = tmp('bl-cli-e2e-tmp-');
  const env: NodeJS.ProcessEnv = { ...process.env, BL_E2E_RUN: mark, TMPDIR: tmpdir, BLUELINE_USER_DATA: path.join(tmp('bl-cli-e2e-ud-'), 'ud'), ...extraEnv };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const child = spawn(process.execPath, [CLI, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  child.stdout!.on('data', (b: Buffer) => (out += b.toString('utf8')));
  child.stderr!.on('data', (b: Buffer) => (out += b.toString('utf8')));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((r) =>
    child.once('close', (code, signal) => r({ code, signal, at: Date.now() })),
  );
  const sessions = new Set<number>();
  return { child, mark, sessions, tmpdir, out: () => out, exited, procs: () => runProcs(mark, sessions) };
}

/** Kills whatever a failed test left behind, so one failure does not leak into the next tests. */
function reap(run: Run): void {
  for (const p of run.procs()) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
}

const show = (ps: Proc[]) => JSON.stringify(ps.map((p) => `${p.pid} ${p.cmd}`));

test('SIGTERM to `blueline check` alone (no display: xvfb-run) stops the run: 143, nothing left running', async () => {
  test.setTimeout(120_000);
  const run = startCli(['check']);
  try {
    // The Diagnostics window is up once a renderer of the run exists.
    expect(await until(() => run.procs().some((p) => p.cmd.includes('--type=renderer')), 60_000), run.out().slice(-3000)).toBe(true);
    const before = run.procs();
    expect(before.some((p) => p.cmd.includes('xvfb-run'))).toBe(true);
    expect(before.some((p) => /^Xvfb /.test(p.cmd))).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    process.kill(run.child.pid!, 'SIGTERM');
    const r = await Promise.race([run.exited, new Promise<null>((res) => setTimeout(() => res(null), 15_000))]);
    expect(r, `the command did not exit within 15 s; still running: ${show(run.procs())}`).not.toBeNull();
    expect(r!.code, run.out().slice(-3000)).toBe(143);
    expect(r!.at - t0).toBeLessThan(15_000);
    expect(run.out()).toContain('blueline check: interrupted (SIGTERM)');
    expect(await until(() => run.procs().length === 0, 5000), show(run.procs())).toBe(true);
    expect(fs.readdirSync(run.tmpdir)).toEqual([]);
  } finally {
    reap(run);
  }
});

test('SIGTERM to `blueline map` alone during the probe: 143, the probe copy is gone, the deck untouched, nothing left running @edit', async () => {
  test.setTimeout(180_000);
  const dir = tmp('bl-cli-e2e-map-');
  const deck = path.join(dir, 'js-templates.html');
  fs.copyFileSync(path.join(DECKS, 'js-templates.html'), deck);
  const before = sha256(deck);
  const copy = path.join(dir, '.js-templates.bl-probe.html');
  const run = startCli(['map', deck, '--report']);
  try {
    expect(await until(() => fs.existsSync(copy), 120_000), run.out().slice(-3000)).toBe(true);
    await new Promise((r) => setTimeout(r, 1000));
    expect(run.procs().some((p) => /^Xvfb /.test(p.cmd))).toBe(true);
    const t0 = Date.now();
    process.kill(run.child.pid!, 'SIGTERM');
    const r = await Promise.race([run.exited, new Promise<null>((res) => setTimeout(() => res(null), 15_000))]);
    expect(r, `the command did not exit within 15 s; still running: ${show(run.procs())}`).not.toBeNull();
    expect(r!.code, run.out().slice(-3000)).toBe(143);
    expect(r!.at - t0).toBeLessThan(15_000);
    expect(run.out()).toContain('blueline map: interrupted (SIGTERM); the probe copy was removed.');
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['js-templates.html']);
    expect(sha256(deck)).toBe(before);
    expect(await until(() => run.procs().length === 0, 5000), show(run.procs())).toBe(true);
    expect(fs.readdirSync(run.tmpdir)).toEqual([]);
  } finally {
    reap(run);
  }
});

test('`blueline check` killed outright (SIGKILL): the app notices its command is gone and stops; nothing left running', async () => {
  test.setTimeout(120_000);
  const run = startCli(['check']);
  try {
    expect(await until(() => run.procs().some((p) => p.cmd.includes('--type=renderer')), 60_000), run.out().slice(-3000)).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    process.kill(run.child.pid!, 'SIGKILL');
    await run.exited;
    // The app polls for its command every 0.5 s; the app, its helpers, Xvfb and xvfb-run all go.
    expect(await until(() => run.procs().length === 0, 10_000), show(run.procs())).toBe(true);
  } finally {
    reap(run);
  }
});

test('`blueline open` exits 1 when the app cannot start, with a display and under xvfb-run', async () => {
  test.setTimeout(60_000);
  const dir = tmp('bl-cli-e2e-open-');
  const deck = path.join(dir, 'deck.html');
  fs.copyFileSync(path.join(DECKS, 'single.html'), deck);
  const base = { ...process.env, BLUELINE_ELECTRON: '/etc/hostname' };
  // With a display (any value: the app never gets that far): spawn fails with EACCES.
  const withDisplay = spawnSync(process.execPath, [CLI, 'open', deck], { encoding: 'utf8', env: { ...base, DISPLAY: process.env.DISPLAY ?? ':99' }, timeout: 30_000 });
  expect(withDisplay.status, withDisplay.stderr).toBe(1);
  expect(withDisplay.stderr).toMatch(/could not start the app: .*EACCES/);
  // The bare form is the same command.
  expect(spawnSync(process.execPath, [CLI, deck], { encoding: 'utf8', env: { ...base, DISPLAY: process.env.DISPLAY ?? ':99' }, timeout: 30_000 }).status).toBe(1);
  // Without a display xvfb-run starts, and the app fails inside it.
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const viaXvfb = spawnSync(process.execPath, [CLI, 'open', deck], { encoding: 'utf8', env, timeout: 30_000 });
  expect(viaXvfb.status, viaXvfb.stderr).toBe(1);
  expect(viaXvfb.stderr).toMatch(/the app exited at once/);
});

test('an interrupted `blueline check` keeps the guided results: check.json is saved, and the result says interrupted (129)', async () => {
  test.setTimeout(120_000);
  test.skip(!process.env.DISPLAY, 'needs the display global setup starts');
  const base = tmp('bl-cli-e2e-check-');
  const userData = path.join(base, 'ud');
  const out = path.join(base, 'result.json');
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [...(ROOT_USER ? ['--no-sandbox'] : []), APP_DIR, '--bl-cmd=check', `--bl-out=${out}`],
    env: { ...process.env, BLUELINE_USER_DATA: userData },
    timeout: 60_000,
  });
  const pid = app.process().pid!;
  const exited = new Promise<number | null>((r) => app.process().once('exit', (code) => r(code)));
  try {
    let page = app.windows().find((w) => w.url().startsWith('app://shell/diagnostics.html'));
    for (let i = 0; !page && i < 300; i++) {
      await new Promise((r) => setTimeout(r, 100));
      page = app.windows().find((w) => w.url().startsWith('app://shell/diagnostics.html'));
    }
    if (!page) throw new Error('the diagnostics shell page never loaded');
    const step = page.locator('li[data-step="dictate-body-read"]');
    await step.locator('button[data-result="pass"]').click();
    await expect(step.locator('.badge')).toHaveText('pass');
    // Not saved by hand: the terminal that ran `blueline check` closes (SIGHUP).
    expect(fs.existsSync(path.join(userData, 'check.json'))).toBe(false);
    process.kill(pid, 'SIGHUP');
    expect(await exited).toBe(129);
    const result = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(result).toMatchObject({ command: 'check', exitCode: 129, json: { error: 'interrupted', why: 'SIGHUP' } });
    expect(result.text).toBe(`blueline check: interrupted (SIGHUP); check.json: ${path.join(userData, 'check.json')}`);
    const check = JSON.parse(fs.readFileSync(path.join(userData, 'check.json'), 'utf8'));
    expect(check.steps.find((x: { id: string }) => x.id === 'dictate-body-read').result).toBe('pass');
  } finally {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // exited
    }
  }
});
