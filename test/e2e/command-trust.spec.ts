// `blueline pdf` and `blueline map` decide trust as the app decides an open (6.1: they hand the file over "as a
// double-click does"; 6.10 When it applies, Settings › Trust; 9.9 the strict option blocks the allowlist too, the
// allowlist is user-editable, the map probe copy loads under the original's trust state; command-trust.ts).
// Review findings 1 and 4: the commands used to ignore the untrusted folders, the strict option and an edited
// allowlist, so a deck in a folder the user marked untrusted rendered Trusted, with full network.
//
// The real command, node packages/cli/dist/blueline.cjs, runs as a user would run it: no proxy variables, the
// user's settings in config.json, either through BLUELINE_USER_DATA (the tests' switch) or where the app keeps
// them on Linux (XDG_CONFIG_HOME/Blueline, no BLUELINE_USER_DATA). Each deck asks a 127.0.0.1 sink for an image and
// a fetch, and loads from CDN hosts that a BLUELINE_ELECTRON wrapper maps to the same sink with
// --host-resolver-rules (an allowlisted GET reaches it only when the policy lets it through). The command runs as
// root with --no-sandbox here (the CLI adds it for root), as the other E2E tests of the command do; the app
// launches (for the decision the app itself would make) run as the suite runs them.

import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { ELECTRON_BIN, FIXTURES, ROOT, Scratch, launchApp, resolveRunAs, sleep } from '../helpers/app';
import { removeTrustableFolders, trustableFolder } from './trust-native-harness';

const CLI = path.join(ROOT, 'packages/cli/dist/blueline.cjs');
const UNTRUSTED = 'In a folder you marked as untrusted';
const QUARANTINE = '0083;65f1c2a3;Safari;6E1F6E7C-1C1B-4B8E-9D2E-444444444444';

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => {
  scratch.cleanup();
  removeTrustableFolders();
});

interface Sink {
  port: number;
  hits: string[];
  close(): Promise<void>;
}

/** Records every request (`<Host header> <path>`), whatever host the page asked for. */
async function sink(): Promise<Sink> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.headers.host ?? '?'} ${req.url ?? '?'}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end('ok');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return { port, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let net: Sink;
let wrapper: string;
test.beforeAll(async () => {
  net = await sink();
  // The real Electron, with the CDN hosts resolved to the sink (port included), for every command run below.
  wrapper = path.join(scratch.dir('cmd-wrap'), 'electron.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${ELECTRON_BIN}' '--host-resolver-rules=MAP cdn.jsdelivr.net 127.0.0.1:${net.port}, MAP cdn.example.org 127.0.0.1:${net.port}' "$@"\n`, { mode: 0o755 });
});
test.afterAll(async () => {
  await net?.close();
});

/** A deck that asks the sink directly (image, fetch) and through the CDN hosts (stylesheet, images). */
function deckHtml(tag: string): string {
  const p = net.port;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Command trust ${tag}</title>
<link rel="stylesheet" href="http://cdn.jsdelivr.net/${tag}-cdn.css"></head>
<body><h1>Command trust ${tag}</h1><p>One page.</p>
<img src="http://127.0.0.1:${p}/${tag}-img.gif" alt="">
<img src="http://cdn.jsdelivr.net/${tag}-cdn.png" alt="">
<img src="http://cdn.example.org/${tag}-custom.png" alt="">
<script>fetch('http://127.0.0.1:${p}/${tag}-fetch').catch(function () {});</script>
</body></html>`;
}

function writeDeck(dir: string, name: string, tag: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, deckHtml(tag));
  scratch.own(file);
  return fs.realpathSync.native(file);
}

/** A userData folder holding config.json (owned by the app's user, so the app could use it too). */
function userDataWith(config: Record<string, unknown>): string {
  const ud = path.join(scratch.dir('cmd-ud'), 'userData');
  fs.mkdirSync(ud, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ seen: { welcome: true }, ...config }));
  scratch.own(path.dirname(ud));
  return ud;
}

/** XDG_CONFIG_HOME with Blueline/config.json: the app's own userData on Linux, found without BLUELINE_USER_DATA. */
function xdgWith(config: Record<string, unknown>): string {
  const x = scratch.dir('cmd-xdg');
  fs.mkdirSync(path.join(x, 'Blueline'), { recursive: true });
  fs.writeFileSync(path.join(x, 'Blueline', 'config.json'), JSON.stringify({ seen: { welcome: true }, ...config }));
  return x;
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The command as a user runs it: the environment without proxy variables, BLUELINE_* or BL_* (each test adds
 * what it sets), a home of its own, BLUELINE_DEBUG=1 so the app's log line (trust state and rule) reaches stderr,
 * and the wrapper as BLUELINE_ELECTRON. Async, so the sink in this process answers while the command runs.
 */
function blueline(args: string[], env: Record<string, string>): Promise<CliRun> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(https?_proxy|all_proxy|no_proxy|BLUELINE_|BL_|XDG_CONFIG_HOME$)/i.test(k)) continue;
    base[k] = v;
  }
  const home = scratch.dir('cmd-home');
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...base, HOME: home, BLUELINE_DEBUG: '1', BLUELINE_ELECTRON: wrapper, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

/** The hits the sink saw while `run` ran (a request made during a render is in by the time the command exits). */
async function hitsDuring<T>(run: () => Promise<T>): Promise<{ r: T; hits: string[] }> {
  net.hits.length = 0;
  const r = await run();
  await sleep(300);
  return { r, hits: [...net.hits] };
}

function snapshot(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** The trust state `blueline map --json` reports (its MapReport, report.ts). */
function mapTrust(run: CliRun): string | undefined {
  const j = JSON.parse(run.stdout) as { report?: { trust?: string } };
  return j.report?.trust;
}

test("blueline pdf and blueline map: an unmarked deck in an untrusted folder renders Protected, with strict on: no request leaves (the app's userData via BLUELINE_USER_DATA and via XDG_CONFIG_HOME)", async () => {
  const dir = fs.realpathSync.native(scratch.dir('cmd-untrusted'));
  const deck = writeDeck(dir, 'from-client.html', 'untr');
  const config = { untrustedFolders: [dir], strictProtected: true };
  const ud = userDataWith(config);
  const x = xdgWith(config);
  const cases: { label: string; env: Record<string, string>; configFile: string }[] = [
    { label: 'BLUELINE_USER_DATA', env: { BLUELINE_USER_DATA: ud }, configFile: path.join(ud, 'config.json') },
    { label: 'XDG_CONFIG_HOME', env: { XDG_CONFIG_HOME: x }, configFile: path.join(x, 'Blueline', 'config.json') },
  ];
  for (const c of cases) {
    const configBefore = snapshot(c.configFile);
    const out = path.join(scratch.dir('cmd-out'), 'out.pdf');
    const pdf = await hitsDuring(() => blueline(['pdf', deck, '-o', out], c.env));
    expect(pdf.r.code, `${c.label}: ${pdf.r.stderr.slice(-3000)}`).toBe(0);
    expect(pdf.hits, `${c.label}: blueline pdf let these requests through`).toEqual([]);
    expect(pdf.r.stderr, c.label).toContain(`[blueline pdf] from-client.html: protected (${UNTRUSTED}; rule untrusted-folder)`);
    expect(fs.existsSync(out)).toBe(true);

    const map = await hitsDuring(() => blueline(['map', deck, '--report', '--json'], c.env));
    expect(map.r.code, `${c.label}: ${map.r.stderr.slice(-3000)}`).not.toBeNull();
    expect(map.hits, `${c.label}: blueline map let these requests through`).toEqual([]);
    expect(mapTrust(map.r), c.label).toBe('protected');
    expect(map.r.stderr, c.label).toContain(`[blueline map] from-client.html: UTF-8, protected (${UNTRUSTED}; rule untrusted-folder)`);

    // config.json is read, never written; trust.json is never created.
    expect(snapshot(c.configFile), c.label).toBe(configBefore);
    expect(fs.existsSync(path.join(path.dirname(c.configFile), 'trust.json')), c.label).toBe(false);
  }
});

test('blueline pdf --protected with "Block all network in Protected view": no allowlisted CDN GET; without it, the CDN GET goes through (the control)', async () => {
  const deck = writeDeck(fs.realpathSync.native(scratch.dir('cmd-strict')), 'strict.html', 'strict');
  const strict = await hitsDuring(() => blueline(['pdf', '--protected', deck, '-o', path.join(scratch.dir('cmd-out'), 's.pdf')], { BLUELINE_USER_DATA: userDataWith({ strictProtected: true }) }));
  expect(strict.r.code, strict.r.stderr.slice(-3000)).toBe(0);
  expect(strict.hits, 'strict: nothing reaches the sink, not even the allowlisted CDN').toEqual([]);
  expect(strict.r.stderr).toContain('[blueline pdf] strict.html: protected (Opened at your request; rule requested)');

  const open = await hitsDuring(() => blueline(['pdf', '--protected', deck, '-o', path.join(scratch.dir('cmd-out'), 'o.pdf')], { BLUELINE_USER_DATA: userDataWith({ strictProtected: false }) }));
  expect(open.r.code, open.r.stderr.slice(-3000)).toBe(0);
  // The host mapping works: the allowlisted CDN (9.9 default list) is fetched; the sink itself and the host
  // outside the list are not (Protected).
  expect(open.hits.filter((h) => h.startsWith('cdn.jsdelivr.net ')).sort()).toEqual(expect.arrayContaining(['cdn.jsdelivr.net /strict-cdn.css', 'cdn.jsdelivr.net /strict-cdn.png']));
  expect(open.hits.filter((h) => !h.startsWith('cdn.jsdelivr.net '))).toEqual([]);
});

test('blueline pdf --protected with an edited allowlist: a host the user removed is not fetched, a host the user added is', async () => {
  const deck = writeDeck(fs.realpathSync.native(scratch.dir('cmd-allow')), 'allow.html', 'allow');
  const run = await hitsDuring(() => blueline(['pdf', '--protected', deck, '-o', path.join(scratch.dir('cmd-out'), 'a.pdf')], { BLUELINE_USER_DATA: userDataWith({ cdnAllowlist: ['cdn.example.org'] }) }));
  expect(run.r.code, run.r.stderr.slice(-3000)).toBe(0);
  expect(run.hits.some((h) => h.startsWith('cdn.jsdelivr.net ')), `removed from the allowlist, still fetched: ${JSON.stringify(run.hits)}`).toBe(false);
  expect(run.hits).toContain('cdn.example.org /allow-custom.png');
  expect(run.hits.some((h) => h.startsWith('127.0.0.1')), 'the sink itself is never allowlisted').toBe(false);
});

test('a decision trust.json remembers (Allow network, made in the app) never applies to blueline pdf, and the command leaves trust.json as it was', async () => {
  const dir = fs.realpathSync.native(scratch.dir('cmd-remembered'));
  const deck = writeDeck(dir, 'remembered.html', 'mem');
  const ud = userDataWith({ untrustedFolders: [dir] });
  const trustFile = path.join(ud, 'trust.json');
  let app = await launchApp({ files: [deck], scratch, userData: ud });
  try {
    const d = await app.waitForDeck('remembered.html');
    expect(await app.win(d.docId)).toMatchObject({ trust: 'protected', trustReason: UNTRUSTED, networkAllowed: false });
    await (await app.shellPage(d.docId)).locator('#allow-network').click();
    await expect.poll(() => JSON.parse(snapshot(trustFile) ?? '{"files":{}}').files[deck]?.allowNetwork ?? false).toBe(true);
  } finally {
    await app.close();
  }
  // The control: the app applies the remembered decision at the next open.
  app = await launchApp({ files: [deck], scratch, userData: ud });
  try {
    const d = await app.waitForDeck('remembered.html');
    expect(await app.win(d.docId)).toMatchObject({ trust: 'protected', networkAllowed: true });
  } finally {
    await app.close();
  }
  const before = snapshot(trustFile);
  const mtime = fs.statSync(trustFile).mtimeMs;
  const run = await hitsDuring(() => blueline(['pdf', deck, '-o', path.join(scratch.dir('cmd-out'), 'm.pdf')], { BLUELINE_USER_DATA: ud }));
  expect(run.r.code, run.r.stderr.slice(-3000)).toBe(0);
  // Protected view without network: only the allowlisted CDN (strict is off here). With the remembered Allow
  // network, the deck's own requests to the sink and to the host outside the allowlist would have gone through.
  expect(run.hits.filter((h) => !h.startsWith('cdn.jsdelivr.net ')), 'the remembered Allow network must not apply to the command').toEqual([]);
  expect(run.r.stderr).toContain(`[blueline pdf] remembered.html: protected (${UNTRUSTED}; rule untrusted-folder)`);
  expect(snapshot(trustFile)).toBe(before);
  expect(fs.statSync(trustFile).mtimeMs).toBe(mtime);
});

test('the control: a trusted folder still renders a marked deck Trusted (and the same marked deck elsewhere Protected)', async () => {
  const trusted = trustableFolder('cmd-trusted', (p) => scratch.own(p));
  const inTrusted = writeDeck(trusted, 'marked.html', 'trusted');
  const elsewhere = writeDeck(fs.realpathSync.native(scratch.dir('cmd-elsewhere')), 'marked.html', 'elsewhere');
  // The test-only marker switch (markers.ts): both files "came from the internet".
  const markers = path.join(scratch.dir('cmd-markers'), 'markers.json');
  fs.writeFileSync(markers, JSON.stringify({ [inTrusted]: QUARANTINE, [elsewhere]: QUARANTINE }));
  const env = { BLUELINE_USER_DATA: userDataWith({ trustedFolders: [trusted] }), BLUELINE_TEST: '1', BLUELINE_TEST_MARKERS: markers };
  const t = await hitsDuring(() => blueline(['pdf', inTrusted, '-o', path.join(scratch.dir('cmd-out'), 't.pdf')], env));
  expect(t.r.code, t.r.stderr.slice(-3000)).toBe(0);
  expect(t.hits).toEqual(expect.arrayContaining([`127.0.0.1:${net.port} /trusted-fetch`, `127.0.0.1:${net.port} /trusted-img.gif`]));
  expect(t.r.stderr).toContain('[blueline pdf] marked.html: trusted (rule trusted-folder)');
  const p = await hitsDuring(() => blueline(['pdf', elsewhere, '-o', path.join(scratch.dir('cmd-out'), 'p.pdf')], env));
  expect(p.r.code, p.r.stderr.slice(-3000)).toBe(0);
  expect(p.r.stderr).toContain('[blueline pdf] marked.html: protected (Came from the internet; rule marker)');
  expect(p.hits.filter((h) => h.startsWith('127.0.0.1'))).toEqual([]);
});

test("the userData a command reads its settings from is the app's own: a normal launch's userData is <appData>/Blueline (XDG_CONFIG_HOME/Blueline here)", async () => {
  const x = scratch.dir('cmd-xdg-app');
  fs.mkdirSync(path.join(x, 'Blueline'), { recursive: true });
  fs.writeFileSync(path.join(x, 'Blueline', 'config.json'), JSON.stringify({ seen: { welcome: true } }));
  scratch.own(x);
  const file = path.join(scratch.dir('cmd-xdg-deck'), 'single.html');
  fs.copyFileSync(path.join(FIXTURES, 'decks', 'single.html'), file);
  scratch.own(file);
  // No BLUELINE_USER_DATA: the app keeps Electron's default userData.
  const app = await launchApp({ files: [file], scratch, env: { BLUELINE_USER_DATA: '', XDG_CONFIG_HOME: x } });
  try {
    await app.waitForDeck('single.html');
    const p = await app.electronApp.evaluate(({ app: a }) => ({ userData: a.getPath('userData'), appData: a.getPath('appData'), name: a.name }));
    expect(p.userData).toBe(path.join(x, 'Blueline'));
    // What command-trust.ts realUserData() computes in a command run, where index.ts moved userData elsewhere.
    expect(path.join(p.appData, p.name)).toBe(p.userData);
  } finally {
    await app.close();
  }
});
