// scripts/third-party.mjs: the third-party code that ships, for THIRD-PARTY-NOTICES.txt and the SBOM (supply
// chain, docs/DEPENDENCIES.md). The cases marked "bypass" were found by the adversarial review of 2026-10-23: the
// vendored reveal.js that ships in the Diagnostics deck was in neither the notices nor the SBOM, and a bundled
// package installed from another source (an npm-shrinkwrap.json pointing at git) was listed with the registry's
// URL and sha512.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

type Json = Record<string, any>;
interface ThirdParty {
  bundledPackages(meta: Json, root?: string): Json[];
  vendoredPackages(root?: string, opts?: { built?: boolean }): Json[];
  vendoredProblems(entry: Json, dir: string): string[];
  noticesText(packages: Json[], opts: { title: string; bundles: string[]; root?: string; vendored?: Json[] }): string;
  cycloneDx(packages: Json[], opts?: Json): Json;
}

const ROOT = path.resolve(__dirname, '../../..');
let tp: ThirdParty;
const dirs: string[] = [];

beforeAll(async () => {
  tp = (await import(pathToFileURL(path.join(ROOT, 'scripts/third-party.mjs')).href)) as ThirdParty;
});
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-third-party-'));
  dirs.push(d);
  return d;
};

describe('vendored files (scripts/vendored.json)', () => {
  it('lists reveal.js 6.0.2, whose files in the repository are the reviewed ones', () => {
    const [reveal] = tp.vendoredPackages(ROOT);
    expect(reveal).toMatchObject({ name: 'reveal.js', version: '6.0.2', licence: 'MIT', dir: 'fixtures/decks/reveal-hash/vendor', shippedAs: 'app.asar/dist/assets/diagnostics-deck/vendor' });
    expect(Object.keys(reveal.files).sort()).toEqual(['LICENSE', 'reset.css', 'reveal.css', 'reveal.js', 'theme/white.css']);
    expect(reveal.includes[0]).toMatchObject({ name: 'Source Sans Pro', licence: 'OFL-1.1' });
  });

  it('every file the build copies from the fixture\'s vendor folder is listed (nothing ships unlisted)', () => {
    const [reveal] = tp.vendoredPackages(ROOT);
    expect(tp.vendoredProblems(reveal, path.join(ROOT, reveal.dir))).toEqual([]);
  });

  it('fails on a changed, an added and a missing file', () => {
    const [reveal] = tp.vendoredPackages(ROOT);
    const copy = () => {
      const d = tmp();
      fs.cpSync(path.join(ROOT, reveal.dir), d, { recursive: true });
      return d;
    };
    const changed = copy();
    fs.appendFileSync(path.join(changed, 'reveal.js'), '\n;fetch("https://evil.example")');
    expect(tp.vendoredProblems(reveal, changed).join('\n')).toMatch(/reveal\.js is not the reviewed file \(SHA-256 differs/);
    const added = copy();
    fs.writeFileSync(path.join(added, 'theme', 'evil.js'), '');
    expect(tp.vendoredProblems(reveal, added).join('\n')).toMatch(/theme\/evil\.js is not in scripts\/vendored\.json/);
    const missing = copy();
    fs.rmSync(path.join(missing, 'reset.css'));
    expect(tp.vendoredProblems(reveal, missing).join('\n')).toMatch(/reset\.css is missing/);
  });

  it('bypass: the notices hold reveal.js\'s licence and the embedded font\'s', () => {
    const vendored = tp.vendoredPackages(ROOT);
    const text = tp.noticesText([], { title: 'test', bundles: [], root: ROOT, vendored });
    expect(text).toMatch(/reveal\.js 6\.0\.2 \(MIT\): dist\/assets\/diagnostics-deck\/vendor\//);
    expect(text).toMatch(/Copyright \(C\) 2011-2026 Hakim El Hattab/);
    expect(text).toMatch(/Source Sans Pro \(in reveal\.js 6\.0\.2/);
    expect(text).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
  });

  it('bypass: the SBOM lists reveal.js with the registry tarball\'s sha512 and each shipped file\'s SHA-256', () => {
    const bom = tp.cycloneDx([], { root: ROOT, platform: 'darwin', arch: 'arm64', commit: '0'.repeat(40) });
    const reveal = bom.components.find((c: Json) => c.name === 'reveal.js');
    expect(reveal).toMatchObject({ version: '6.0.2', purl: 'pkg:npm/reveal.js@6.0.2', licenses: [{ license: { id: 'MIT' } }] });
    expect(reveal.hashes[0]).toEqual({ alg: 'SHA-512', content: Buffer.from('JYIg5D9aoxoaLeb84O+OvAwsKWdIavVgEDScxtYEXFCT6t6TQrhNtSgogcjdCpdLsWglhJn3zyE3fUOwiH5KEg==', 'base64').toString('hex') });
    const files = reveal.components.filter((c: Json) => c.type === 'file' && c.hashes);
    expect(files.map((f: Json) => f.name)).toContain('app.asar/dist/assets/diagnostics-deck/vendor/reveal.js');
    expect(files.find((f: Json) => f.name.endsWith('/reveal.js')).hashes[0]).toEqual({ alg: 'SHA-256', content: 'aa1bbbf2617b23a623b23612cb3c5bdb63de512e652bf20fcfa832b045d37844' });
    expect(reveal.components.find((c: Json) => c.name === 'Source Sans Pro').licenses).toEqual([{ license: { id: 'OFL-1.1' } }]);
    expect(bom.dependencies[0].dependsOn).toContain('pkg:npm/reveal.js@6.0.2');
  });
});

describe('bundled packages: the source npm actually installed', () => {
  /** A root with one bundled package x, locked from the registry, installed as `installed` records it. */
  function root(installed: Json): { dir: string; meta: Json } {
    const dir = tmp();
    const entry = { version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`, license: 'MIT' };
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/x': entry } }));
    fs.mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/x/package.json'), JSON.stringify({ name: 'x', version: '1.0.0', license: 'MIT' }));
    fs.writeFileSync(path.join(dir, 'node_modules/x/LICENSE'), 'MIT');
    fs.writeFileSync(path.join(dir, 'node_modules/.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': { ...entry, ...installed } } }));
    const meta = { outputs: { 'packages/app/dist/main.cjs': { inputs: { 'node_modules/x/index.js': { bytesInOutput: 10 } } } } };
    return { dir, meta };
  }

  it('takes the resolved URL and integrity from node_modules/.package-lock.json', () => {
    const { dir, meta } = root({});
    const [x] = tp.bundledPackages(meta, dir);
    expect(x).toMatchObject({ name: 'x', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz' });
  });

  it('bypass: fails when npm installed a bundled package from another source than package-lock.json\'s', () => {
    const git = root({ resolved: 'git+file:///tmp/evil-acorn#6aa680a5', integrity: undefined });
    expect(() => tp.bundledPackages(git.meta, git.dir)).toThrow(/node_modules\/x: npm installed it with resolved git\+file:\/\/\/tmp\/evil-acorn#6aa680a5, but package-lock\.json has https:\/\/registry\.npmjs\.org\/x\/-\/x-1\.0\.0\.tgz/);
    const missing = root({});
    fs.rmSync(path.join(missing.dir, 'node_modules/.package-lock.json'));
    expect(() => tp.bundledPackages(missing.meta, missing.dir)).toThrow(/node_modules\/\.package-lock\.json is missing/);
  });
});
