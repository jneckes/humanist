// scripts/check-lockfile.mjs, the lockfile check CI runs before `npm ci` (supply chain, docs/DEPENDENCIES.md).
// Each case copies the repository's package.json files, package-lock.json and .npmrc to a temporary folder, makes
// one change an attacker could make in a pull request, and checks that the check fails for that reason. The cases
// marked "bypass" passed the check before it was hardened (the adversarial review of 2026-10-23): an
// npm-shrinkwrap.json that npm ci prefers to package-lock.json, an orphan entry whose command replaced tsc,
// overrides with ranges, git or aliases, and an .npmrc that turns install scripts back on or redirects the registry.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

type Json = Record<string, any>;
interface CheckLockfile {
  checkLockfile(root: string, opts?: { npmConfig?: boolean }): { errors: string[]; summary: string };
  configProblems(config: Json | null): string[];
  binProblems(packages: { key: string; name: string; bin: unknown }[]): string[];
  NPMRC: string[];
}

const ROOT = path.resolve(__dirname, '../../..');
const MANIFESTS = ['package.json', 'package-lock.json', '.npmrc', 'packages/app/package.json', 'packages/cli/package.json', 'packages/core/package.json', 'packages/editor/package.json'];
const SHA512 = (byte: number) => `sha512-${Buffer.alloc(64, byte).toString('base64')}`;
let cl: CheckLockfile;
const dirs: string[] = [];

beforeAll(async () => {
  // Plain ESM with no types: imported by URL, so the typechecker does not resolve it.
  cl = (await import(pathToFileURL(path.join(ROOT, 'scripts/check-lockfile.mjs')).href)) as CheckLockfile;
});
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A copy of the repository's manifests, changed by `mutate` (lock: package-lock.json; pj: package.json files by folder). */
function copy(mutate: (ctx: { dir: string; lock: Json; pj: Record<string, Json> }) => void = () => {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-check-lockfile-'));
  dirs.push(dir);
  for (const f of MANIFESTS) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  const pj: Record<string, Json> = {};
  for (const f of MANIFESTS.filter((m) => m.endsWith('package.json'))) pj[path.dirname(f) === '.' ? '' : path.dirname(f)] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  mutate({ dir, lock, pj });
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2));
  for (const [folder, json] of Object.entries(pj)) fs.writeFileSync(path.join(dir, folder, 'package.json'), JSON.stringify(json, null, 2));
  return dir;
}

const check = (dir: string) => cl.checkLockfile(dir, { npmConfig: false }).errors;

describe('check:lockfile', () => {
  it('passes on the repository and on an unchanged copy', () => {
    expect(cl.checkLockfile(ROOT, { npmConfig: false }).errors).toEqual([]);
    expect(check(copy())).toEqual([]);
  });

  it('bypass: fails when npm-shrinkwrap.json exists, at the root or in a workspace (npm ci would install from it)', () => {
    const sw = copy(({ dir, lock }) => {
      const s = structuredClone(lock);
      s.packages['node_modules/acorn'].resolved = 'git+https://example.com/evil/acorn.git#6aa680a5';
      delete s.packages['node_modules/acorn'].integrity;
      fs.writeFileSync(path.join(dir, 'npm-shrinkwrap.json'), JSON.stringify(s));
    });
    expect(check(sw).join('\n')).toMatch(/^npm-shrinkwrap\.json exists in the repository root/m);
    const ws = copy(({ dir }) => fs.writeFileSync(path.join(dir, 'packages/core/npm-shrinkwrap.json'), '{}'));
    expect(check(ws).join('\n')).toMatch(/packages\/core\/npm-shrinkwrap\.json exists/);
  });

  it('bypass: fails on an entry nothing depends on, and on its command replacing tsc', () => {
    // tsc@2.0.4 is a real registry package whose bin is `tsc`: npm ci installed it and linked node_modules/.bin/tsc
    // to it, so `npm run typecheck` ran it instead of TypeScript.
    const dir = copy(({ lock }) => {
      lock.packages['node_modules/tsc'] = { version: '2.0.4', resolved: 'https://registry.npmjs.org/tsc/-/tsc-2.0.4.tgz', integrity: SHA512(1), dev: true, license: 'MIT', bin: { tsc: 'bin/tsc' } };
    });
    const errors = check(dir).join('\n');
    expect(errors).toMatch(/node_modules\/tsc@2\.0\.4: nothing depends on it/);
    expect(errors).toMatch(/node_modules\/tsc declares the command `tsc`, which the repo runs from typescript/);
    expect(errors).toMatch(/node_modules\/\.bin\/tsc is declared by node_modules\/tsc and node_modules\/typescript/);
  });

  it('bypass: fails on an orphan nested under a workspace', () => {
    const dir = copy(({ lock }) => {
      lock.packages['packages/app/node_modules/left-pad'] = { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: SHA512(2), dev: true };
    });
    expect(check(dir).join('\n')).toMatch(/packages\/app\/node_modules\/left-pad@1\.3\.0: nothing depends on it/);
  });

  it('fails when a package that is depended on declares a command the repo runs, or a system command', () => {
    const owned = copy(({ lock }) => {
      lock.packages['node_modules/acorn'].bin = { ...lock.packages['node_modules/acorn'].bin, vitest: 'bin/x' };
    });
    expect(check(owned).join('\n')).toMatch(/node_modules\/acorn declares the command `vitest`/);
    const reserved = copy(({ lock }) => {
      lock.packages['node_modules/acorn'].bin = { ...lock.packages['node_modules/acorn'].bin, node: 'bin/x' };
    });
    expect(check(reserved).join('\n')).toMatch(/declares the command `node`, which would run in place of the system's/);
    // The one known pair: @playwright/test re-exports playwright's command.
    expect(cl.binProblems([
      { key: 'node_modules/@playwright/test', name: '@playwright/test', bin: { playwright: 'cli.js' } },
      { key: 'node_modules/playwright', name: 'playwright', bin: { playwright: 'cli.js' } },
    ])).toEqual([]);
    expect(cl.binProblems([
      { key: 'node_modules/a', name: 'a', bin: 'cli.js' },
      { key: 'node_modules/b', name: 'b', bin: { a: 'x.js' } },
    ]).join('\n')).toMatch(/node_modules\/\.bin\/a is declared by node_modules\/a and node_modules\/b/);
  });

  it('bypass: fails on overrides that are not exact registry versions, at any depth', () => {
    for (const overrides of [{ acorn: '^8.0.0' }, { acorn: 'github:evil/acorn' }, { acorn: 'npm:evil-acorn@1.0.0' }, { parse5: { entities: '~8.1.0' } }, { parse5: { '.': 'latest' } }]) {
      const dir = copy(({ pj }) => {
        pj[''].overrides = overrides;
      });
      expect(check(dir).join('\n'), JSON.stringify(overrides)).toMatch(/package\.json overrides\.\S+ is ".*": overrides must be exact registry versions/);
    }
    const exact = copy(({ pj }) => {
      pj[''].overrides = { acorn: '8.19.0', parse5: { entities: '8.1.0' } };
    });
    expect(check(exact)).toEqual([]);
  });

  it('bypass: fails unless .npmrc holds exactly the allowed settings', () => {
    const npmrc = fs.readFileSync(path.join(ROOT, '.npmrc'), 'utf8');
    const cases: [string, RegExp][] = [
      [npmrc.replace('ignore-scripts=true', ''), /"ignore-scripts=true" is missing/],
      [npmrc.replace('git=false', ''), /"git=false" is missing/],
      [`${npmrc}registry=http://127.0.0.1:9/\n`, /"registry=http:\/\/127\.0\.0\.1:9\/" is not allowed/],
      [`${npmrc}@blueline:registry=https://npm.example.com/\n`, /"@blueline:registry=https:\/\/npm\.example\.com\/" is not allowed/],
      [`${npmrc}replace-registry-host=never\n`, /"replace-registry-host=never" is not allowed/],
      [`${npmrc}ignore-scripts = false\n`, /"ignore-scripts=false" is not allowed/],
    ];
    for (const [text, re] of cases) {
      const dir = copy(({ dir: d }) => fs.writeFileSync(path.join(d, '.npmrc'), text));
      expect(check(dir).join('\n'), text.split('\n').filter((l) => l && !l.startsWith('#')).join(' | ')).toMatch(re);
    }
    const ws = copy(({ dir }) => fs.writeFileSync(path.join(dir, 'packages/app/.npmrc'), 'ignore-scripts=false\n'));
    expect(check(ws).join('\n')).toMatch(/packages\/app\/\.npmrc exists/);
    expect(cl.NPMRC).toEqual(expect.arrayContaining(['ignore-scripts=true', 'git=false']));
  });

  it('fails when npm\'s effective configuration would install elsewhere, run scripts or run git', () => {
    const good = { registry: 'https://registry.npmjs.org/', 'ignore-scripts': true, git: 'false', 'replace-registry-host': 'npmjs' };
    expect(cl.configProblems(good)).toEqual([]);
    expect(cl.configProblems({ ...good, registry: 'http://127.0.0.1:9/' }).join('\n')).toMatch(/registry is http:\/\/127\.0\.0\.1:9\//);
    expect(cl.configProblems({ ...good, '@evil:registry': 'https://x.example/' }).join('\n')).toMatch(/@evil:registry/);
    expect(cl.configProblems({ ...good, 'ignore-scripts': false }).join('\n')).toMatch(/ignore-scripts is false/);
    expect(cl.configProblems({ ...good, git: 'git' }).join('\n')).toMatch(/git is "git"/);
    expect(cl.configProblems({ ...good, 'replace-registry-host': 'always' }).join('\n')).toMatch(/replace-registry-host is always/);
    expect(cl.configProblems(null).join('\n')).toMatch(/could not read/);
  });

  it('still fails on the sources, pins and install scripts it checked before', () => {
    const cases: [(ctx: { dir: string; lock: Json; pj: Record<string, Json> }) => void, RegExp][] = [
      [({ lock }) => (lock.packages['node_modules/acorn'].resolved = 'git+ssh://git@github.com/acornjs/acorn.git#0123456'), /node_modules\/acorn: resolved from git\+ssh/],
      [({ lock }) => (lock.packages['node_modules/acorn'].resolved = 'https://registry.npmjs.org/evil/-/acorn-8.19.0.tgz'), /node_modules\/acorn: resolved https:\/\/registry\.npmjs\.org\/evil/],
      [({ lock }) => (lock.packages['node_modules/acorn'].integrity = 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA='), /integrity sha1-.* is not one sha512/],
      [({ lock }) => (lock.packages['node_modules/acorn'].name = 'left-pad'), /an alias of left-pad/],
      [({ pj }) => (pj[''].devDependencies.esbuild = '^0.28.2'), /devDependencies\.esbuild is "\^0\.28\.2"/],
      [({ pj }) => (pj['packages/core'].dependencies.acorn = 'latest'), /dependencies\.acorn is "latest"/],
      [({ pj }) => (pj['packages/core'].bundleDependencies = ['acorn']), /bundleDependencies/],
      [({ lock }) => (lock.packages[''].devDependencies.esbuild = '^0.20.0'), /root devDependencies differ from package\.json/],
      [({ lock }) => (lock.packages['node_modules/evil'] = { resolved: '../../evil', link: true }), /node_modules\/evil: a link/],
      [
        ({ lock, pj }) => {
          pj[''].devDependencies.bufferutil = '4.0.8';
          lock.packages[''].devDependencies.bufferutil = '4.0.8';
          lock.packages['node_modules/bufferutil'] = { version: '4.0.8', resolved: 'https://registry.npmjs.org/bufferutil/-/bufferutil-4.0.8.tgz', integrity: SHA512(3), dev: true, hasInstallScript: true };
        },
        /node_modules\/bufferutil@4\.0\.8 has an install script and is not in .*INSTALL_SCRIPTS/,
      ],
      [
        ({ pj, lock }) => {
          pj[''].workspaces.push('../outside');
          lock.packages[''].workspaces.push('../outside');
        },
        /workspaces: "\.\.\/outside" is not a folder inside the repository/,
      ],
    ];
    for (const [mutate, re] of cases) expect(check(copy(mutate)).join('\n'), String(re)).toMatch(re);
  });
});
