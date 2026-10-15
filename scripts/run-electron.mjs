#!/usr/bin/env node
// Starts the built app in development: `node scripts/run-electron.mjs [app args…]`.
// On Linux with no DISPLAY it runs under xvfb-run with a large screen, because an offscreen
// BrowserWindow is clamped to the X screen size (Phase 0 finding, docs/PHASE0-FINDINGS.md).
// Running as root needs --no-sandbox for Chromium; that is a dev-container convenience only.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/app/package.json'));
const electron = require('electron'); // path to the binary when required from Node
const appDir = join(root, 'packages/app');
const extra = process.argv.slice(2);

const args = [appDir, ...extra];
if (process.platform === 'linux' && process.getuid && process.getuid() === 0) {
  console.warn('[run-electron] running as root: adding --no-sandbox (OS sandbox off; dev only)');
  args.unshift('--no-sandbox');
}

let cmd = electron;
let cmdArgs = args;
if (process.platform === 'linux' && !process.env.DISPLAY) {
  cmd = 'xvfb-run';
  cmdArgs = ['-a', '-s', '-screen 0 3840x2160x24', electron, ...args];
}
const child = spawn(cmd, cmdArgs, { stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
