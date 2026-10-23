#!/usr/bin/env node
// Packaged-build smoke test (SPEC 9.10 Packaging; 9.1 Shell view; section 10 Diagnostics window).
//
// Dev runs serve dist/ as plain files, so they never see what a packaged build does with app.asar: the
// confined protocol handlers refuse every file inside the archive, which left the shell blank (no toolbar,
// no trust bar) and the Diagnostics deck without reveal.js. This script packs the current build with the
// repo's electron-builder config (unpacked dir target, the local Electron, so nothing is downloaded) into a
// scratch folder, then:
//   1. checks the layout: dist/shell and dist/assets in app.asar.unpacked, the CLI and its shims in
//      resources/cli, the sample deck and the Settings and welcome pages (Phase 1); and what ships (supply chain,
//      docs/DEPENDENCIES.md): app.asar holds no node_modules (only package.json and dist/, read with
//      @electron/asar), resources/cli holds only the bundled files, the shims and their licence notices;
//   2. runs the packaged `blueline check --auto` through the packaged CLI (exit 0: every automatic check passed),
//      and the packaged `blueline pdf` on a fixture (one page per slide);
//   3. launches the packaged app with Playwright on a fixture deck with --protected and asserts the shell
//      (app://shell/index.html) loads with its toolbar and the Protected-view trust bar.
//
// It is a test build (BLUELINE_TEST_BUILD=1 keeps the inspect fuse on, so Playwright can attach). Run it
// after `npm run build`: `node scripts/package-smoke.mjs [--out <dir>] [--keep]`. On Linux without a display
// it re-runs itself under xvfb-run. Exit 0 when every step passed.

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asarContents } from './asar-contents.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const outArg = argv.indexOf('--out') >= 0 ? argv[argv.indexOf('--out') + 1] : null;

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.BL_SMOKE_UNDER_XVFB) {
  const r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 3840x2160x24', process.execPath, fileURLToPath(import.meta.url), ...argv], {
    stdio: 'inherit',
    env: { ...process.env, BL_SMOKE_UNDER_XVFB: '1' },
  });
  process.exit(r.status ?? 1);
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const out = outArg ? path.resolve(outArg) : fs.mkdtempSync(path.join(os.tmpdir(), 'blueline-package-smoke-'));
const failures = [];
const step = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// ------------------------------------------------------------------------------------------- pack

const base = require('./packages/app/electron-builder.config.cjs');
// The local Electron (npm run install:electron); exits with that instruction when it is missing.
require('./scripts/electron-binary.cjs').electronBinaryOrExit();
const electronDir = path.join(path.dirname(require.resolve('electron/package.json')));
const { build, Platform } = require('electron-builder');
process.env.BLUELINE_TEST_BUILD = '1';
await build({
  targets: Platform.current().createTarget('dir'),
  config: {
    ...base,
    directories: { ...base.directories, output: out },
    electronDist: path.join(electronDir, 'dist'),
    electronVersion: require('electron/package.json').version,
  },
});

function layout() {
  if (process.platform === 'darwin') {
    const dir = fs.readdirSync(out).find((d) => d.startsWith('mac'));
    const app = path.join(out, dir, 'Blueline.app');
    return { exe: path.join(app, 'Contents', 'MacOS', 'Blueline'), resources: path.join(app, 'Contents', 'Resources') };
  }
  if (process.platform === 'win32') {
    const dir = path.join(out, 'win-unpacked');
    return { exe: path.join(dir, 'Blueline.exe'), resources: path.join(dir, 'resources') };
  }
  const dir = path.join(out, 'linux-unpacked');
  return { exe: path.join(dir, 'blueline'), resources: path.join(dir, 'resources') };
}
const { exe, resources } = layout();

// ------------------------------------------------------------------------------------------- 1. layout

const unpacked = path.join(resources, 'app.asar.unpacked', 'dist');
step('app.asar exists', fs.existsSync(path.join(resources, 'app.asar')));
step('dist/shell is unpacked', fs.existsSync(path.join(unpacked, 'shell', 'index.html')));
step('dist/assets is unpacked', fs.existsSync(path.join(unpacked, 'assets', 'diagnostics-deck', 'index.html')));
step('dist/assets/build is not shipped', !fs.existsSync(path.join(unpacked, 'assets', 'build')));
step('the CLI ships in resources/cli', fs.existsSync(path.join(resources, 'cli', 'blueline.cjs')));
// Phase 1: the shims Help › Install Command Line Tool links to (6.1), the sample deck (6.0 First run), and the
// Settings and welcome shell pages (9.1 Shell view), all outside the archive.
const shim = path.join(resources, 'cli', 'blueline');
step('the shims ship next to it (blueline, blueline.cmd)', fs.existsSync(shim) && fs.existsSync(path.join(resources, 'cli', 'blueline.cmd')));
if (process.platform !== 'win32') step('the POSIX shim is executable', fs.existsSync(shim) && (fs.statSync(shim).mode & 0o111) !== 0);
step('the sample deck is unpacked', fs.existsSync(path.join(unpacked, 'assets', 'sample', 'blueline-tour.html')));
step('the Settings and welcome pages are unpacked', ['settings.html', 'settings.js', 'welcome.html', 'welcome.js'].every((f) => fs.existsSync(path.join(unpacked, 'shell', f))));
step('the executable exists', fs.existsSync(exe), exe);

// What ships (supply chain): the bundles carry all third-party code, so the archive holds no node_modules and
// the command's folder holds only what the build made for it (electron-builder.config.cjs files, extraResources).
let asarEntries = [];
let nodeModules = [];
let strays = [];
try {
  ({ entries: asarEntries, nodeModules, strays } = asarContents(path.join(resources, 'app.asar')));
} catch (e) {
  step('app.asar can be listed (@electron/asar)', false, e instanceof Error ? e.message : String(e));
}
step('app.asar holds no node_modules', asarEntries.length > 0 && nodeModules.length === 0, nodeModules.length ? `${nodeModules.length} entries, e.g. ${nodeModules.slice(0, 3).join(', ')}` : `${asarEntries.length} entries`);
step('app.asar holds only package.json and dist/', asarEntries.length > 0 && strays.length === 0, strays.slice(0, 5).join(', '));
step('app.asar ships the bundles\' licence notices', asarEntries.includes('/dist/THIRD-PARTY-NOTICES.txt'));
const cliBuilt = new Set(['blueline.cjs', 'blueline-editor.cjs', 'blueline', 'blueline.cmd', 'THIRD-PARTY-NOTICES.txt'].filter((f) => fs.existsSync(path.join(root, 'packages', 'cli', 'dist', f))));
const cliShipped = fs.existsSync(path.join(resources, 'cli')) ? fs.readdirSync(path.join(resources, 'cli')).sort() : [];
step(
  'resources/cli holds only the bundled files, the shims and their notices',
  cliShipped.join(' ') === [...cliBuilt].sort().join(' ') && ['blueline.cjs', 'blueline', 'blueline.cmd', 'THIRD-PARTY-NOTICES.txt'].every((f) => cliShipped.includes(f)),
  cliShipped.join(', '),
);

// ------------------------------------------------------------------------------------------- 2. check --auto

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'blueline-smoke-ud-'));
const env = { ...process.env, BLUELINE_USER_DATA: ud };
delete env.BLUELINE_ELECTRON;
delete env.BLUELINE_APP_DIR;
delete env.BLUELINE_TEST_BUILD;
const check = await new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(resources, 'cli', 'blueline.cjs'), 'check', '--auto'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  c.stdout.on('data', (b) => (text += b));
  c.stderr.on('data', (b) => (text += b));
  const timer = setTimeout(() => c.kill('SIGTERM'), 180_000);
  c.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code, text });
  });
});
step('packaged `blueline check --auto` passes', check.code === 0, check.code === 0 ? '' : `exit ${check.code}\n${check.text.slice(-3000)}`);

// Phase 1: `blueline pdf` through the packaged CLI (6.9 Save as PDF; pdf-lib is loaded from app.asar on first use).
const pdfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueline-smoke-pdf-'));
fs.copyFileSync(path.join(root, 'fixtures', 'decks', 'generic-index.html'), path.join(pdfDir, 'deck.html'));
const pdf = await new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(resources, 'cli', 'blueline.cjs'), 'pdf', path.join(pdfDir, 'deck.html'), '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  c.stdout.on('data', (b) => (text += b));
  c.stderr.on('data', (b) => (text += b));
  const timer = setTimeout(() => c.kill('SIGTERM'), 180_000);
  c.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code, text });
  });
});
const pdfFile = path.join(pdfDir, 'deck.pdf');
const pdfOk = pdf.code === 0 && fs.existsSync(pdfFile) && fs.readFileSync(pdfFile).subarray(0, 5).toString('latin1') === '%PDF-' && /"pages":\s*6\b/.test(pdf.text);
step('packaged `blueline pdf` writes one page per slide', pdfOk, pdfOk ? '' : `exit ${pdf.code}\n${pdf.text.slice(-2000)}`);
if (!keep) fs.rmSync(pdfDir, { recursive: true, force: true });

// ------------------------------------------------------------------------------------------- 3. the shell

const { _electron } = require('@playwright/test');
const deckDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueline-smoke-deck-'));
const deck = path.join(deckDir, 'generic-index.html');
fs.copyFileSync(path.join(root, 'fixtures', 'decks', 'generic-index.html'), deck);
let app = null;
try {
  app = await _electron.launch({
    executablePath: exe,
    args: [...(isRoot ? ['--no-sandbox'] : []), deck, '--protected'],
    env: { ...env, BLUELINE_TEST: '1' },
    timeout: 60_000,
  });
  const deadline = Date.now() + 30_000;
  let shell = null;
  while (!shell && Date.now() < deadline) {
    shell = app.windows().find((p) => p.url().startsWith('app://shell/index.html')) ?? null;
    if (!shell) await new Promise((r) => setTimeout(r, 200));
  }
  step('the shell window opened', shell !== null);
  if (shell) {
    const ok = async (sel) => {
      try {
        await shell.locator(sel).waitFor({ state: 'visible', timeout: 15_000 });
        return true;
      } catch {
        return false;
      }
    };
    step('the shell shows its toolbar', await ok('#toolbar'));
    step('the shell shows the Protected-view trust bar', await ok('#trust-bar'));
    const text = (await shell.locator('#trust-text').textContent().catch(() => '')) ?? '';
    step('the trust bar says Protected view', /Protected view/.test(text), text.trim());
  }
  const status = await app.evaluate(async ({ session }) => {
    const ses = session.fromPartition('shell');
    const r = await Promise.all(['index.html', 'shell.js', 'shell.css'].map((f) => ses.fetch(`app://shell/${f}`).then((x) => x.status, () => 0)));
    return r;
  });
  step('app://shell/{index.html,shell.js,shell.css} load', status.every((s) => s === 200), status.join(', '));
} catch (e) {
  step('the packaged app launched', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
} finally {
  await app?.close().catch(() => undefined);
  fs.rmSync(deckDir, { recursive: true, force: true });
  fs.rmSync(ud, { recursive: true, force: true });
  if (!keep && !outArg) fs.rmSync(out, { recursive: true, force: true });
}

console.log(failures.length === 0 ? 'package smoke: all passed' : `package smoke: ${failures.length} failed (${failures.join('; ')})`);
process.exit(failures.length === 0 ? 0 : 1);
