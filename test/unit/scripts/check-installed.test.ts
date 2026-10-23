// scripts/check-installed.mjs, run after `npm ci` (supply chain, docs/DEPENDENCIES.md): what npm installed is what
// package-lock.json locks. A small synthetic project (two registry packages and an optional one for another
// platform) is checked as installed, then with one change each. The cases marked "bypass" passed every check
// before (adversarial review, 2026-10-23): a package installed from another source than the lockfile's (an
// npm-shrinkwrap.json pointing at git), and an install script whose package-lock.json entry leaves out
// hasInstallScript.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

type Json = Record<string, any>;
interface Platform {
  platform?: string;
  arch?: string;
  libc?: string | null;
}
interface CheckInstalled {
  checkInstalled(root: string, platform?: Platform): { errors: string[]; summary: string };
  skippedHere(entry: Json, platform?: Platform): boolean;
}

const ROOT = path.resolve(__dirname, '../../..');
const LINUX: Platform = { platform: 'linux', arch: 'x64', libc: 'glibc' };
const SHA512 = (byte: number) => `sha512-${Buffer.alloc(64, byte).toString('base64')}`;
let ci: CheckInstalled;
const dirs: string[] = [];

beforeAll(async () => {
  ci = (await import(pathToFileURL(path.join(ROOT, 'scripts/check-installed.mjs')).href)) as CheckInstalled;
});
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const reg = (name: string, version: string, byte: number, extra: Json = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity: SHA512(byte),
  dev: true,
  ...extra,
});

/**
 * A project as `npm ci` leaves it on linux-x64-glibc: a → b, and fsx-darwin (optional, darwin only) skipped.
 * `change` edits the lockfile, the hidden lockfile or the folder before the check.
 */
function project(change: (ctx: { dir: string; lock: Json; hidden: Json }) => void = () => {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-check-installed-'));
  dirs.push(dir);
  const pj = { name: 'demo', version: '1.0.0', devDependencies: { a: '1.0.0' }, optionalDependencies: { 'fsx-darwin': '1.0.0' } };
  const lock: Json = {
    name: 'demo',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'demo', version: '1.0.0', devDependencies: pj.devDependencies, optionalDependencies: pj.optionalDependencies },
      'node_modules/a': reg('a', '1.0.0', 1, { dependencies: { b: '1.0.0' }, bin: { a: 'cli.js' } }),
      'node_modules/b': reg('b', '1.0.0', 2),
      'node_modules/fsx-darwin': reg('fsx-darwin', '1.0.0', 3, { optional: true, os: ['darwin'] }),
    },
  };
  const hidden: Json = { name: 'demo', version: '1.0.0', lockfileVersion: 3, requires: true, packages: structuredClone(lock.packages) };
  delete hidden.packages[''];
  delete hidden.packages['node_modules/fsx-darwin'];
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pj));
  for (const [name, bin] of [['a', { a: 'cli.js' }], ['b', undefined]] as const) {
    fs.mkdirSync(path.join(dir, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...(bin ? { bin } : {}) }));
  }
  fs.mkdirSync(path.join(dir, 'node_modules/.bin'));
  fs.symlinkSync('../a/cli.js', path.join(dir, 'node_modules/.bin/a'));
  change({ dir, lock, hidden });
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  fs.writeFileSync(path.join(dir, 'node_modules/.package-lock.json'), JSON.stringify(hidden));
  return dir;
}

const check = (dir: string) => ci.checkInstalled(dir, LINUX).errors.join('\n');
const writePkg = (dir: string, name: string, json: Json) => fs.writeFileSync(path.join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...json }));

describe('check:installed', () => {
  it('passes on the repository\'s own node_modules (after npm ci) and on the synthetic project', () => {
    expect(ci.checkInstalled(ROOT).errors).toEqual([]);
    expect(ci.checkInstalled(project(), LINUX).errors).toEqual([]);
  });

  it('skips exactly the optional packages for another OS, CPU or libc', () => {
    expect(ci.skippedHere({ optional: true, os: ['darwin'] }, LINUX)).toBe(true);
    expect(ci.skippedHere({ optional: true, cpu: ['arm64'] }, LINUX)).toBe(true);
    expect(ci.skippedHere({ optional: true, os: ['linux'], libc: ['musl'] }, LINUX)).toBe(true);
    expect(ci.skippedHere({ optional: true, os: ['!win32'] }, LINUX)).toBe(false);
    expect(ci.skippedHere({ optional: true, os: ['linux'], cpu: ['x64'] }, LINUX)).toBe(false);
    expect(ci.skippedHere({ os: ['darwin'] }, LINUX)).toBe(false); // not optional: npm would refuse it, not skip it
  });

  it('bypass: fails when npm installed a package from another source than package-lock.json\'s', () => {
    // What node_modules/.package-lock.json recorded when an npm-shrinkwrap.json pointed acorn at a git repository.
    const git = project(({ hidden }) => {
      hidden.packages['node_modules/b'].resolved = 'git+file:///tmp/evil-acorn#6aa680a5';
      delete hidden.packages['node_modules/b'].integrity;
    });
    expect(check(git)).toMatch(/node_modules\/b: installed with resolved "git\+file:\/\/\/tmp\/evil-acorn#6aa680a5", but package-lock\.json has "https:\/\/registry\.npmjs\.org\/b\/-\/b-1\.0\.0\.tgz"/);
    expect(check(git)).toMatch(/node_modules\/b: installed with integrity undefined/);
    const other = project(({ hidden }) => {
      hidden.packages['node_modules/b'].integrity = SHA512(9);
    });
    expect(check(other)).toMatch(/node_modules\/b: installed with integrity/);
  });

  it('bypass: fails on an install script that package-lock.json does not flag (npm reads the package, not the flag)', () => {
    const post = project(({ dir }) => writePkg(dir, 'b', { scripts: { postinstall: 'node evil.js' } }));
    expect(check(post)).toMatch(/node_modules\/b has an install script \(postinstall\) and is not in .*INSTALL_SCRIPTS \(package-lock\.json does not flag it: hasInstallScript is missing\)/);
    const gyp = project(({ dir }) => fs.writeFileSync(path.join(dir, 'node_modules/b/binding.gyp'), '{}'));
    expect(check(gyp)).toMatch(/node_modules\/b has an install script \(install \(binding\.gyp: node-gyp rebuild\)\)/);
    // prepare runs only for git and folder sources (ruled out above): a registry package's prepare is not counted.
    const prepare = project(({ dir }) => writePkg(dir, 'b', { scripts: { prepare: 'tsc' } }));
    expect(check(prepare)).toBe('');
  });

  it('fails on packages npm should not have installed: an orphan, another platform\'s, or one it never recorded', () => {
    const orphan = project(({ dir, lock, hidden }) => {
      lock.packages['node_modules/tsc'] = reg('tsc', '2.0.4', 4, { bin: { tsc: 'bin/tsc' } });
      hidden.packages['node_modules/tsc'] = lock.packages['node_modules/tsc'];
      fs.mkdirSync(path.join(dir, 'node_modules/tsc'));
      writePkg(dir, 'tsc', { version: '2.0.4', bin: { tsc: 'bin/tsc' } });
    });
    expect(check(orphan)).toMatch(/node_modules\/tsc: installed, but on linux-x64 npm should have skipped it/);
    const darwin = project(({ dir, hidden, lock }) => {
      hidden.packages['node_modules/fsx-darwin'] = lock.packages['node_modules/fsx-darwin'];
      fs.mkdirSync(path.join(dir, 'node_modules/fsx-darwin'));
      writePkg(dir, 'fsx-darwin', {});
    });
    expect(check(darwin)).toMatch(/node_modules\/fsx-darwin: installed, but on linux-x64 npm should have skipped it/);
    const stray = project(({ dir }) => {
      fs.mkdirSync(path.join(dir, 'node_modules/evil'));
      writePkg(dir, 'evil', {});
    });
    expect(check(stray)).toMatch(/node_modules\/evil: on disk, but not a package npm installed from package-lock\.json/);
    const missing = project(({ dir }) => fs.rmSync(path.join(dir, 'node_modules/b'), { recursive: true }));
    expect(check(missing)).toMatch(/node_modules\/b: in node_modules\/\.package-lock\.json but not on disk/);
    const notRecorded = project(({ hidden }) => delete hidden.packages['node_modules/b']);
    expect(check(notRecorded)).toMatch(/node_modules\/b@1\.0\.0: in package-lock\.json but not in node_modules\/\.package-lock\.json/);
  });

  it('fails when an installed package is not the locked version, or is a link', () => {
    const version = project(({ dir }) => writePkg(dir, 'b', { version: '1.0.1' }));
    expect(check(version)).toMatch(/node_modules\/b: its package\.json is version 1\.0\.1, package-lock\.json locks 1\.0\.0/);
    const link = project(({ dir }) => fs.symlinkSync(os.tmpdir(), path.join(dir, 'node_modules/c')));
    expect(check(link)).toMatch(/node_modules\/c: a link to .*only the workspace links/);
  });

  it('fails on colliding commands and on a .bin entry no installed package declares', () => {
    const collide = project(({ dir }) => writePkg(dir, 'b', { bin: { a: 'x.js' } }));
    expect(check(collide)).toMatch(/node_modules\/\.bin\/a is declared by node_modules\/a and node_modules\/b/);
    const tsc = project(({ dir }) => writePkg(dir, 'b', { bin: { tsc: 'x.js' } }));
    expect(check(tsc)).toMatch(/node_modules\/b declares the command `tsc`, which the repo runs from typescript/);
    const planted = project(({ dir }) => fs.writeFileSync(path.join(dir, 'node_modules/.bin/vitest'), '#!/bin/sh\n'));
    expect(check(planted)).toMatch(/node_modules\/\.bin\/vitest: no installed package declares this command/);
  });

  it('fails without node_modules/.package-lock.json', () => {
    const dir = project();
    fs.rmSync(path.join(dir, 'node_modules/.package-lock.json'));
    expect(ci.checkInstalled(dir, LINUX).errors).toEqual(['node_modules/.package-lock.json is missing: run npm ci']);
  });
});
