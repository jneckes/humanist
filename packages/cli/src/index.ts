// The `blueline` command (6.1), bundled to packages/cli/dist/blueline.cjs and run by the system's Node 22 or
// later. It never runs through npx: the unscoped npm name `blueline` belongs to an unrelated package (9.5).
//
// open, the bare form: start the app with the files (a running app gets them through second-instance, as
// a double-click does) and return once it has started (exit 1 when it could not start).
// map, check: run the app standalone with --bl-out, wait for it, print its CommandResult (text, or JSON with
// --json) and exit with the result's exit code. The app runs in its own process group. SIGINT, SIGTERM and
// SIGHUP sent to the command are passed on to the app's main process (under xvfb-run it is found in that
// group, so xvfb-run still stops Xvfb and cleans up); a run that has not ended 10 s later is killed as a
// group. The app is told the command's pid (--bl-parent), so it stops if the command is killed outright.
// pdf, export, mcp, attach: later phases (exit 2).

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CheckArgs, CommandResult, MapArgs, OpenArgs } from '@blueline/core/ipc';
import { USAGE, encodeAppArgs, parseCli } from './args';
import {
  FORWARDED_SIGNALS,
  FORWARD_KILL_AFTER_MS,
  commandExitCode,
  findApp,
  parseProcStat,
  planLaunch,
  xvfbAppPid,
  type LaunchContext,
  type LaunchPlan,
  type ProcStat,
} from './launch';

/** Kept equal to packages/cli/package.json. */
const VERSION = '0.0.0';
const MIN_NODE = 22;
const MAX_CAPTURE = 1024 * 1024;
/** `open` under xvfb-run: how long to wait for an early failure inside it (xvfb-run itself always starts). */
export const OPEN_GRACE_MS = 1500;

function nodeTooOld(): string | null {
  const major = Number(String(process.versions.node).split('.')[0]);
  if (major >= MIN_NODE) return null;
  return (
    `blueline needs Node.js ${MIN_NODE} or later, and this is Node.js ${process.versions.node}.\n` +
    'Install a current Node.js from https://nodejs.org (or with your package manager, for example\n' +
    '`brew install node` on a Mac), then run blueline again.'
  );
}

function which(cmd: string, env: Record<string, string | undefined>): string | null {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

function context(): LaunchContext {
  return {
    env: process.env,
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    cliDir: __dirname,
    exists: (p) => fs.existsSync(p),
    resolveElectron: (appDir) => {
      try {
        // electron's package main exports the path of its binary when required from Node.
        const r: unknown = createRequire(path.join(appDir, 'package.json'))('electron');
        return typeof r === 'string' ? r : null;
      } catch {
        return null;
      }
    },
    which: (cmd) => which(cmd, process.env),
  };
}

function fail(message: string, code: number): number {
  process.stderr.write(`blueline: ${message}\n`);
  return code;
}

function launchPlan(appArgs: string[]): LaunchPlan | string {
  const ctx = context();
  const app = findApp(ctx);
  if (!app.ok) return app.error;
  const plan = planLaunch(app.value, appArgs, ctx);
  if (!plan.ok) return plan.error;
  for (const w of plan.value.warnings) process.stderr.write(`blueline: ${w}\n`);
  return plan.value;
}

/** An existing regular file, as an absolute path (the app's working directory may differ). */
function existingFile(p: string): string | null {
  const abs = path.resolve(p);
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

async function openFiles(files: string[], prot: boolean): Promise<number> {
  const abs: string[] = [];
  for (const f of files) {
    const a = existingFile(f);
    if (!a) return fail(`no such file: ${f}`, 1);
    abs.push(a);
  }
  const args: OpenArgs = { files: abs, protected: prot };
  const plan = launchPlan(['--bl-cmd=open', `--bl-args=${encodeAppArgs(args)}`]);
  if (typeof plan === 'string') return fail(plan, 1);
  // The app outlives the command, like a double-click; a running app takes the files and the new process exits.
  const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', env: process.env });
  // A launch that fails (EACCES, ENOENT) reports through 'error' after spawn() returns: wait for 'spawn' or
  // 'error', so `blueline open deck.html && …` never treats a failed launch as success.
  const startError = await new Promise<Error | null>((resolve) => {
    child.once('spawn', () => resolve(null));
    child.once('error', (e) => resolve(e));
  });
  if (startError) return fail(`could not start the app: ${startError.message}`, 1);
  child.on('error', () => undefined); // nothing more to report once it has started
  if (plan.viaXvfb) {
    // xvfb-run starts even when the app cannot (a bad executable fails inside it): an exit within the grace
    // period other than 0 (0 is a running app taking the files) is a failed launch.
    const early = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), OPEN_GRACE_MS);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    if (early && early.code !== 0) {
      return fail(`the app exited at once (${early.signal ? `signal ${early.signal}` : `exit code ${early.code}`}); run it with a display to see why`, 1);
    }
  }
  child.unref();
  return 0;
}

/** The processes of group `pgid` (Linux: /proc). */
function groupMembers(pgid: number): ProcStat[] {
  const out: ProcStat[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return out;
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const st = parseProcStat(fs.readFileSync(`/proc/${n}/stat`, 'utf8'));
      if (st && st.pgrp === pgid) out.push(st);
    } catch {
      // gone, or not ours to read
    }
  }
  return out;
}

function readResult(file: string, command: 'map' | 'check'): CommandResult | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CommandResult>;
    if (r && r.command === command && typeof r.exitCode === 'number' && typeof r.text === 'string') return r as CommandResult;
  } catch {
    // missing or unreadable
  }
  return null;
}

/** Runs the app for map or check, waits, prints the result. */
function runAndReport(command: 'map' | 'check', payload: MapArgs | CheckArgs, json: boolean): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueline-cli-'));
  const out = path.join(dir, 'result.json');
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const plan = launchPlan([`--bl-cmd=${command}`, `--bl-args=${encodeAppArgs(payload)}`, `--bl-out=${out}`, `--bl-parent=${process.pid}`]);
  if (typeof plan === 'string') {
    cleanup();
    return Promise.resolve(fail(plan, 1));
  }
  const debug = process.env.BLUELINE_DEBUG === '1';
  return new Promise<number>((resolve) => {
    // Its own process group (POSIX): a terminal's Ctrl+C or a hang-up reaches only this command, which passes
    // it on below to the app, as it does a SIGTERM sent to this command alone (a CI timeout, a parent's
    // child.kill()). `map` then deletes its probe copy before it exits (section 10, Mutation probe step 1),
    // `check` saves check.json, and xvfb-run, Xvfb and Electron all stop.
    const child = spawn(plan.command, plan.args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: plan.ownGroup });
    // The app's own output (Chromium warnings, logs) goes to stderr, so stdout carries only the result.
    let captured = '';
    const keep = (chunk: Buffer) => {
      if (debug) process.stderr.write(chunk);
      else if (captured.length < MAX_CAPTURE) captured += chunk.toString('utf8');
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let received: NodeJS.Signals | null = null;
    const forwarders = new Map<NodeJS.Signals, () => void>();
    const unforward = () => {
      for (const [sig, h] of forwarders) process.removeListener(sig, h);
      forwarders.clear();
    };
    const kill = (pid: number, sig: NodeJS.Signals | 'SIGKILL') => {
      try {
        process.kill(pid, sig);
      } catch {
        // gone
      }
    };
    const send = (sig: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid === undefined) return; // not started yet: sent on 'spawn'
      if (!plan.ownGroup || !plan.viaXvfb) {
        // The child is the app's main process; it stops its helpers itself.
        child.kill(sig);
        return;
      }
      const app = process.platform === 'linux' ? xvfbAppPid(groupMembers(pid), pid, plan.executable) : null;
      // Before the app has started, xvfb-run is still starting Xvfb: the whole group stops.
      kill(app ?? -pid, sig);
    };
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    for (const sig of FORWARDED_SIGNALS) {
      const h = () => {
        received ??= sig;
        send(sig);
        // A run that does not end on its own (map stops within about 3 s) is killed with its whole group.
        killTimer ??= setTimeout(() => {
          if (plan.ownGroup && child.pid !== undefined) kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        }, FORWARD_KILL_AFTER_MS);
      };
      forwarders.set(sig, h);
      process.on(sig, h);
    }
    child.once('spawn', () => {
      if (received) send(received);
    });
    // Once the direct child (xvfb-run, or Electron) has exited, the app has had every signal it needs; a
    // later signal ends this command the default way instead of being swallowed while the run winds down.
    child.once('exit', unforward);
    // 'error' (the app could not start) and 'close' may both fire; the first one decides.
    let done = false;
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      unforward();
      if (killTimer) clearTimeout(killTimer);
      return true;
    };
    child.on('error', (e) => {
      if (!finish()) return;
      cleanup();
      resolve(fail(`could not start the app: ${e.message}`, 1));
    });
    child.on('close', (code, signal) => {
      if (!finish()) return;
      // Whatever of the run is still in its group (an Xvfb whose xvfb-run was killed) is an orphan now.
      if (plan.ownGroup && child.pid !== undefined) kill(-child.pid, 'SIGTERM');
      const result = readResult(out, command);
      cleanup();
      const exit = commandExitCode({ resultExitCode: result ? result.exitCode : null, received, code, signal });
      if (!result) {
        if (!debug && captured.trim()) process.stderr.write(captured.slice(-8000));
        const why = received ? `after ${received}` : signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
        resolve(fail(`the app exited without a result (${why})`, exit));
        return;
      }
      process.stdout.write(json ? `${JSON.stringify(result.json, null, 2)}\n` : `${result.text.replace(/\n?$/, '\n')}`);
      resolve(exit);
    });
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const old = nodeTooOld();
  if (old) {
    process.stderr.write(`${old}\n`);
    return 1;
  }
  const cmd = parseCli(argv);
  switch (cmd.kind) {
    case 'help':
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case 'version':
      process.stdout.write(`blueline ${VERSION}\n`);
      return 0;
    case 'usage':
      process.stderr.write(`blueline: ${cmd.message}\n\n${USAGE}\n`);
      return 2;
    case 'later':
      process.stderr.write(`blueline ${cmd.name} arrives in Phase ${cmd.phase}.\n`);
      return 2;
    case 'open':
      return openFiles(cmd.files, cmd.protected);
    case 'map': {
      const deck = existingFile(cmd.deck);
      if (!deck) return fail(`no such file: ${cmd.deck}`, 1);
      const args: MapArgs = { deck, report: cmd.report, json: cmd.json, minCoverage: cmd.minCoverage };
      return runAndReport('map', args, cmd.json);
    }
    case 'check': {
      const args: CheckArgs = { auto: cmd.auto };
      return runAndReport('check', args, cmd.json);
    }
  }
}

// Bundled entry point (dist/blueline.cjs). Not run when a test imports the module.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`blueline: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
