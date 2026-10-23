#!/usr/bin/env node
// Third-party code that ships in the app (supply chain, docs/DEPENDENCIES.md).
//
// The app ships no node_modules: every package its code uses is bundled by esbuild (scripts/build.mjs), and
// app.asar holds only package.json and dist/ (scripts/package-smoke.mjs checks it). So the third-party code that
// ships is the set of node_modules files in esbuild's metafile, which scripts/build.mjs writes to
// out/esbuild-meta.json, plus the files scripts/build.mjs copies as they are (scripts/vendored.json: reveal.js for
// the Diagnostics deck). From them this module makes:
//   - bundledPackages(): each bundled package, with its version, licence, the bundles it is in and the resolved URL
//     and integrity npm installed it from (node_modules/.package-lock.json, which must agree with
//     package-lock.json). The build fails if a bundled package is not the locked one, came from anywhere else, has
//     a licence outside PERMISSIVE, or has no licence file;
//   - vendoredPackages(): each entry of scripts/vendored.json, after checking the SHA-256 of every file (the build
//     fails on a changed, missing or unlisted file, in the repository or in the build output);
//   - THIRD-PARTY-NOTICES.txt (writeNotices, called by scripts/build.mjs): the licence text of each, shipped next
//     to the bundles (in app.asar, and in resources/cli for the command's bundles);
//   - the SBOM (cycloneDx): CycloneDX 1.6 JSON listing the bundled packages, the vendored files and Electron.
//
// Command line (after `npm run build`):
//   node scripts/third-party.mjs                 the bundled packages, one per line (npm run bundled)
//   node scripts/third-party.mjs --json          the same as JSON ({ bundled, vendored })
//   node scripts/third-party.mjs --sbom <file>   write the SBOM [--platform darwin --arch arm64: Electron's zip]
//   node scripts/third-party.mjs --shipped <Resources>   check the vendored files in a packaged app's resources
//                                                folder (app.asar.unpacked/dist/...) against scripts/vendored.json
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const META_FILE = join(ROOT, 'out', 'esbuild-meta.json');
export const VENDORED_FILE = 'scripts/vendored.json';

/**
 * Licences a bundled package may have (SPDX ids; every id of an AND/OR expression must be here). They ask only
 * that the copyright and licence text travel with the code, which THIRD-PARTY-NOTICES.txt does. A package under
 * any other licence (copyleft, custom, none) fails the build until someone reviews it and adds it here.
 */
export const PERMISSIVE = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Zlib', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense']);

/**
 * Licences a vendored file may have besides PERMISSIVE: OFL-1.1 for a font embedded in a stylesheet (it asks the
 * same: the copyright and licence travel with the font, which THIRD-PARTY-NOTICES.txt does).
 */
export const VENDORED_LICENCES = new Set([...PERMISSIVE, 'OFL-1.1']);

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
  // What npm actually installed (its "hidden lockfile"). A package installed from an npm-shrinkwrap.json, a git
  // source or a mirror has the same version as the locked one but another resolved URL or integrity here.
  const hiddenFile = join(root, 'node_modules', '.package-lock.json');
  if (!existsSync(hiddenFile)) throw new Error('third-party code in the bundles: node_modules/.package-lock.json is missing (run npm ci)');
  const installed = JSON.parse(readFileSync(hiddenFile, 'utf8')).packages ?? {};
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
    const got = installed[key];
    const licence = typeof pj.license === 'string' ? pj.license : (pj.license?.type ?? null);
    const files = readdirSync(join(root, dir)).filter((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f)).sort();
    if (!locked) errors.push(`${dir}: not in package-lock.json`);
    else {
      if (locked.version !== pj.version) errors.push(`${dir}: installed ${pj.version}, but package-lock.json locks ${locked.version} (run npm ci)`);
      if (!/^sha512-/.test(locked.integrity ?? '')) errors.push(`${dir}: no sha512 integrity in package-lock.json`);
      if (!got) errors.push(`${dir}: not in node_modules/.package-lock.json: npm did not install it (run npm ci)`);
      else {
        for (const f of ['version', 'resolved', 'integrity']) {
          if (got[f] !== locked[f]) errors.push(`${dir}: npm installed it with ${f} ${got[f] ?? '(none)'}, but package-lock.json has ${locked[f] ?? '(none)'} (npm run check:installed)`);
        }
      }
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
      resolved: got?.resolved ?? null,
      integrity: got?.integrity ?? null,
      licenceFiles: files,
      homepage: typeof pj.homepage === 'string' ? pj.homepage : null,
    });
  }
  if (errors.length) throw new Error(`third-party code in the bundles:\n  ${errors.join('\n  ')}`);
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.dir.localeCompare(b.dir)));
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Every file under `dir`, as paths relative to it with / separators, sorted. */
function filesUnder(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) walk(join(d, name.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * Problems with the copy of a vendored entry in `dir`: a file that is missing, unlisted, or whose SHA-256 is not the
 * manifest's.
 */
export function vendoredProblems(entry, dir) {
  if (!existsSync(dir)) return [`${entry.name}: ${dir} is missing`];
  const problems = [];
  const listed = Object.keys(entry.files ?? {}).sort();
  const found = filesUnder(dir);
  for (const f of found) if (!listed.includes(f)) problems.push(`${entry.name}: ${join(dir, f)} is not in ${VENDORED_FILE}`);
  for (const f of listed) {
    if (!found.includes(f)) problems.push(`${entry.name}: ${join(dir, f)} is missing`);
    else if (sha256(join(dir, f)) !== entry.files[f].sha256) problems.push(`${entry.name}: ${join(dir, f)} is not the reviewed file (SHA-256 differs from ${VENDORED_FILE})`);
  }
  return problems;
}

/**
 * The vendored third-party files (scripts/vendored.json), each checked in the repository (and, with `built`, in the
 * build output too). Throws on any problem: a file changed, missing or unlisted, a licence outside
 * VENDORED_LICENCES, a licence file that is missing or changed.
 */
export function vendoredPackages(root = ROOT, { built = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, VENDORED_FILE), 'utf8'));
  const errors = [];
  const out = [];
  for (const v of manifest.vendored ?? []) {
    errors.push(...vendoredProblems(v, join(root, v.dir)));
    if (built) errors.push(...vendoredProblems(v, join(root, v.shipped)));
    for (const id of [...licenceIds(v.licence), ...(v.includes ?? []).flatMap((i) => licenceIds(i.licence))]) {
      if (!VENDORED_LICENCES.has(id)) errors.push(`${v.name}: licence ${id} is not in scripts/third-party.mjs VENDORED_LICENCES`);
    }
    if (!(v.licenceFiles ?? []).length) errors.push(`${v.name}: no licence file`);
    for (const f of v.licenceFiles ?? []) if (!v.files?.[f]) errors.push(`${v.name}: its licence file ${f} is not one of its files`);
    for (const inc of v.includes ?? []) {
      const file = join(root, inc.licenceFile?.path ?? '');
      if (!inc.licenceFile || !existsSync(file)) errors.push(`${v.name}: ${inc.name}: its licence file is missing`);
      else if (sha256(file) !== inc.licenceFile.sha256) errors.push(`${v.name}: ${inc.name}: ${inc.licenceFile.path} is not the reviewed file (SHA-256)`);
    }
    if (!/^sha512-/.test(v.integrity ?? '') || !/^https:\/\//.test(v.source ?? '')) errors.push(`${v.name}: no source URL and sha512 integrity`);
    out.push({ ...v, shippedAs: shippedName(v.shipped) });
  }
  if (errors.length) throw new Error(`vendored third-party files (${VENDORED_FILE}):\n  ${errors.join('\n  ')}`);
  return out;
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
export function noticesText(packages, { title, bundles, root = ROOT, vendored = [] }) {
  const pkgs = packages.filter((p) => p.bundles.some((b) => bundles.includes(b)));
  const rule = '='.repeat(100);
  const head = [
    `THIRD-PARTY NOTICES: ${title}`,
    '',
    `Bundles: ${bundles.map((b) => basename(b)).join(', ')}.`,
    'Generated by scripts/build.mjs from esbuild\'s metafile (scripts/third-party.mjs); do not edit.',
    'Electron and Chromium ship their own notices with the app: LICENSE.electron.txt and LICENSES.chromium.html (next to',
    'the executable on Linux and Windows, in Blueline.app/Contents/Resources on macOS).',
    '',
  ];
  if (pkgs.length === 0 && vendored.length === 0) return [...head, 'These bundles contain no third-party code.', ''].join('\n');
  if (pkgs.length) {
    head.push('These bundles contain code from the following packages:', '');
    for (const p of pkgs) head.push(`  ${p.name} ${p.version} (${p.licence}): ${p.bundles.filter((b) => bundles.includes(b)).map((b) => basename(b)).join(', ')}`);
    head.push('');
  }
  if (vendored.length) {
    head.push('These third-party files ship as they are (scripts/vendored.json):', '');
    for (const v of vendored) {
      head.push(`  ${v.name} ${v.version} (${v.licence}): ${v.shippedAs.replace(/^app\.asar\//, '')}/ (${Object.keys(v.files).join(', ')})`);
      for (const inc of v.includes ?? []) head.push(`    with ${inc.name} (${inc.licence}): ${inc.what}`);
    }
    head.push('');
  }
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
  for (const v of vendored) {
    body.push(rule, `${v.name} ${v.version}`, `License: ${v.licence}`, `Source: ${v.source}`, rule, '');
    for (const f of v.licenceFiles) body.push(readFileSync(join(root, v.dir, f), 'utf8').replace(/\r\n/g, '\n').trimEnd(), '');
    for (const inc of v.includes ?? []) {
      body.push(rule, `${inc.name} (in ${v.name} ${v.version}: ${inc.what})`, `License: ${inc.licence}`, rule, '');
      body.push(readFileSync(join(root, inc.licenceFile.path), 'utf8').replace(/\r\n/g, '\n').trimEnd(), '');
    }
  }
  return [...head, ...body].join('\n');
}

/**
 * Writes THIRD-PARTY-NOTICES.txt next to each group of bundles: packages/app/dist (app.asar) and packages/cli/dist
 * (resources/cli), with the vendored files that ship in that group. Call it after the vendored files are copied:
 * it checks them in the build output too. Returns the bundled packages.
 */
export function writeNotices(meta, root = ROOT) {
  const packages = bundledPackages(meta, root);
  const vendored = vendoredPackages(root, { built: true });
  const outputs = Object.keys(meta.outputs).filter((o) => !o.endsWith('.map') && /\.(c?js)$/.test(o)).map(shippedName);
  const groups = [
    { dir: join(root, 'packages/app/dist'), title: 'the Blueline app (app.asar)', prefix: 'app.asar/' },
    { dir: join(root, 'packages/cli/dist'), title: 'the blueline command (resources/cli)', prefix: 'cli/' },
  ].map((g) => ({ ...g, bundles: outputs.filter((b) => b.startsWith(g.prefix)) }));
  for (const g of groups) {
    mkdirSync(g.dir, { recursive: true });
    const files = vendored.filter((v) => v.shippedAs.startsWith(g.prefix));
    writeFileSync(join(g.dir, 'THIRD-PARTY-NOTICES.txt'), noticesText(packages, { title: g.title, bundles: g.bundles, root, vendored: files }));
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
export function cycloneDx(packages, { platform = process.platform, arch = process.arch, root = ROOT, commit = null, vendored = vendoredPackages(root) } = {}) {
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
  for (const v of vendored) {
    components.push({
      type: 'library',
      'bom-ref': v.purl,
      name: v.name,
      version: v.version,
      scope: 'required',
      description: `Vendored: shipped as it is in ${v.shippedAs}/ (${VENDORED_FILE}). ${v.why ?? ''}`.trim(),
      licenses: licences(v.licence),
      hashes: [{ alg: 'SHA-512', content: integrityHex(v.integrity) }],
      purl: v.purl,
      externalReferences: [{ type: 'distribution', url: v.source }, ...(v.homepage ? [{ type: 'website', url: v.homepage }] : [])],
      properties: [{ name: 'blueline:vendored', value: v.shippedAs }],
      components: [
        ...Object.entries(v.files).map(([f, info]) => ({
          type: 'file',
          'bom-ref': `${v.purl}#${f}`,
          name: `${v.shippedAs}/${f}`,
          hashes: [{ alg: 'SHA-256', content: info.sha256 }],
          properties: [{ name: 'blueline:source-path', value: `${v.name}@${v.version}/${info.from}` }],
        })),
        ...(v.includes ?? []).map((inc) => ({
          type: 'file',
          'bom-ref': `${v.purl}#${inc.name.replace(/\s+/g, '-')}`,
          name: inc.name,
          description: inc.what,
          copyright: inc.copyright,
          licenses: licences(inc.licence),
        })),
      ],
    });
  }
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
      tools: { components: [{ type: 'application', name: 'blueline scripts/third-party.mjs', description: 'from esbuild\'s metafile, node_modules/.package-lock.json and scripts/vendored.json' }] },
      component: {
        type: 'application',
        'bom-ref': appRef,
        name: app.productName ?? 'Blueline',
        version: app.version,
        description: 'What ships in the app: the third-party packages bundled into its JavaScript (app.asar and resources/cli hold no node_modules), the vendored files it ships as they are, and Electron.',
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
    if (argv.includes('--shipped')) {
      const resources = resolve(opt('--shipped'));
      const problems = vendoredPackages(ROOT).flatMap((v) => vendoredProblems(v, join(resources, 'app.asar.unpacked', relative('packages/app', v.shipped))));
      if (problems.length) throw new Error(`vendored files in ${resources}:\n  ${problems.join('\n  ')}`);
      console.log(`vendored files in ${resources}: unchanged (${VENDORED_FILE})`);
      process.exit(0);
    }
    const packages = bundledPackages(readMeta());
    const vendored = vendoredPackages(ROOT, { built: true });
    if (argv.includes('--sbom')) {
      const file = resolve(opt('--sbom') ?? 'blueline-sbom.cdx.json');
      const bom = cycloneDx(packages, { platform: opt('--platform') ?? process.platform, arch: opt('--arch') ?? process.arch, vendored });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(bom, null, 2) + '\n');
      console.log(`sbom: ${relative(process.cwd(), file).startsWith('..') ? file : relative(process.cwd(), file)}: ${bom.components.length} components (${packages.length} bundled packages, ${vendored.length} vendored and Electron ${bom.components.at(-1).version})`);
    } else if (argv.includes('--json')) {
      console.log(JSON.stringify({ bundled: packages, vendored }, null, 2));
    } else {
      for (const p of packages) console.log(`${p.name}@${p.version}\t${p.licence}\t${p.bundles.join(', ')}`);
      for (const v of vendored) console.log(`${v.name}@${v.version}\t${v.licence}\t${v.shippedAs}/ (vendored)`);
      console.log(`${packages.length} third-party packages in the bundles (from ${relative(ROOT, META_FILE).split(sep).join('/')}), ${vendored.length} vendored (${VENDORED_FILE})`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
