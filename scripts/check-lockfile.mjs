#!/usr/bin/env node
// `npm run check:lockfile`: what package-lock.json lets npm install (supply chain, docs/DEPENDENCIES.md).
// It reads only package-lock.json and the workspaces' package.json files, so it runs before `npm ci` (CI does).
//
//   1. Every package comes from the npm registry: its `resolved` is exactly the registry tarball URL for its name
//      and version (https://registry.npmjs.org/<name>/-/<name>-<version>.tgz), with a sha512 integrity. No git,
//      file, http, link or other tarball sources, no aliases. The only exceptions are the four workspace links
//      (node_modules/@blueline/* → packages/*).
//   2. Every dependency in every package.json is an exact version (no ^, ~, ranges or tags), the one the lockfile
//      resolves, so `npm install` cannot drift from it.
//   3. The packages with an install script (`hasInstallScript`) are exactly INSTALL_SCRIPTS. .npmrc turns install
//      scripts off, so none of them runs; a new one fails here so that someone looks at it before it lands (and
//      decides whether the repo needs it run explicitly, as Electron's binary is: npm run install:electron).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org/';

/**
 * Packages whose install script is known, and why the repo does not need it (none runs: .npmrc ignore-scripts).
 * Keyed by lockfile path; the value is the reason, printed with --verbose.
 */
const INSTALL_SCRIPTS = {
  // Checks (and on some systems replaces bin/esbuild with) the platform binary. Not needed: the JS API that
  // scripts/build.mjs uses finds the binary in the platform package (@esbuild/<os>-<arch>, an optional
  // dependency npm installs for the running platform) by itself.
  'node_modules/esbuild': 'esbuild: its JS API finds @esbuild/<platform> without the postinstall',
  // macOS file-watching native module, an optional dependency of vite (under vitest), for watch mode only. Its
  // script rebuilds it with node-gyp; the package ships a prebuilt fsevents.node, and `vitest run`, the builds and
  // packaging never watch files.
  'node_modules/fsevents': 'fsevents: vite watch mode only; ships a prebuilt binary (its script is node-gyp rebuild)',
  // Squirrel.Windows installer maker (via electron-builder-squirrel-windows), for electron-builder's `squirrel`
  // target. Its script picks a 7-Zip binary for the architecture. The Windows target is NSIS
  // (electron-builder.config.cjs), never Squirrel.
  'node_modules/electron-winstaller': 'electron-winstaller: Squirrel.Windows target, not used (NSIS)',
};

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const errors = [];
const verbose = process.argv.includes('--verbose');

if (lock.lockfileVersion !== 3) errors.push(`lockfileVersion is ${lock.lockfileVersion}, expected 3 (npm 9 or later)`);
const packages = lock.packages ?? {};

// The workspaces: their folders (no source) and their links in node_modules.
const workspaces = new Map(); // folder -> package name
for (const ws of rootPkg.workspaces ?? []) {
  const pj = JSON.parse(readFileSync(join(root, ws, 'package.json'), 'utf8'));
  workspaces.set(ws, pj.name);
}
const links = new Set([...workspaces].map(([folder, name]) => `node_modules/${name}`));

/** The package name a lockfile path installs (the part after its last node_modules/). */
const nameOf = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);

let registry = 0;
const withScripts = [];
for (const [key, e] of Object.entries(packages)) {
  if (key === '') continue;
  if (workspaces.has(key)) {
    if (e.resolved || e.link) errors.push(`${key}: a workspace folder must not be resolved from anywhere`);
    continue;
  }
  if (links.has(key)) {
    const folder = [...workspaces].find(([, name]) => `node_modules/${name}` === key)[0];
    if (e.link !== true || e.resolved !== folder) errors.push(`${key}: expected a link to ${folder}, found ${JSON.stringify({ link: e.link, resolved: e.resolved })}`);
    continue;
  }
  if (!key.includes('node_modules/')) {
    errors.push(`${key}: not a workspace and not under node_modules`);
    continue;
  }
  if (e.link) {
    errors.push(`${key}: a link (${e.resolved}); only the workspaces may be links`);
    continue;
  }
  const name = nameOf(key);
  if (e.name && e.name !== name) errors.push(`${key}: an alias of ${e.name}; aliases are not allowed`);
  const base = name.startsWith('@') ? name.split('/')[1] : name;
  const expected = `${REGISTRY}${name}/-/${base}-${e.version}.tgz`;
  if (typeof e.resolved !== 'string' || !e.resolved.startsWith(REGISTRY)) errors.push(`${key}: resolved from ${e.resolved ?? '(nowhere)'}, not ${REGISTRY}`);
  else if (e.resolved !== expected) errors.push(`${key}: resolved ${e.resolved}, expected ${expected}`);
  if (typeof e.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(e.integrity)) errors.push(`${key}: integrity ${e.integrity ?? '(none)'} is not one sha512`);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(e.version ?? '')) errors.push(`${key}: version ${e.version} is not a registry version`);
  if (e.hasInstallScript) withScripts.push(key);
  registry++;
}

// Install scripts: exactly the known ones.
for (const key of withScripts) {
  if (!(key in INSTALL_SCRIPTS)) errors.push(`${key}@${packages[key].version} has an install script and is not in scripts/check-lockfile.mjs INSTALL_SCRIPTS: review what it runs before adding it (docs/DEPENDENCIES.md)`);
}
for (const key of Object.keys(INSTALL_SCRIPTS)) {
  if (!withScripts.includes(key)) errors.push(`${key} is in INSTALL_SCRIPTS but has no install script in package-lock.json (any more): remove it from the list`);
}

// Exact versions in every package.json, equal to what the lockfile resolves.
const manifests = [['', rootPkg], ...[...workspaces.keys()].map((ws) => [ws, JSON.parse(readFileSync(join(root, ws, 'package.json'), 'utf8'))])];
let pinned = 0;
for (const [folder, pj] of manifests) {
  const where = folder ? `${folder}/package.json` : 'package.json';
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(pj[field] ?? {})) {
      const local = folder ? packages[`${folder}/node_modules/${name}`] : undefined;
      const locked = local ?? packages[`node_modules/${name}`];
      if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(spec)) errors.push(`${where} ${field}.${name} is "${spec}": use the exact version (save-exact, docs/DEPENDENCIES.md)`);
      else if (!locked) errors.push(`${where} ${field}.${name}@${spec} is not in package-lock.json: run npm install`);
      else if (locked.version !== spec) errors.push(`${where} ${field}.${name} is ${spec}, but package-lock.json resolves ${locked.version}`);
      pinned++;
    }
  }
}

if (errors.length) {
  console.error(`check:lockfile: ${errors.length} problem${errors.length === 1 ? '' : 's'}`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(
  `check:lockfile: ok. ${registry} packages from ${REGISTRY} with sha512 integrity; ${links.size} workspace links; ` +
    `${pinned} exact pins in ${manifests.length} package.json files; install scripts only in the ${withScripts.length} known packages (${withScripts.map(nameOf).join(', ')}), none run.`,
);
if (verbose) for (const [k, why] of Object.entries(INSTALL_SCRIPTS)) console.log(`  ${k}: ${why}`);
