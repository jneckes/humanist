#!/usr/bin/env node
// `npm run check:lockfile`: what package-lock.json lets npm install (supply chain, docs/DEPENDENCIES.md).
// It reads only package-lock.json, the package.json files, .npmrc and npm's effective configuration, so it runs
// before `npm ci` (CI does; run it yourself before `npm ci` or `npm install` on a branch you did not write).
//
//   1. npm installs from package-lock.json and nothing else: no npm-shrinkwrap.json (npm ci prefers it to
//      package-lock.json, and this check would never see it), at the root or in a workspace.
//   2. Every package comes from the npm registry: its `resolved` is exactly the registry tarball URL for its name
//      and version (https://registry.npmjs.org/<name>/-/<name>-<version>.tgz), with a sha512 integrity. No git,
//      file, http, link or other tarball sources, no aliases. The only exceptions are the four workspace links
//      (node_modules/@blueline/* → packages/*).
//   3. Every package is reached: walking the dependency graph from the package.json files (each entry's
//      dependencies, optionalDependencies and peerDependencies, resolved up the node_modules chain as Node and
//      npm resolve them) reaches every entry. npm ci installs an entry nothing depends on as well, and
//      `npm audit signatures` never looks at it.
//   4. No two packages put the same command in one node_modules/.bin, none takes a name in RESERVED_BINS, and
//      the commands the repo's scripts run (OWNED_BINS) come from their own packages: an entry declaring
//      `tsc` would otherwise run in place of TypeScript's.
//   5. Every dependency in every package.json is an exact version (no ^, ~, ranges or tags), the one the lockfile
//      resolves, so `npm install` cannot drift from it; `overrides`, at any depth, hold exact versions only.
//   6. The packages with an install script (`hasInstallScript`) are exactly INSTALL_SCRIPTS. .npmrc turns install
//      scripts off, so none of them runs; a new one fails here so that someone looks at it before it lands (and
//      decides whether the repo needs it run explicitly, as Electron's binary is: npm run install:electron). The
//      lockfile's flag is only what the lockfile claims: scripts/check-installed.mjs, after `npm ci`, checks the
//      installed packages themselves.
//   7. .npmrc holds exactly NPMRC (ignore-scripts=true, git=false, …): no registry, scoped registry,
//      replace-registry-host or other setting, and no workspace has an .npmrc of its own. npm's effective
//      configuration (`npm config ls`, which adds the user's and global npmrc and npm_config_* variables) installs
//      from the registry, with install scripts and git off.
//
// Usage: node scripts/check-lockfile.mjs [--verbose] [--root <dir>]. checkLockfile(root) is the same check as a
// function (test/unit/scripts/check-lockfile.test.ts).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY = 'https://registry.npmjs.org/';

/**
 * Packages whose install script is known, and why the repo does not need it (none runs: .npmrc ignore-scripts).
 * Keyed by lockfile path; the value is the reason, printed with --verbose.
 */
export const INSTALL_SCRIPTS = {
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

/**
 * The lines .npmrc must hold, and nothing else (comments and blank lines aside). `git=false`: npm can never run git,
 * so it cannot clone a git dependency, whose `prepare` script npm runs even with ignore-scripts=true.
 */
export const NPMRC = ['ignore-scripts=true', 'engine-strict=true', 'save-exact=true', 'git=false'];

/** Commands the repo runs from node_modules/.bin (package.json scripts, CI), and the packages that must own them. */
export const OWNED_BINS = {
  tsc: ['typescript'],
  vitest: ['vitest'],
  playwright: ['@playwright/test', 'playwright'],
  'electron-builder': ['electron-builder'],
  esbuild: ['esbuild'],
  electron: ['electron'],
};

/** Commands no package may provide: `npm run` puts node_modules/.bin first on PATH, ahead of the real ones. */
export const RESERVED_BINS = ['node', 'npm', 'npx', 'corepack', 'git', 'gh', 'sh', 'bash', 'env', 'xattr', 'codesign'];

/**
 * Commands two packages may both provide in one .bin folder: @playwright/test re-exports playwright's command
 * (both cli.js files run playwright/lib/program).
 */
export const SHARED_BINS = { 'node_modules/.bin/playwright': ['node_modules/@playwright/test', 'node_modules/playwright'] };

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** The package name a lockfile path installs (the part after its last node_modules/). */
export const nameOf = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);

/** The .bin folder (relative to the root) that npm links a package's commands into. */
export const binDirOf = (key) => `${key.slice(0, key.lastIndexOf('node_modules/') + 'node_modules'.length)}/.bin`;

/** A package.json `bin` (string or object) as { command: file }. */
export function binsOf(name, bin) {
  if (typeof bin === 'string') return { [name.replace(/^@[^/]+\//, '')]: bin };
  return bin && typeof bin === 'object' ? bin : {};
}

/**
 * Problems with the commands `packages` (each { key, name, bin }) link into .bin folders: two packages with one
 * name in a folder (SHARED_BINS aside), a RESERVED_BINS name, or an OWNED_BINS name from another package.
 */
export function binProblems(packages) {
  const errors = [];
  const byPath = new Map(); // node_modules/.bin/<command> -> [keys]
  for (const p of packages) {
    for (const command of Object.keys(binsOf(p.name, p.bin))) {
      const path = `${binDirOf(p.key)}/${command}`;
      if (!byPath.has(path)) byPath.set(path, []);
      byPath.get(path).push(p);
      if (RESERVED_BINS.includes(command)) errors.push(`${p.key} declares the command \`${command}\`, which would run in place of the system's (RESERVED_BINS)`);
      const owners = OWNED_BINS[command];
      if (owners && binDirOf(p.key) === 'node_modules/.bin' && !owners.includes(p.name)) {
        errors.push(`${p.key} declares the command \`${command}\`, which the repo runs from ${owners.join(' or ')} (OWNED_BINS)`);
      }
    }
  }
  for (const [path, ps] of byPath) {
    if (ps.length < 2) continue;
    const keys = ps.map((p) => p.key).sort();
    const shared = SHARED_BINS[path];
    if (shared && keys.length === shared.length && keys.every((k, i) => k === [...shared].sort()[i])) continue;
    errors.push(`${path} is declared by ${keys.join(' and ')}: one would replace the other's command`);
  }
  return errors;
}

/** The lockfile key `name` resolves to from the lockfile key `from`, looking up the node_modules chain as Node does. */
export function resolveFrom(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const i = base.lastIndexOf('/node_modules/');
    base = i >= 0 ? base.slice(0, i) : '';
  }
}

/**
 * The lockfile keys reached from the root and the workspaces (`workspaces`: folder → package.json), following the
 * manifests' dependencies, devDependencies, optionalDependencies and peerDependencies, then each entry's
 * dependencies, optionalDependencies and peerDependencies. npm links every workspace into node_modules, so the
 * workspace folders and links are reached. `enter(key)` false keeps the walk out of an entry (check-installed.mjs:
 * an optional package for another platform, which npm skips). Returns { reached, missing } (edges with no entry).
 */
export function reach(packages, rootPkg, workspaces, { enter = () => true } = {}) {
  const reached = new Set();
  const missing = [];
  const queue = [];
  const visit = (key) => {
    if (reached.has(key) || !enter(key)) return;
    reached.add(key);
    queue.push(key);
  };
  const edges = (key) => {
    const manifest = key === '' ? rootPkg : workspaces.get(key);
    const src = manifest ?? packages[key] ?? {};
    const fields = manifest ? DEP_FIELDS : ['dependencies', 'optionalDependencies', 'peerDependencies'];
    return fields.flatMap((field) => Object.keys(src[field] ?? {}).map((name) => ({ name, field, optional: field === 'optionalDependencies' || field === 'peerDependencies' })));
  };
  visit('');
  for (const [folder, pj] of workspaces) {
    visit(folder);
    if (packages[`node_modules/${pj.name}`]) visit(`node_modules/${pj.name}`);
  }
  while (queue.length) {
    const key = queue.shift();
    for (const { name, field, optional } of edges(key)) {
      const to = resolveFrom(packages, key, name);
      if (!to) {
        missing.push({ from: key, field, name, optional });
        continue;
      }
      visit(to);
      if (packages[to].link && workspaces.has(packages[to].resolved)) visit(packages[to].resolved);
    }
  }
  return { reached, missing };
}

/** Problems with `overrides` (any depth): every value must be an exact registry version. */
function overrideProblems(where, value, path = 'overrides') {
  if (value === undefined) return [];
  if (typeof value === 'string') return EXACT.test(value) ? [] : [`${where} ${path} is "${value}": overrides must be exact registry versions`];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${where} ${path} is not a version or an object`];
  return Object.entries(value).flatMap(([k, v]) => overrideProblems(where, v, `${path}.${k}`));
}

/** The .npmrc lines that matter (comments, blank lines and spacing around = dropped). */
export function npmrcLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith(';'))
    .map((l) => l.replace(/\s*=\s*/, '='));
}

/** npm's effective configuration in `root` (`npm config ls --json`), or null when npm cannot be run. */
function effectiveNpmConfig(root) {
  const args = ['config', 'ls', '--json'];
  const r = process.env.npm_execpath && /\.c?js$/.test(process.env.npm_execpath)
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, encoding: 'utf8' })
    : spawnSync('npm', args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** Problems with npm's effective configuration (`npm config ls --json`). */
export function configProblems(config) {
  if (!config) return ['could not read npm\'s configuration (npm config ls --json)'];
  const errors = [];
  if (config.registry !== REGISTRY) errors.push(`npm's registry is ${config.registry}, not ${REGISTRY} (a user or global npmrc, or npm_config_registry?)`);
  for (const k of Object.keys(config)) if (/^@.*:registry$/.test(k)) errors.push(`npm's configuration sets ${k}=${config[k]}: no scoped registries`);
  if (config['ignore-scripts'] !== true) errors.push(`npm's ignore-scripts is ${config['ignore-scripts']}, not true`);
  if (String(config.git) !== 'false') errors.push(`npm's git is ${JSON.stringify(config.git)}, not "false": npm could clone git dependencies and run their prepare scripts`);
  if (config['replace-registry-host'] !== 'npmjs') errors.push(`npm's replace-registry-host is ${config['replace-registry-host']}, not npmjs`);
  return errors;
}

/**
 * Checks package-lock.json, the package.json files and .npmrc in `root`. Returns { errors, summary }.
 * `npmConfig: false` skips npm's effective configuration (the unit tests check copies without running npm).
 */
export function checkLockfile(root = ROOT, { npmConfig = true } = {}) {
  const errors = [];
  const read = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
  const lock = read('package-lock.json');
  const rootPkg = read('package.json');

  // 1. Only package-lock.json.
  if (lock.lockfileVersion !== 3) errors.push(`lockfileVersion is ${lock.lockfileVersion}, expected 3 (npm 9 or later)`);
  const packages = lock.packages ?? {};

  // The workspaces: their folders (no source) and their links in node_modules.
  const workspaces = new Map(); // folder -> package.json
  for (const ws of rootPkg.workspaces ?? []) {
    const abs = resolve(root, ws);
    if (typeof ws !== 'string' || isAbsolute(ws) || ws.split(/[\\/]/).includes('..') || !abs.startsWith(resolve(root) + sep)) {
      errors.push(`package.json workspaces: "${ws}" is not a folder inside the repository`);
      continue;
    }
    if (!existsSync(join(abs, 'package.json'))) {
      errors.push(`package.json workspaces: ${ws} has no package.json`);
      continue;
    }
    workspaces.set(ws, read(join(ws, 'package.json')));
  }
  for (const folder of ['', ...workspaces.keys()]) {
    const where = folder || 'the repository root';
    if (existsSync(join(root, folder, 'npm-shrinkwrap.json'))) errors.push(`${folder ? `${folder}/` : ''}npm-shrinkwrap.json exists in ${where}: npm ci would install from it instead of package-lock.json; delete it`);
    if (folder && existsSync(join(root, folder, '.npmrc'))) errors.push(`${folder}/.npmrc exists: npm settings belong in the root .npmrc only`);
  }
  const links = new Map([...workspaces].map(([folder, pj]) => [`node_modules/${pj.name}`, folder]));

  // 2. Registry sources.
  let registry = 0;
  const withScripts = [];
  const installed = []; // { key, name, bin } for the bin check
  for (const [key, e] of Object.entries(packages)) {
    if (key === '') continue;
    if (workspaces.has(key)) {
      if (e.resolved || e.link) errors.push(`${key}: a workspace folder must not be resolved from anywhere`);
      continue;
    }
    if (links.has(key)) {
      const folder = links.get(key);
      if (e.link !== true || e.resolved !== folder) errors.push(`${key}: expected a link to ${folder}, found ${JSON.stringify({ link: e.link, resolved: e.resolved })}`);
      continue;
    }
    if (!key.includes('node_modules/') || key.split('/').includes('..')) {
      errors.push(`${key}: not a workspace and not under node_modules`);
      continue;
    }
    if (e.link) {
      errors.push(`${key}: a link (${e.resolved}); only the workspaces may be links`);
      continue;
    }
    const name = nameOf(key);
    if (e.name && e.name !== name) errors.push(`${key}: an alias of ${e.name}; aliases are not allowed`);
    if (e.inBundle) errors.push(`${key}: bundled inside another package's tarball (inBundle); every package must come from its own registry tarball`);
    const base = name.startsWith('@') ? name.split('/')[1] : name;
    const expected = `${REGISTRY}${name}/-/${base}-${e.version}.tgz`;
    if (typeof e.resolved !== 'string' || !e.resolved.startsWith(REGISTRY)) errors.push(`${key}: resolved from ${e.resolved ?? '(nowhere)'}, not ${REGISTRY}`);
    else if (e.resolved !== expected) errors.push(`${key}: resolved ${e.resolved}, expected ${expected}`);
    if (typeof e.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(e.integrity)) errors.push(`${key}: integrity ${e.integrity ?? '(none)'} is not one sha512`);
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(e.version ?? '')) errors.push(`${key}: version ${e.version} is not a registry version`);
    if (e.hasInstallScript) withScripts.push(key);
    installed.push({ key, name, bin: e.bin });
    registry++;
  }

  // 3. Every entry reached from the package.json files.
  const manifests = [['', rootPkg], ...workspaces];
  for (const [folder, pj] of manifests) {
    // The lockfile's copy of each manifest's dependencies must be the manifest's (npm ci refuses otherwise).
    const entry = packages[folder];
    if (!entry) {
      errors.push(`package-lock.json has no entry for ${folder || 'the root'}`);
      continue;
    }
    for (const field of DEP_FIELDS) {
      const a = JSON.stringify(Object.entries(pj[field] ?? {}).sort());
      const b = JSON.stringify(Object.entries(entry[field] ?? {}).sort());
      if (a !== b) errors.push(`package-lock.json ${folder || 'root'} ${field} differ from ${folder ? `${folder}/` : ''}package.json: run npm install`);
    }
  }
  const { reached, missing } = reach(packages, rootPkg, workspaces);
  for (const m of missing) if (!m.optional) errors.push(`${m.from || 'package.json'} ${m.field}.${m.name} is not in package-lock.json`);
  const orphans = Object.keys(packages).filter((k) => !reached.has(k));
  for (const key of orphans) errors.push(`${key}@${packages[key].version}: nothing depends on it, but npm ci would install it (and its commands); remove it`);

  // 4. Commands.
  for (const [folder, pj] of workspaces) installed.push({ key: `node_modules/${pj.name}`, name: pj.name, bin: pj.bin, folder });
  errors.push(...binProblems(installed));

  // 5. Exact versions in every package.json, equal to what the lockfile resolves; exact overrides.
  let pinned = 0;
  for (const [folder, pj] of manifests) {
    const where = folder ? `${folder}/package.json` : 'package.json';
    for (const field of DEP_FIELDS) {
      for (const [name, spec] of Object.entries(pj[field] ?? {})) {
        const local = folder ? packages[`${folder}/node_modules/${name}`] : undefined;
        const locked = local ?? packages[`node_modules/${name}`];
        if (!EXACT.test(spec)) errors.push(`${where} ${field}.${name} is "${spec}": use the exact version (save-exact, docs/DEPENDENCIES.md)`);
        else if (!locked) errors.push(`${where} ${field}.${name}@${spec} is not in package-lock.json: run npm install`);
        else if (locked.version !== spec) errors.push(`${where} ${field}.${name} is ${spec}, but package-lock.json resolves ${locked.version}`);
        pinned++;
      }
    }
    errors.push(...overrideProblems(where, pj.overrides));
    for (const field of ['bundleDependencies', 'bundledDependencies']) {
      if (pj[field] !== undefined) errors.push(`${where} ${field}: no package ships its node_modules (docs/DEPENDENCIES.md)`);
    }
  }
  errors.push(...overrideProblems('package-lock.json root', packages['']?.overrides));

  // 6. Install scripts: exactly the known ones.
  for (const key of withScripts) {
    if (!(key in INSTALL_SCRIPTS)) errors.push(`${key}@${packages[key].version} has an install script and is not in scripts/check-lockfile.mjs INSTALL_SCRIPTS: review what it runs before adding it (docs/DEPENDENCIES.md)`);
  }
  for (const key of Object.keys(INSTALL_SCRIPTS)) {
    if (!withScripts.includes(key)) errors.push(`${key} is in INSTALL_SCRIPTS but has no install script in package-lock.json (any more): remove it from the list`);
  }

  // 7. .npmrc and npm's configuration.
  const npmrcFile = join(root, '.npmrc');
  const lines = existsSync(npmrcFile) ? npmrcLines(readFileSync(npmrcFile, 'utf8')) : [];
  for (const l of lines) if (!NPMRC.includes(l)) errors.push(`.npmrc: "${l}" is not allowed (only ${NPMRC.join(', ')}; scripts/check-lockfile.mjs NPMRC)`);
  for (const l of NPMRC) if (!lines.includes(l)) errors.push(`.npmrc: "${l}" is missing`);
  if (npmConfig) errors.push(...configProblems(effectiveNpmConfig(root)));

  const summary =
    `${registry} packages from ${REGISTRY} with sha512 integrity, every one reached from the package.json files; ` +
    `${links.size} workspace links; ${pinned} exact pins in ${manifests.length} package.json files; ` +
    `install scripts only in the ${withScripts.length} known packages (${withScripts.map(nameOf).join(', ')}), none run; ` +
    `.npmrc: ${NPMRC.join(', ')}.`;
  return { errors, summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const root = argv.includes('--root') ? resolve(argv[argv.indexOf('--root') + 1]) : ROOT;
  let result;
  try {
    result = checkLockfile(root);
  } catch (e) {
    console.error(`check:lockfile: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (result.errors.length) {
    console.error(`check:lockfile: ${result.errors.length} problem${result.errors.length === 1 ? '' : 's'}`);
    for (const e of result.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log(`check:lockfile: ok. ${result.summary}`);
  if (argv.includes('--verbose')) for (const [k, why] of Object.entries(INSTALL_SCRIPTS)) console.log(`  ${k}: ${why}`);
  if (relative(ROOT, root)) console.log(`  (checked ${root})`);
}
