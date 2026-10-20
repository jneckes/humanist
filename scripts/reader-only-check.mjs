#!/usr/bin/env node
// The reader-only gate (P2-15; SPEC 10 Phase 2 "Reader-only build. `build:reader-only` builds and passes the reader
// test suite with packages/editor removed"; 9.6 "Read and Review must build and run with packages/editor removed").
//
//   npm run test:reader-only
//   node scripts/reader-only-check.mjs [--steps build,bundles,tsc,vitest,map,e2e,security] [--workers n]
//                                      [--dir <copy>] [--keep]
//
// What it does, in a copy of the tree that has no packages/editor, so the shared packages/app/dist is never touched:
//   1. copy:     the working tree without .git, node_modules, any dist, test-results, fixtures/local and
//                packages/editor, into a fresh folder outside the repository (default: `.<repo>-reader-only` next
//                to it), readable by the user the E2E suites run the app as (bltest);
//   2. modules:  node_modules without network. The copy gets a node_modules folder of its own whose entries are
//                symbolic links to the repository's installed packages, except @blueline, which is a folder of its
//                own linking app, cli and core to the copy's packages: there is no @blueline/editor anywhere the
//                copy can resolve it (the copy lives outside the repository, so Node's upward search never reaches
//                the repository's node_modules), and this is checked before anything runs;
//   3. build:    `node scripts/build.mjs --reader-only` in the copy (its own packages/app/dist and packages/cli/dist);
//   4. bundles:  no editor.cjs, no source map that names an editor or magic-string source, and no bundle that holds
//                the editor's own functions (planEdit, verifyEdit, planUndo, makeRecord, MagicString);
//   5. tsc:      `tsc -p tsconfig.reader.json` (every package but the editor, every test but the editor's);
//   6. vitest:   `vitest run -c vitest.reader.config.ts` (the unit suite without the editor's tests, with the fuzz
//                harness's own unit tests);
//   7. map:      the reader-only CLI maps a fixture and says the probe did not run because the build is reader-only;
//   8. e2e:      Playwright's E2E suite with `--grep-invert @edit` against the copy's build;
//   9. security: the security suite with `--grep-invert @edit` against the copy's build.
// Exit 0 when every step passed, 1 when one failed, 2 on a usage error. The copy is removed unless --keep.

import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALL_STEPS = ['build', 'bundles', 'tsc', 'vitest', 'map', 'e2e', 'security'];

/** Names never copied, at any depth. */
const SKIP_NAMES = new Set(['.git', 'node_modules', 'test-results', 'playwright-report', 'coverage', '.DS_Store']);
/** Paths (relative to the repository) never copied: the editor, Josh's decks, build output. */
const SKIP_PATHS = ['packages/editor', 'fixtures/local', 'packages/app/dist', 'packages/cli/dist', 'out', 'release', '.blueline'];
/** node_modules entries the copy makes for itself instead of linking (caches a run writes into). */
const OWN_MODULE_ENTRIES = new Set(['@blueline', '.vite', '.vitest', '.cache']);
/** Functions only packages/editor defines: a reader bundle that holds one carries editor code. */
const EDITOR_MARKERS = ['function planEdit', 'function verifyEdit', 'function planUndo', 'function makeRecord', 'MagicString'];

function usage(msg) {
  if (msg) console.error(`reader-only: ${msg}`);
  console.error('usage: node scripts/reader-only-check.mjs [--steps build,bundles,tsc,vitest,map,e2e,security] [--workers n] [--dir <copy>] [--keep]');
  process.exit(2);
}

function parseArgs(argv) {
  const o = { steps: ALL_STEPS.slice(), workers: null, dir: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i] ?? usage(`${a} needs a value`);
    if (a === '--steps') {
      o.steps = val().split(',').map((s) => s.trim()).filter(Boolean);
      for (const s of o.steps) if (!ALL_STEPS.includes(s)) usage(`unknown step ${s}`);
    } else if (a === '--workers') o.workers = Number(val());
    else if (a === '--dir') o.dir = resolve(val());
    else if (a === '--keep') o.keep = true;
    else if (a === '-h' || a === '--help') usage();
    else usage(`unknown argument ${a}`);
  }
  return o;
}

function say(msg) {
  console.error(`[reader-only] ${msg}`);
}

/** Runs a command in the copy, its output passed through; resolves to the exit status. */
function run(cmd, args, cwd, env = {}) {
  say(`$ ${[cmd, ...args].map((x) => (x.includes(' ') ? JSON.stringify(x) : x)).join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.error) say(`could not run ${cmd}: ${r.error.message}`);
  return r.status ?? 1;
}

// ------------------------------------------------------------------------------------------- the copy

/**
 * Where the copy goes: next to the repository (`.<name>-reader-only`), outside it, so Node's upward module search
 * never reaches the repository's node_modules, and not under a temporary folder, which some unit tests rely on
 * (Settings › Trust refuses every temporary folder as a trusted folder, test/unit/app/folders.test.ts). When the
 * repository's parent cannot be written, the OS temp folder.
 */
function defaultCopyDir() {
  const sibling = join(dirname(ROOT), `.${basename(ROOT)}-reader-only`);
  try {
    mkdirSync(sibling, { recursive: true });
    return sibling;
  } catch {
    say(`cannot write ${dirname(ROOT)}: the copy goes to the temp folder, where tests that refuse temporary folders may fail`);
    return mkdtempSync(join(tmpdir(), 'bl-reader-only-'));
  }
}

function copyTree(dest) {
  const skip = SKIP_PATHS.map((p) => join(ROOT, p));
  cpSync(ROOT, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      if (src === ROOT) return true;
      const name = basename(src);
      if (SKIP_NAMES.has(name)) return false;
      if (skip.some((p) => src === p || src.startsWith(p + sep))) return false;
      // Leftovers of map runs and atomic writes, wherever they are.
      if (/\.bl-probe\.html$/.test(name) || /^\.bl-write-.*\.tmp$/.test(name)) return false;
      return true;
    },
  });
}

/** node_modules for the copy: links to the installed packages, and an @blueline of the copy's own packages only. */
function linkModules(dest) {
  const from = join(ROOT, 'node_modules');
  const to = join(dest, 'node_modules');
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (OWN_MODULE_ENTRIES.has(name)) continue;
    symlinkSync(join(from, name), join(to, name));
  }
  const scope = join(to, '@blueline');
  mkdirSync(scope, { recursive: true });
  for (const pkg of readdirSync(join(dest, 'packages'))) {
    if (pkg === 'editor') continue;
    if (!existsSync(join(dest, 'packages', pkg, 'package.json'))) continue;
    symlinkSync(join('..', '..', 'packages', pkg), join(scope, pkg));
  }
}

/** Every folder of the copy readable and searchable by others (the E2E suites run the app as bltest). */
function openUp(dir) {
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) openUp(p);
    else if ((st.mode & 0o044) !== 0o044) chmodSync(p, st.mode | 0o044);
  }
}

/** The copy has no editor anywhere it can resolve one. */
function checkIsolation(dest) {
  const problems = [];
  if (existsSync(join(dest, 'packages/editor'))) problems.push('packages/editor exists in the copy');
  const probe = spawnSync(process.execPath, ['-e', "try { require.resolve('@blueline/editor'); console.log('resolved: ' + require.resolve('@blueline/editor')); process.exit(1) } catch { process.exit(0) }"], { cwd: dest, encoding: 'utf8' });
  if (probe.status !== 0) problems.push(`@blueline/editor resolves from the copy (${probe.stdout.trim()})`);
  for (let d = dirname(dest); ; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules', '@blueline', 'editor'))) problems.push(`${join(d, 'node_modules/@blueline/editor')} is reachable from the copy`);
    if (dirname(d) === d) break;
  }
  return problems;
}

// ------------------------------------------------------------------------------------------- steps

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

/** Step 4: the reader-only bundles carry no editor code. */
function checkBundles(dest) {
  const problems = [];
  const files = [...walkFiles(join(dest, 'packages/app/dist')), ...walkFiles(join(dest, 'packages/cli/dist'))];
  if (files.length === 0) return ['no bundles were built'];
  for (const f of files) {
    const rel = relative(dest, f);
    if (/(^|\/)editor\.cjs(\.map)?$/.test(rel) || /blueline-editor/.test(rel)) problems.push(`${rel} exists`);
    if (rel.endsWith('.map')) {
      let sources = [];
      try {
        sources = JSON.parse(readFileSync(f, 'utf8')).sources ?? [];
      } catch {
        problems.push(`${rel} is not a source map`);
      }
      for (const s of sources) if (/(^|\/)editor\/src\//.test(s) || /node_modules\/magic-string\//.test(s)) problems.push(`${rel} names ${s}`);
    } else if (/\.(c?js|mjs)$/.test(rel)) {
      const text = readFileSync(f, 'utf8');
      for (const m of EDITOR_MARKERS) if (text.includes(m)) problems.push(`${rel} holds ${m}`);
    }
  }
  return problems;
}

/** Step 7: the reader-only CLI maps a fixture, and says the probe did not run because the build is reader-only. */
function checkMap(dest) {
  const ud = mkdtempSync(join(tmpdir(), 'bl-reader-ud-'));
  try {
    const cli = join(dest, 'packages/cli/dist/blueline.cjs');
    const deck = join(dest, 'fixtures/decks/single.html');
    say(`$ blueline map ${relative(dest, deck)} --json (the copy's CLI)`);
    const r = spawnSync(process.execPath, [cli, 'map', deck, '--json'], { cwd: dest, encoding: 'utf8', env: { ...process.env, BLUELINE_USER_DATA: ud }, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return [`blueline map exited ${r.status}: ${(r.stderr ?? '').slice(-1000)}`];
    const j = JSON.parse(r.stdout);
    const problems = [];
    if (j.report?.probe?.ran !== false) problems.push('the probe ran in a reader-only build');
    if (!String(j.report?.probe?.why ?? '').includes('reader-only build')) problems.push(`the report does not say why the probe did not run (${j.report?.probe?.why})`);
    if (j.report?.coverage?.verified !== false) problems.push('the coverage is reported as verified');
    return problems;
  } catch (e) {
    return [`blueline map: ${e instanceof Error ? e.message : String(e)}`];
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------- main

function main() {
  const o = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const dest = o.dir ?? defaultCopyDir();
  if (dest === ROOT || dest.startsWith(ROOT + sep)) usage('--dir must be outside the repository (Node would find the repository\'s node_modules, editor included)');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const results = [];
  const step = (name, fn) => {
    const ts = Date.now();
    say(`== ${name}`);
    let problems;
    try {
      problems = fn();
    } catch (e) {
      problems = [e instanceof Error ? e.message : String(e)];
    }
    const ok = problems.length === 0;
    results.push({ name, ok, ms: Date.now() - ts, problems });
    for (const p of problems) say(`${name}: ${p}`);
    say(`== ${name}: ${ok ? 'pass' : 'FAIL'} (${Math.round((Date.now() - ts) / 1000)} s)`);
    return ok;
  };
  try {
    say(`copy: ${dest}`);
    const fine = step('copy', () => {
      copyTree(dest);
      linkModules(dest);
      openUp(dest);
      return checkIsolation(dest);
    });
    if (fine) {
      const bin = (n) => join(dest, 'node_modules/.bin', n);
      const workers = o.workers ? ['--workers', String(o.workers)] : [];
      let built = true;
      for (const s of o.steps) {
        if (!built && s !== 'tsc' && s !== 'vitest') {
          results.push({ name: s, ok: false, ms: 0, problems: ['not run: the reader-only build failed'] });
          continue;
        }
        if (s === 'build') built = step('build', () => (run(process.execPath, ['scripts/build.mjs', '--reader-only'], dest) === 0 ? [] : ['build:reader-only failed']));
        else if (s === 'bundles') step('bundles', () => checkBundles(dest));
        else if (s === 'tsc') step('tsc', () => (run(bin('tsc'), ['-p', 'tsconfig.reader.json', '--noEmit'], dest) === 0 ? [] : ['tsc -p tsconfig.reader.json failed']));
        else if (s === 'vitest')
          step('vitest', () => (run(bin('vitest'), ['run', '-c', 'vitest.reader.config.ts'], dest) === 0 ? [] : ['the reader unit suite failed']));
        else if (s === 'map') step('map', () => checkMap(dest));
        else if (s === 'e2e') step('e2e', () => (run(bin('playwright'), ['test', '-c', 'test/e2e/playwright.config.ts', '--grep-invert', '@edit', ...workers], dest) === 0 ? [] : ['the E2E suite (without @edit) failed']));
        else if (s === 'security') step('security', () => (run(bin('playwright'), ['test', '-c', 'test/security/playwright.config.ts', '--grep-invert', '@edit'], dest) === 0 ? [] : ['the security suite (without @edit) failed']));
      }
    }
  } finally {
    if (!o.keep) rmSync(dest, { recursive: true, force: true });
    else say(`kept the copy at ${dest}`);
  }
  console.log('\nReader-only gate (P2-15):');
  for (const r of results) console.log(`  ${r.ok ? 'pass' : 'FAIL'}  ${r.name.padEnd(9)} ${String(Math.round(r.ms / 1000)).padStart(5)} s${r.problems.length ? `  ${r.problems.slice(0, 3).join('; ')}` : ''}`);
  const ok = results.length > 0 && results.every((r) => r.ok);
  console.log(`  ${ok ? 'PASSED' : 'FAILED'} in ${Math.round((Date.now() - t0) / 1000)} s`);
  process.exit(ok ? 0 : 1);
}

main();
