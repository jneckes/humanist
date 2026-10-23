#!/usr/bin/env node
// Third-party code that ships in the app (supply chain, docs/DEPENDENCIES.md).
//
// The app ships no node_modules: every package its code uses is bundled by esbuild (scripts/build.mjs), and
// app.asar holds only package.json and dist/ (scripts/package-smoke.mjs checks it). So the third-party code that
// ships is exactly the set of node_modules files in esbuild's metafile, which scripts/build.mjs writes to
// out/esbuild-meta.json. From it this module makes:
//   - bundledPackages(): each bundled package, with its version, licence, the bundles it is in and its integrity
//     from package-lock.json (the build fails if a bundled package is not the locked one, or its licence is not
//     one of PERMISSIVE, or it has no licence file);
//   - THIRD-PARTY-NOTICES.txt (writeNotices, called by scripts/build.mjs): each bundled package's licence text,
//     shipped next to the bundles (in app.asar, and in resources/cli for the command's bundles);
//   - the SBOM (cycloneDx): CycloneDX 1.6 JSON listing those packages and Electron itself.
//
// Command line (after `npm run build`):
//   node scripts/third-party.mjs                 the bundled packages, one per line (npm run bundled)
//   node scripts/third-party.mjs --json          the same as JSON
//   node scripts/third-party.mjs --sbom <file>   write the SBOM [--platform darwin --arch arm64: Electron's zip]
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const META_FILE = join(ROOT, 'out', 'esbuild-meta.json');

/**
 * Licences a bundled package may have (SPDX ids; every id of an AND/OR expression must be here). They ask only
 * that the copyright and licence text travel with the code, which THIRD-PARTY-NOTICES.txt does. A package under
 * any other licence (copyleft, custom, none) fails the build until someone reviews it and adds it here.
 */
export const PERMISSIVE = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Zlib', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense']);

/**
 * Notices a package's licence file leaves out. pako is (MIT AND Zlib): its LICENSE holds the MIT text, and the
 * zlib licence of the code ported from zlib is in its source headers.
 */
const EXTRA_NOTICES = {
  pako: { file: 'lib/zlib/deflate.js', what: 'zlib licence (the code ported from zlib), from lib/zlib/deflate.js' },
};

/** The package folder (relative to the root, `node_modules/<name>` or nested) of a metafile input, or null. */
function packageDirOf(input) {
  const m = input.replace(/\\/g, '/').match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  return m ? m[1] : null;
}

/** The SPDX ids of a licence expression ("(MIT AND Zlib)" → MIT, Zlib). */
export function licenceIds(expr) {
  return String(expr ?? '')
    .replace(/[()]/g, ' ')
    .split(/\s+(?:AND|OR|WITH)\s+|\s+/)
    .filter(Boolean);
}

/** A bundle's name as it ships: dist/main.cjs (app.asar), cli/blueline.cjs (resources/cli). */
export function shippedName(output) {
  const rel = output.replace(/\\/g, '/');
  if (rel.startsWith('packages/app/dist/')) return 'app.asar/' + rel.slice('packages/app/'.length);
  if (rel.startsWith('packages/cli/dist/')) return 'cli/' + rel.slice('packages/cli/dist/'.length);
  return rel;
}

/**
 * The third-party packages in the bundles of `meta` (an esbuild metafile; paths relative to `root`), sorted by
 * name. Throws when one is not the version package-lock.json locks, has no integrity, no licence file or a licence
 * outside PERMISSIVE.
 */
export function bundledPackages(meta, root = ROOT) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;
  const byDir = new Map();
  for (const [output, o] of Object.entries(meta.outputs ?? {})) {
    if (output.endsWith('.map')) continue;
    for (const input of Object.keys(o.inputs ?? {})) {
      const dir = packageDirOf(input);
      if (!dir) continue;
      if (!byDir.has(dir)) byDir.set(dir, { bytes: 0, bundles: new Set() });
      const e = byDir.get(dir);
      e.bytes += o.inputs[input].bytesInOutput ?? 0;
      e.bundles.add(shippedName(output));
    }
  }
  const errors = [];
  const out = [];
  for (const [dir, { bytes, bundles }] of byDir) {
    const pj = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    // Its package-lock.json key. A copy of the tree whose node_modules entries are links (reader-only-check.mjs)
    // gives the linked package's real path, outside the copy: ../<repo>/node_modules/<name>.
    const key = dir.slice(dir.indexOf('node_modules/'));
    const locked = lock[key];
    const licence = typeof pj.license === 'string' ? pj.license : (pj.license?.type ?? null);
    const files = readdirSync(join(root, dir)).filter((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f)).sort();
    if (!locked) errors.push(`${dir}: not in package-lock.json`);
    else {
      if (locked.version !== pj.version) errors.push(`${dir}: installed ${pj.version}, but package-lock.json locks ${locked.version} (run npm ci)`);
      if (!/^sha512-/.test(locked.integrity ?? '')) errors.push(`${dir}: no sha512 integrity in package-lock.json`);
    }
    const ids = licenceIds(licence);
    if (ids.length === 0) errors.push(`${dir}: no licence in its package.json`);
    for (const id of ids) if (!PERMISSIVE.has(id)) errors.push(`${dir}: licence ${id} is not in scripts/third-party.mjs PERMISSIVE (review it before it ships)`);
    if (!files.some((f) => /^(licen[cs]e|copying)/i.test(f))) errors.push(`${dir}: no LICENSE file to ship in THIRD-PARTY-NOTICES.txt`);
    out.push({
      name: pj.name,
      version: pj.version,
      licence,
      dir: key,
      path: dir,
      bundles: [...bundles].sort(),
      bytesInBundles: bytes,
      resolved: locked?.resolved ?? null,
      integrity: locked?.integrity ?? null,
      licenceFiles: files,
      homepage: typeof pj.homepage === 'string' ? pj.homepage : null,
    });
  }
  if (errors.length) throw new Error(`third-party code in the bundles:\n  ${errors.join('\n  ')}`);
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.dir.localeCompare(b.dir)));
}

/** The leading comment block of a source file (the zlib notice in pako's sources). */
function leadingComment(text) {
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*('use strict';?)?\s*$/.test(line) && lines.length === 0) continue;
    if (!/^\s*\/\//.test(line)) break;
    lines.push(line.replace(/^\s*\/\/ ?/, ''));
  }
  return lines.join('\n').trim();
}

/** THIRD-PARTY-NOTICES.txt for the packages in `bundles` (shipped names, e.g. app.asar/dist/main.cjs). */
export function noticesText(packages, { title, bundles, root = ROOT }) {
  const pkgs = packages.filter((p) => p.bundles.some((b) => bundles.includes(b)));
  const rule = '='.repeat(100);
  const head = [
    `THIRD-PARTY NOTICES: ${title}`,
    '',
    `Bundles: ${bundles.map((b) => basename(b)).join(', ')}.`,
    'Generated by scripts/build.mjs from esbuild\'s metafile (scripts/third-party.mjs); do not edit.',
    'Electron and Chromium ship their own notices with the app (LICENSE.electron.txt, LICENSES.chromium.html).',
    '',
  ];
  if (pkgs.length === 0) return [...head, 'These bundles contain no third-party code.', ''].join('\n');
  head.push('These bundles contain code from the following packages:', '');
  for (const p of pkgs) head.push(`  ${p.name} ${p.version} (${p.licence}): ${p.bundles.filter((b) => bundles.includes(b)).map((b) => basename(b)).join(', ')}`);
  head.push('');
  const body = [];
  for (const p of pkgs) {
    body.push(rule, `${p.name} ${p.version}`, `License: ${p.licence}`, `Source: ${p.resolved ?? p.homepage ?? ''}`, rule, '');
    for (const f of p.licenceFiles) {
      if (p.licenceFiles.length > 1) body.push(`--- ${f}`, '');
      body.push(readFileSync(join(root, p.path, f), 'utf8').replace(/\r\n/g, '\n').trimEnd(), '');
    }
    const extra = EXTRA_NOTICES[p.name];
    if (extra) {
      const file = join(root, p.path, extra.file);
      const text = existsSync(file) ? leadingComment(readFileSync(file, 'utf8')) : '';
      if (!/This notice may not be removed/.test(text)) throw new Error(`third-party code: ${p.name}: the ${extra.what} was not found`);
      body.push(`--- ${extra.what}`, '', text, '');
    }
  }
  return [...head, ...body].join('\n');
}

/**
 * Writes THIRD-PARTY-NOTICES.txt next to each group of bundles: packages/app/dist (app.asar) and packages/cli/dist
 * (resources/cli). Returns the bundled packages.
 */
export function writeNotices(meta, root = ROOT) {
  const packages = bundledPackages(meta, root);
  const outputs = Object.keys(meta.outputs).filter((o) => !o.endsWith('.map') && /\.(c?js)$/.test(o)).map(shippedName);
  const groups = [
    { dir: join(root, 'packages/app/dist'), title: 'the Blueline app (app.asar)', bundles: outputs.filter((b) => b.startsWith('app.asar/')) },
    { dir: join(root, 'packages/cli/dist'), title: 'the blueline command (resources/cli)', bundles: outputs.filter((b) => b.startsWith('cli/')) },
  ];
  for (const g of groups) {
    mkdirSync(g.dir, { recursive: true });
    writeFileSync(join(g.dir, 'THIRD-PARTY-NOTICES.txt'), noticesText(packages, { title: g.title, bundles: g.bundles, root }));
  }
  return packages;
}

/** The base64 sha512 of an npm integrity string, as hex (CycloneDX hashes are hex). */
function integrityHex(integrity) {
  const m = /^sha512-(.+)$/.exec(integrity ?? '');
  return m ? Buffer.from(m[1], 'base64').toString('hex') : null;
}

/** CycloneDX component fields for an npm name: group (scope) and name, and its purl. */
function npmCoordinates(name, version) {
  const scoped = /^(@[^/]+)\/(.+)$/.exec(name);
  const purl = scoped ? `pkg:npm/${encodeURIComponent(scoped[1])}/${scoped[2]}@${version}` : `pkg:npm/${name}@${version}`;
  return scoped ? { group: scoped[1], name: scoped[2], purl } : { name, purl };
}

function licences(expr) {
  const ids = licenceIds(expr);
  if (ids.length === 1) return [{ license: { id: ids[0] } }];
  return [{ expression: String(expr).replace(/^\((.*)\)$/, '$1') }];
}

/**
 * The SBOM of what ships: CycloneDX 1.6 JSON with the app as its subject, every bundled third-party package
 * (version, licence, sha512 from package-lock.json, the bundles it is in), and Electron (its release zip for
 * `platform`/`arch` and that zip's SHA-256 from the electron package's checksums.json, which package-lock.json's
 * integrity covers).
 */
export function cycloneDx(packages, { platform = process.platform, arch = process.arch, root = ROOT, commit = null } = {}) {
  const app = JSON.parse(readFileSync(join(root, 'packages/app/package.json'), 'utf8'));
  const electronDir = join(root, 'node_modules', 'electron');
  const electron = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8'));
  const zip = `electron-v${electron.version}-${platform}-${arch}.zip`;
  const checksums = JSON.parse(readFileSync(join(electronDir, 'checksums.json'), 'utf8'));
  if (!checksums[zip]) throw new Error(`sbom: node_modules/electron/checksums.json has no ${zip}`);
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;
  const appRef = `blueline@${app.version}`;
  const components = packages.map((p) => {
    const c = npmCoordinates(p.name, p.version);
    return {
      type: 'library',
      'bom-ref': c.purl,
      ...(c.group ? { group: c.group } : {}),
      name: c.name,
      version: p.version,
      scope: 'required',
      licenses: licences(p.licence),
      hashes: [{ alg: 'SHA-512', content: integrityHex(p.integrity) }],
      purl: c.purl,
      externalReferences: [{ type: 'distribution', url: p.resolved }],
      properties: p.bundles.map((b) => ({ name: 'blueline:bundle', value: b })),
    };
  });
  const electronRef = `pkg:github/electron/electron@v${electron.version}`;
  components.push({
    type: 'framework',
    'bom-ref': electronRef,
    name: 'electron',
    version: electron.version,
    scope: 'required',
    description: 'The Electron runtime the app runs in (Chromium and Node.js; their notices ship with the app).',
    licenses: [{ license: { id: 'MIT' } }],
    hashes: [{ alg: 'SHA-256', content: checksums[zip] }],
    purl: electronRef,
    externalReferences: [
      { type: 'distribution', url: `https://github.com/electron/electron/releases/download/v${electron.version}/${zip}` },
      { type: 'vcs', url: 'https://github.com/electron/electron' },
    ],
    properties: [
      { name: 'blueline:electron-zip', value: zip },
      { name: 'blueline:checksum-source', value: `npm electron@${electron.version} checksums.json (${lock['node_modules/electron']?.integrity ?? 'not locked'})` },
    ],
  });
  let rev = commit ?? process.env.GITHUB_SHA ?? null;
  if (!rev) {
    try {
      rev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      rev = null;
    }
  }
  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      lifecycles: [{ phase: 'build' }],
      tools: { components: [{ type: 'application', name: 'blueline scripts/third-party.mjs', description: 'from esbuild\'s metafile and package-lock.json' }] },
      component: {
        type: 'application',
        'bom-ref': appRef,
        name: app.productName ?? 'Blueline',
        version: app.version,
        description: 'What ships in the app: the third-party packages bundled into its JavaScript (app.asar and resources/cli hold no node_modules), and Electron.',
        properties: [
          ...(rev ? [{ name: 'blueline:git-commit', value: rev }] : []),
          { name: 'blueline:platform', value: `${platform}-${arch}` },
          { name: 'blueline:licensing', value: 'see LICENSING.md (Apache-2.0; packages/editor FSL-1.1-ALv2)' },
        ],
      },
    },
    components,
    dependencies: [{ ref: appRef, dependsOn: components.map((c) => c['bom-ref']) }, ...components.map((c) => ({ ref: c['bom-ref'], dependsOn: [] }))],
  };
}

/** The merged metafile scripts/build.mjs wrote. */
export function readMeta() {
  if (!existsSync(META_FILE)) throw new Error(`${relative(ROOT, META_FILE)} is missing: run npm run build first`);
  return JSON.parse(readFileSync(META_FILE, 'utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (k) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : undefined);
  try {
    const packages = bundledPackages(readMeta());
    if (argv.includes('--sbom')) {
      const file = resolve(opt('--sbom') ?? 'blueline-sbom.cdx.json');
      const bom = cycloneDx(packages, { platform: opt('--platform') ?? process.platform, arch: opt('--arch') ?? process.arch });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(bom, null, 2) + '\n');
      console.log(`sbom: ${relative(process.cwd(), file).startsWith('..') ? file : relative(process.cwd(), file)}: ${bom.components.length} components (${packages.length} bundled packages and Electron ${bom.components.at(-1).version})`);
    } else if (argv.includes('--json')) {
      console.log(JSON.stringify(packages, null, 2));
    } else {
      for (const p of packages) console.log(`${p.name}@${p.version}\t${p.licence}\t${p.bundles.join(', ')}`);
      console.log(`${packages.length} third-party packages in the bundles (from ${relative(ROOT, META_FILE).split(sep).join('/')})`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
