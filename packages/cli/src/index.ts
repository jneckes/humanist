// The `blueline` command (6.1), bundled to packages/cli/dist/blueline.cjs and run by the system's Node 22 or
// later. It never runs through npx: the unscoped npm name `blueline` belongs to an unrelated package (9.5).
//
// open, the bare form: start the app with the files (a running app gets them through second-instance, as
// a double-click does) and return at once.
// map, check: run the app standalone with --bl-out, wait for it, print its CommandResult (text, or JSON with
// --json) and exit with the app's exit code.
// pdf, export, mcp, attach: later phases (exit 2).

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CheckArgs, CommandResult, MapArgs, OpenArgs } from '@blueline/core/ipc';
import { USAGE, encodeAppArgs, parseCli } from './args';
import { findApp, planLaunch, type LaunchContext, type LaunchPlan } from './launch';

/** Kept equal to packages/cli/package.json. */
const VERSION = '0.0.0';
const MIN_NODE = 22;
const MAX_CAPTURE = 1024 * 1024;

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

function openFiles(files: string[], prot: boolean): number {
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
  child.on('error', (e) => process.stderr.write(`blueline: could not start the app: ${e.message}\n`));
  child.unref();
  return 0;
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
  const plan = launchPlan([`--bl-cmd=${command}`, `--bl-args=${encodeAppArgs(payload)}`, `--bl-out=${out}`]);
  if (typeof plan === 'string') {
    cleanup();
    return Promise.resolve(fail(plan, 1));
  }
  const debug = process.env.BLUELINE_DEBUG === '1';
  return new Promise<number>((resolve) => {
    const child = spawn(plan.command, plan.args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    // The app's own output (Chromium warnings, logs) goes to stderr, so stdout carries only the result.
    let captured = '';
    const keep = (chunk: Buffer) => {
      if (debug) process.stderr.write(chunk);
      else if (captured.length < MAX_CAPTURE) captured += chunk.toString('utf8');
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    // Ctrl+C reaches the app too (same process group); a signal sent to this process alone is passed on,
    // so `map` can delete its probe copy before it exits.
    const forward = (sig: NodeJS.Signals) => () => {
      if (child.exitCode === null) child.kill(sig);
    };
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    // 'error' (the app could not start) and 'close' may both fire; the first one decides.
    let done = false;
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
      return true;
    };
    child.on('error', (e) => {
      if (!finish()) return;
      cleanup();
      resolve(fail(`could not start the app: ${e.message}`, 1));
    });
    child.on('close', (code, signal) => {
      if (!finish()) return;
      const result = readResult(out, command);
      cleanup();
      const exit = typeof code === 'number' ? code : 1;
      if (!result) {
        if (!debug && captured.trim()) process.stderr.write(captured.slice(-8000));
        resolve(fail(`the app exited without a result (${signal ? `signal ${signal}` : `exit code ${exit}`})`, exit === 0 ? 1 : exit));
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
