// The `blueline` shim (6.1: "a small script run by the system's Node 22 or later … If Node is missing, the shim
// says how to get it"): packages/cli/src/shim/blueline, run by /bin/sh (dash here) and bash, with fake `node`
// binaries that print their version, in a temp HOME. It finds Node 22+ on PATH, then in Homebrew's folders,
// nvm, Volta and fnm, follows the installed link back to blueline.cjs, and passes arguments and the exit code
// through. The Windows blueline.cmd cannot run here; its text is checked for the same order and CRLF in the build.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const SHIM = path.join(ROOT, 'packages/cli/src/shim/blueline');
const CMD = path.join(ROOT, 'packages/cli/src/shim/blueline.cmd');
const posix = process.platform !== 'win32';

let dir: string;
let cli: string;
let shim: string;

/** A fake node: prints its version for --version, else what it was asked to run (and exits FAKE_EXIT). */
function fakeNode(file: string, version: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; exit 0; fi\nprintf 'ran %s' "$0"\nfor a in "$@"; do printf ' [%s]' "$a"; done\necho\nexit \${FAKE_EXIT:-0}\n`, { mode: 0o755 });
  return file;
}

function home(name: string): string {
  const h = path.join(dir, 'homes', name);
  fs.mkdirSync(h, { recursive: true });
  return h;
}

function run(o: { home: string; path?: string; env?: Record<string, string>; shell?: string; via?: string; args?: string[] }) {
  const env: Record<string, string> = { HOME: o.home, PATH: o.path ?? '/usr/bin:/bin', ...(o.env ?? {}) };
  const file = o.via ?? shim;
  const r = o.shell ? spawnSync(o.shell, [file, ...(o.args ?? [])], { env, encoding: 'utf8' }) : spawnSync(file, o.args ?? [], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-shim-')));
  cli = path.join(dir, 'App', 'Resources', 'cli');
  fs.mkdirSync(cli, { recursive: true });
  shim = path.join(cli, 'blueline');
  fs.copyFileSync(SHIM, shim);
  fs.chmodSync(shim, 0o755);
  fs.writeFileSync(path.join(cli, 'blueline.cjs'), '// stand-in\n');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const main = () => path.join(cli, 'blueline.cjs');
// This machine has a real Node 22 at /usr/local/bin/node (a Homebrew-on-Intel location the shim checks), so tests
// that must not find one keep it out of reach: they run where that folder is hidden (hiddenUsrLocal below).

describe.skipIf(!posix)('the POSIX shim', () => {
  it('runs blueline.cjs with the Node 22+ on PATH, passing every argument as it was', () => {
    const bin = path.join(dir, 'bin-22');
    fakeNode(path.join(bin, 'node'), '22.11.0');
    for (const shell of [undefined, '/bin/sh', '/bin/bash']) {
      if (shell && !fs.existsSync(shell)) continue;
      const r = run({ home: home('path22'), path: `${bin}:/usr/bin:/bin`, shell, args: ['pdf', 'Q4 plan.html', '-o', "it's $HOME.pdf", ''] });
      expect(r.code).toBe(0);
      expect(r.out).toBe(`ran ${path.join(bin, 'node')} [${main()}] [pdf] [Q4 plan.html] [-o] [it's $HOME.pdf] []`);
    }
  });

  it('passes the exit code through', () => {
    const bin = path.join(dir, 'bin-exit');
    fakeNode(path.join(bin, 'node'), '24.0.0');
    const r = run({ home: home('exit'), path: `${bin}:/usr/bin:/bin`, env: { FAKE_EXIT: '7' } });
    expect(r.code).toBe(7);
  });

  it('follows the installed link (absolute and relative, through two hops) back to blueline.cjs', () => {
    const bin = path.join(dir, 'bin-link');
    fakeNode(path.join(bin, 'node'), '22.0.0');
    const local = path.join(home('link'), '.local', 'bin');
    fs.mkdirSync(local, { recursive: true });
    fs.symlinkSync(shim, path.join(local, 'blueline'));
    let r = run({ home: home('link'), path: `${bin}:${local}:/usr/bin:/bin`, via: path.join(local, 'blueline') });
    expect(r.out).toContain(`[${main()}]`);
    const hop = path.join(dir, 'hop');
    fs.mkdirSync(hop, { recursive: true });
    fs.symlinkSync(path.relative(hop, shim), path.join(hop, 'b1'));
    fs.symlinkSync('b1', path.join(hop, 'b2'));
    r = run({ home: home('link'), path: `${bin}:/usr/bin:/bin`, via: path.join(hop, 'b2') });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`[${main()}]`);
  });

  it('BLUELINE_NODE wins, and must be Node 22+', () => {
    const chosen = fakeNode(path.join(dir, 'chosen', 'node'), '22.5.0');
    const bin = path.join(dir, 'bin-24');
    fakeNode(path.join(bin, 'node'), '24.1.0');
    expect(run({ home: home('env'), path: `${bin}:/usr/bin:/bin`, env: { BLUELINE_NODE: chosen } }).out).toContain(`ran ${chosen}`);
    const old = fakeNode(path.join(dir, 'old', 'node'), '20.0.0');
    const r = run({ home: home('env'), path: `${bin}:/usr/bin:/bin`, env: { BLUELINE_NODE: old } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('BLUELINE_NODE');
  });

  it('a missing blueline.cjs is reported, not run', () => {
    const lonely = path.join(dir, 'lonely');
    fs.mkdirSync(lonely, { recursive: true });
    fs.copyFileSync(SHIM, path.join(lonely, 'blueline'));
    fs.chmodSync(path.join(lonely, 'blueline'), 0o755);
    const r = run({ home: home('lonely'), via: path.join(lonely, 'blueline') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/cannot find blueline\.cjs/);
  });

  it('carries its marker (Install Command Line Tool recognises a moved copy by it)', () => {
    expect(fs.readFileSync(SHIM, 'utf8').split('\n').slice(0, 3).join('\n')).toContain('blueline-shim');
    expect(fs.readFileSync(CMD, 'utf8')).toContain('blueline-shim');
  });
});

/**
 * Root and unshare: the shim runs in a private mount namespace where /usr/local/bin is an empty folder, so
 * this machine's real Node there is out of reach (/opt/homebrew does not exist here).
 */
const canHide = posix && process.getuid?.() === 0 && fs.existsSync('/usr/bin/unshare') && spawnSync('/usr/bin/unshare', ['--mount', 'true']).status === 0;

function runHidden(o: { home: string; path: string; env?: Record<string, string> }) {
  const empty = fs.mkdtempSync(path.join(dir, 'empty-'));
  const env: Record<string, string> = { HOME: o.home, PATH: o.path, ...(o.env ?? {}) };
  const script = `mount --bind "$1" /usr/local/bin && shift && exec "$@"`;
  const r = spawnSync('/usr/bin/unshare', ['--mount', '--propagation', 'private', '/bin/sh', '-c', script, 'sh', empty, shim], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe.skipIf(!canHide)('the POSIX shim with no Node in PATH or Homebrew’s folders', () => {
  it('a Node older than 22 on PATH is passed over for nvm’s newest version (by number, not by name)', () => {
    const bin = path.join(dir, 'bin-18');
    fakeNode(path.join(bin, 'node'), '18.19.0');
    const h = home('nvm');
    for (const v of ['9.11.2', '20.11.1', '22.1.0', '22.10.0']) fakeNode(path.join(h, '.nvm', 'versions', 'node', `v${v}`, 'bin', 'node'), v);
    const r = runHidden({ home: h, path: `${bin}:/usr/bin:/bin` });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`ran ${path.join(h, '.nvm/versions/node/v22.10.0/bin/node')}`);
    // NVM_DIR is honoured.
    const other = path.join(dir, 'nvm-elsewhere');
    fakeNode(path.join(other, 'versions', 'node', 'v23.0.0', 'bin', 'node'), '23.0.0');
    expect(runHidden({ home: h, path: `${bin}:/usr/bin:/bin`, env: { NVM_DIR: other } }).out).toContain(`ran ${path.join(other, 'versions/node/v23.0.0/bin/node')}`);
  });

  it('Volta, then fnm (its default alias, then its newest version)', () => {
    const volta = home('volta');
    fakeNode(path.join(volta, '.volta', 'bin', 'node'), '22.2.0');
    expect(runHidden({ home: volta, path: '/usr/bin:/bin' }).out).toContain(`ran ${path.join(volta, '.volta/bin/node')}`);
    const fnm = home('fnm');
    fakeNode(path.join(fnm, '.local', 'share', 'fnm', 'node-versions', 'v22.4.0', 'installation', 'bin', 'node'), '22.4.0');
    expect(runHidden({ home: fnm, path: '/usr/bin:/bin' }).out).toContain('/.local/share/fnm/node-versions/v22.4.0/installation/bin/node');
    fakeNode(path.join(fnm, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node'), '24.0.0');
    expect(runHidden({ home: fnm, path: '/usr/bin:/bin' }).out).toContain('/.local/share/fnm/aliases/default/bin/node');
  });

  it('none found: says how to get Node 22 and what it found, and exits 1', () => {
    const bin = path.join(dir, 'bin-16');
    fakeNode(path.join(bin, 'node'), '16.20.0');
    const r = runHidden({ home: home('none'), path: `${bin}:/usr/bin:/bin` });
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('blueline needs Node.js 22 or later');
    expect(r.err).toContain(`${path.join(bin, 'node')} (Node.js 16)`);
    expect(r.err).toContain('https://nodejs.org');
    expect(r.err).toContain('brew install node');
    expect(r.err).toContain('BLUELINE_NODE');
  });
});

describe.skipIf(!posix)('Homebrew’s folders (this machine’s /usr/local/bin/node)', () => {
  it('with no node on PATH, /usr/local/bin/node is found', () => {
    if (!fs.existsSync('/usr/local/bin/node')) return;
    const major = Number(spawnSync('/usr/local/bin/node', ['--version'], { encoding: 'utf8' }).stdout.replace(/^v/, '').split('.')[0]);
    if (!(major >= 22)) return;
    // /usr/local/bin/node runs the stand-in blueline.cjs, which prints nothing and exits 0.
    const r = run({ home: home('brew'), path: '/usr/bin:/bin' });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });
});

describe('the Windows shim (text only; cmd.exe is not available here)', () => {
  const text = fs.readFileSync(CMD, 'utf8');
  it('looks in BLUELINE_NODE, PATH, Program Files, nvm-windows, Volta and fnm, needs 22, and runs blueline.cjs next to it', () => {
    // The code after the header comment, where the order is the one that runs.
    const code = text.slice(text.indexOf('set "BL_TRIED="'));
    const order = ['BLUELINE_NODE', 'where node.exe', '%ProgramFiles%\\nodejs\\node.exe', 'NVM_SYMLINK', 'Volta', 'fnm'].map((s) => code.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('GEQ 22');
    expect(text).toContain('%~dp0blueline.cjs');
    expect(text).toMatch(/setlocal DisableDelayedExpansion\r?\n"%BL_NODE%" "%BL_MAIN%" %\*/);
    expect(text).toContain('https://nodejs.org');
  });
});
