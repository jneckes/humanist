#!/usr/bin/env node
// `npm run check:installed`, after `npm ci`: what npm actually installed (supply chain, docs/DEPENDENCIES.md).
// scripts/check-lockfile.mjs checks package-lock.json before anything is installed; this checks the result, which
// is what runs. CI runs it after `npm ci`, and scripts/package-smoke.mjs before it packs.
//
//   1. node_modules/.package-lock.json (npm's record of what it installed: the "hidden lockfile") has exactly the
//      entries package-lock.json has for this platform (an optional package for another OS, CPU or libc is
//      skipped, as npm skips it), each with the same version, resolved URL and integrity. A package that came
//      from anywhere else (an npm-shrinkwrap.json, a git source, a mirror) differs here.
//   2. node_modules on disk holds exactly those packages: each folder's package.json has the locked name and
//      version, and the only links are the workspaces'.
//   3. The installed packages with an install script (preinstall, install or postinstall in their package.json, or
//      a binding.gyp that npm would build) are in INSTALL_SCRIPTS, whatever the lockfile's hasInstallScript flag
//      says (npm reads the scripts from the package, not from the flag). None ran: .npmrc ignore-scripts. A
//      `prepare` script is not counted: npm runs it only for git and folder sources, and (1) rules those out.
//   4. The commands the packages link into node_modules/.bin folders collide with nothing (check-lockfile.mjs
//      binProblems, on the installed package.json files), and every .bin entry is a command an installed package
//      declares.
//
// Usage: node scripts/check-installed.mjs [--root <dir>]. checkInstalled(root) is the same check as a function.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_SCRIPTS, ROOT, binProblems, binsOf, nameOf, reach } from './check-lockfile.mjs';

/** glibc or musl on Linux (as npm decides an optional package's `libc`), null elsewhere. */
export function currentLibc() {
  if (process.platform !== 'linux') return null;
  const header = /** @type {any} */ (process.report?.getReport?.())?.header;
  return header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

/** Whether a package.json os/cpu/libc list (entries may be negated with !) allows `value`. */
function allows(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (list.includes(`!${value}`)) return false;
  const positive = list.filter((v) => !v.startsWith('!'));
  return positive.length === 0 || positive.includes(value);
}

/** Whether npm skips the lockfile entry `e` on this platform: an optional package for another OS, CPU or libc. */
export function skippedHere(e, { platform = process.platform, arch = process.arch, libc = currentLibc() } = {}) {
  if (!e || !(e.optional || e.devOptional)) return false;
  return !allows(e.os, platform) || !allows(e.cpu, arch) || (libc !== null && !allows(e.libc, libc));
}

/** A package's install scripts as npm would run them: preinstall, install, postinstall, or `node-gyp rebuild`. */
export function installScriptsOf(pj, dir) {
  const s = pj.scripts ?? {};
  const out = ['preinstall', 'install', 'postinstall'].filter((k) => typeof s[k] === 'string' && s[k].trim());
  if (!s.install && !s.preinstall && pj.gypfile !== false && existsSync(join(dir, 'binding.gyp'))) out.push('install (binding.gyp: node-gyp rebuild)');
  return out;
}

/** A package's commands, as npm links them: `bin`, or every file in `directories.bin`. */
function commandsOf(pj, dir) {
  if (pj.bin) return binsOf(pj.name, pj.bin);
  const d = pj.directories?.bin;
  if (typeof d !== 'string') return {};
  const abs = join(dir, d);
  if (!existsSync(abs)) return {};
  return Object.fromEntries(readdirSync(abs).map((f) => [f, `${d}/${f}`]));
}

const toKey = (root, abs) => relative(root, abs).split(sep).join('/');

/**
 * Every package folder under the node_modules folders of `root` and the workspaces, recursively:
 * { key, abs, link } (link: a symbolic link; its folder is not entered). Dot entries (.bin, .package-lock.json,
 * caches) are skipped; a non-dot entry that is not a package is returned with notPackage.
 */
function packageFolders(root, folders) {
  const out = [];
  const walk = (nm) => {
    if (!existsSync(nm)) return;
    for (const name of readdirSync(nm)) {
      if (name.startsWith('.')) continue;
      const abs = join(nm, name);
      if (name.startsWith('@') && !lstatSync(abs).isSymbolicLink() && lstatSync(abs).isDirectory()) {
        for (const sub of readdirSync(abs)) entry(join(abs, sub));
      } else entry(abs);
    }
  };
  const entry = (abs) => {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return out.push({ key: toKey(root, abs), abs, link: true });
    if (!st.isDirectory() || !existsSync(join(abs, 'package.json'))) return out.push({ key: toKey(root, abs), abs, notPackage: true });
    out.push({ key: toKey(root, abs), abs });
    walk(join(abs, 'node_modules'));
  };
  for (const f of folders) walk(join(root, f, 'node_modules'));
  return out;
}

/** Checks what is installed in `root` against its package-lock.json. Returns { errors, summary }. */
export function checkInstalled(root = ROOT, platformOpts = {}) {
  const errors = [];
  const read = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
  const lockFile = read('package-lock.json');
  const lock = lockFile.packages ?? {};
  const rootPkg = read('package.json');
  const workspaces = new Map((rootPkg.workspaces ?? []).map((ws) => [ws, read(join(ws, 'package.json'))]));
  const hiddenFile = join(root, 'node_modules', '.package-lock.json');
  if (!existsSync(hiddenFile)) return { errors: ['node_modules/.package-lock.json is missing: run npm ci'], summary: '' };
  const hidden = JSON.parse(readFileSync(hiddenFile, 'utf8')).packages ?? {};

  // 1. The hidden lockfile against package-lock.json, for this platform.
  const { reached } = reach(lock, rootPkg, workspaces, { enter: (k) => !skippedHere(lock[k], platformOpts) });
  reached.delete('');
  // Not reached: the optional packages for other platforms, and what only they depend on.
  const skipped = Object.keys(lock).filter((k) => k && !reached.has(k));
  for (const k of reached) {
    if (!(k in hidden)) errors.push(`${k}@${lock[k].version}: in package-lock.json but not in node_modules/.package-lock.json: not installed`);
  }
  for (const [k, h] of Object.entries(hidden)) {
    const l = lock[k];
    if (!l) {
      errors.push(`${k}: installed (node_modules/.package-lock.json: ${h.resolved ?? h.version}), but package-lock.json has no such entry`);
      continue;
    }
    if (!reached.has(k)) errors.push(`${k}: installed, but on ${platformOpts.platform ?? process.platform}-${platformOpts.arch ?? process.arch} npm should have skipped it`);
    for (const f of ['version', 'resolved', 'integrity', 'link']) {
      if (h[f] !== l[f]) errors.push(`${k}: installed with ${f} ${JSON.stringify(h[f])}, but package-lock.json has ${JSON.stringify(l[f])}`);
    }
  }

  // 2. node_modules on disk.
  const links = new Map([...workspaces].map(([folder, pj]) => [`node_modules/${pj.name}`, folder]));
  const folders = packageFolders(root, ['', ...workspaces.keys()]);
  const onDisk = new Set();
  const packages = []; // { key, name, bin } for the commands
  const withScripts = [];
  for (const f of folders) {
    onDisk.add(f.key);
    if (f.notPackage) {
      errors.push(`${f.key}: in node_modules but not a package`);
      continue;
    }
    if (f.link) {
      const folder = links.get(f.key);
      let target = null;
      try {
        target = realpathSync(f.abs);
      } catch {}
      if (!folder || target !== realpathSync(join(root, folder))) errors.push(`${f.key}: a link to ${target ?? '(nothing)'}; only the workspace links (node_modules/@blueline/*) may be links`);
      continue;
    }
    const pj = JSON.parse(readFileSync(join(f.abs, 'package.json'), 'utf8'));
    const l = lock[f.key];
    if (!l || !(f.key in hidden)) errors.push(`${f.key}: on disk, but not a package npm installed from package-lock.json`);
    else {
      if (pj.name !== nameOf(f.key)) errors.push(`${f.key}: its package.json is named ${pj.name}`);
      if (pj.version !== l.version) errors.push(`${f.key}: its package.json is version ${pj.version}, package-lock.json locks ${l.version}`);
    }
    const scripts = installScriptsOf(pj, f.abs);
    if (scripts.length) withScripts.push({ key: f.key, scripts, flagged: !!l?.hasInstallScript });
    packages.push({ key: f.key, name: pj.name, bin: commandsOf(pj, f.abs) });
  }
  for (const k of Object.keys(hidden)) {
    if (!workspaces.has(k) && !onDisk.has(k)) errors.push(`${k}: in node_modules/.package-lock.json but not on disk`);
  }

  // 3. Install scripts of the installed packages.
  for (const s of withScripts) {
    if (!(s.key in INSTALL_SCRIPTS)) {
      errors.push(`${s.key} has an install script (${s.scripts.join(', ')}) and is not in scripts/check-lockfile.mjs INSTALL_SCRIPTS${s.flagged ? '' : ' (package-lock.json does not flag it: hasInstallScript is missing)'}`);
    }
  }

  // 4. Commands: no collisions, and every .bin entry declared by a package of its folder.
  for (const [folder, pj] of workspaces) packages.push({ key: `node_modules/${pj.name}`, name: pj.name, bin: commandsOf(pj, join(root, folder)) });
  errors.push(...binProblems(packages));
  const declared = new Set(packages.flatMap((p) => Object.keys(p.bin).map((c) => `${p.key.slice(0, p.key.lastIndexOf('node_modules/') + 'node_modules'.length)}/.bin/${c}`)));
  const binDirs = new Set(['node_modules', ...[...workspaces.keys()].map((w) => `${w}/node_modules`), ...packages.map((p) => `${p.key}/node_modules`)]);
  let commands = 0;
  for (const d of binDirs) {
    const abs = join(root, d, '.bin');
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      const command = process.platform === 'win32' ? f.replace(/\.(cmd|ps1)$/i, '') : f;
      if (!declared.has(`${d}/.bin/${command}`)) errors.push(`${d}/.bin/${f}: no installed package declares this command`);
      else commands++;
    }
  }

  const summary =
    `${Object.keys(hidden).length - workspaces.size - links.size} packages installed, each the registry tarball package-lock.json locks ` +
    `(node_modules/.package-lock.json: same entries, versions, resolved URLs and integrity); ${skipped.length} optional packages for other platforms skipped; ` +
    `install scripts only in ${withScripts.map((s) => nameOf(s.key)).join(', ') || 'none'} (not run: ignore-scripts); ${commands} commands in .bin folders, no collisions.`;
  return { errors, summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const root = argv.includes('--root') ? resolve(argv[argv.indexOf('--root') + 1]) : ROOT;
  let result;
  try {
    result = checkInstalled(root);
  } catch (e) {
    console.error(`check:installed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (result.errors.length) {
    console.error(`check:installed: ${result.errors.length} problem${result.errors.length === 1 ? '' : 's'}`);
    for (const e of result.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log(`check:installed: ok. ${result.summary}`);
  if (relative(ROOT, root)) console.log(`  (checked ${root})`);
}
