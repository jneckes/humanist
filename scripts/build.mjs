#!/usr/bin/env node
// Builds every bundle with esbuild (SPEC 9.6, Build):
//   packages/app/dist/main.cjs            Electron main (never imports packages/editor statically)
//   packages/app/dist/editor.cjs          the Edit capability, loaded at runtime if present (D11)
//   packages/app/dist/preload-deck.cjs    deck/render/diagnostics preload (sandboxed, isolated world)
//   packages/app/dist/preload-shell.cjs   shell preload (contextBridge API)
//   packages/app/dist/preload-settings.cjs  the Settings window's preload (contextBridge API, core/ipc-trust.ts)
//   packages/app/dist/preload-welcome.cjs   the welcome window's preload (contextBridge API, core/ipc-files.ts)
//   packages/app/dist/shell/              shell UI (HTML, CSS, JS)
//   packages/app/dist/assets/             bundled decks (diagnostics, sample); the Diagnostics deck's vendored reveal.js
//                                         is checked against scripts/vendored.json (SHA-256 of every file)
//   packages/cli/dist/blueline.cjs        the `blueline` command (cli + core)
//   packages/cli/dist/blueline, blueline.cmd  the shims that run it with Node 22+ (6.1; packages/cli/src/shim)
//   packages/cli/dist/blueline-editor.cjs editor + MCP SDK, loaded only for `mcp` and `export` (later phases)
//   packages/app/dist/THIRD-PARTY-NOTICES.txt, packages/cli/dist/THIRD-PARTY-NOTICES.txt
//                                         the licence text of every package bundled into them, and of the vendored
//                                         files (scripts/third-party.mjs)
//   out/esbuild-meta.json                 esbuild's metafile of every bundle: the third-party code that ships
//                                         (npm run bundled; the SBOM, npm run sbom; docs/DEPENDENCIES.md)
//
// Flags:
//   --reader-only  build without packages/editor; fails if any app/cli code resolves into it (D11, 9.6)
//   --watch        rebuild on change
//   --run          start the app after the first build (with --watch: restart on main changes)
import * as esbuild from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { writeNotices } from './third-party.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const readerOnly = args.has('--reader-only');
const watch = args.has('--watch');
const run = args.has('--run');

const appDist = join(root, 'packages/app/dist');
const cliDist = join(root, 'packages/cli/dist');
// dist folders are not wiped: several builds may run at once during development, and a running app
// must keep its files. The reader-only build removes the editor bundle it must not ship.
mkdirSync(appDist, { recursive: true });
if (readerOnly) {
  rmSync(join(appDist, 'editor.cjs'), { force: true });
  rmSync(join(appDist, 'editor.cjs.map'), { force: true });
}
mkdirSync(cliDist, { recursive: true });

const editorDir = join(root, 'packages/editor');

/** Fails the build if anything resolves into packages/editor (reader-only builds). */
const forbidEditor = {
  name: 'forbid-editor',
  setup(build) {
    build.onResolve({ filter: /^@blueline\/editor(\/.*)?$/ }, (a) => ({
      errors: [{ text: `reader-only build: ${a.importer} imports ${a.path}; Read and Review must not depend on packages/editor (D11)` }],
    }));
    build.onLoad({ filter: /.*/ }, (a) => {
      if (a.path.startsWith(editorDir + '/')) {
        return { errors: [{ text: `reader-only build: ${a.path} is inside packages/editor (D11)` }] };
      }
      return undefined;
    });
  },
};

/** Workspace packages resolve to their TypeScript sources. */
const alias = {
  '@blueline/core': join(root, 'packages/core/src/index.ts'),
};

const common = {
  absWorkingDir: root, // metafile paths are relative to the repo root
  bundle: true,
  sourcemap: 'linked',
  charset: 'ascii', // SPEC 9.6: ASCII-only output
  logLevel: 'info',
  // Licence comments of bundled code (/*! */, @license, @preserve) stay, at the end of each bundle; the full
  // licence texts are in THIRD-PARTY-NOTICES.txt next to the bundles (writeMeta).
  legalComments: 'eof',
  metafile: true,
  define: { 'process.env.BLUELINE_READER_ONLY': JSON.stringify(readerOnly ? '1' : '') },
};

/** Core subpath imports (@blueline/core/foo) resolve to packages/core/src/foo.ts. */
const coreSubpaths = {
  name: 'core-subpaths',
  setup(build) {
    build.onResolve({ filter: /^@blueline\/core\// }, (a) => ({
      path: join(root, 'packages/core/src', a.path.slice('@blueline/core/'.length) + '.ts'),
    }));
    if (!readerOnly) {
      build.onResolve({ filter: /^@blueline\/editor\// }, (a) => ({
        path: join(root, 'packages/editor/src', a.path.slice('@blueline/editor/'.length) + '.ts'),
      }));
    }
  },
};

const plugins = readerOnly ? [coreSubpaths, forbidEditor] : [coreSubpaths];

const configs = [
  {
    ...common,
    entryPoints: [join(root, 'packages/app/src/main/index.ts')],
    outfile: join(appDist, 'main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    alias,
    // The app never bundles the editor statically; it loads dist/editor.cjs at runtime (capabilities, 9.6).
    plugins: [coreSubpaths, forbidEditor],
  },
  {
    ...common,
    entryPoints: [join(root, 'packages/app/src/preload/deck.ts')],
    outfile: join(appDist, 'preload-deck.cjs'),
    platform: 'browser',
    format: 'cjs',
    target: 'chrome152',
    external: ['electron'],
    alias,
    plugins: [coreSubpaths, forbidEditor],
  },
  {
    ...common,
    entryPoints: [join(root, 'packages/app/src/preload/shell.ts')],
    outfile: join(appDist, 'preload-shell.cjs'),
    platform: 'browser',
    format: 'cjs',
    target: 'chrome152',
    external: ['electron'],
    alias,
    plugins: [coreSubpaths, forbidEditor],
  },
  {
    ...common,
    entryPoints: [join(root, 'packages/app/src/preload/settings.ts')],
    outfile: join(appDist, 'preload-settings.cjs'),
    platform: 'browser',
    format: 'cjs',
    target: 'chrome152',
    external: ['electron'],
    alias,
    plugins: [coreSubpaths, forbidEditor],
  },
  {
    ...common,
    entryPoints: [join(root, 'packages/app/src/preload/welcome.ts')],
    outfile: join(appDist, 'preload-welcome.cjs'),
    platform: 'browser',
    format: 'cjs',
    target: 'chrome152',
    external: ['electron'],
    alias,
    plugins: [coreSubpaths, forbidEditor],
  },
  {
    ...common,
    entryPoints: [join(root, 'packages/app/src/shell/shell.ts'), join(root, 'packages/app/src/shell/diagnostics.ts'), join(root, 'packages/app/src/shell/settings.ts'), join(root, 'packages/app/src/shell/welcome.ts')],
    outdir: join(appDist, 'shell'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome152',
    alias,
    plugins: [coreSubpaths, forbidEditor],
  },
  {
    ...common,
    entryPoints: [join(root, 'packages/cli/src/index.ts')],
    outfile: join(cliDist, 'blueline.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    alias,
    banner: { js: '#!/usr/bin/env node' },
    plugins: [coreSubpaths, forbidEditor],
  },
];

if (!readerOnly) {
  configs.push({
    ...common,
    entryPoints: [join(root, 'packages/editor/src/index.ts')],
    outfile: join(appDist, 'editor.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    alias,
    plugins,
  });
}

function copyStatic() {
  const shellSrc = join(root, 'packages/app/src/shell');
  mkdirSync(join(appDist, 'shell'), { recursive: true });
  for (const f of readdirSync(shellSrc)) {
    if (/\.(html|css|svg|png)$/.test(f)) cpSync(join(shellSrc, f), join(appDist, 'shell', f));
  }
  const assets = join(root, 'packages/app/assets');
  if (existsSync(assets)) cpSync(assets, join(appDist, 'assets'), { recursive: true });
  // The diagnostics deck is the committed reveal.js fixture (SPEC 10, Diagnostics window).
  const reveal = join(root, 'fixtures/decks/reveal-hash');
  if (existsSync(reveal) && statSync(reveal).isDirectory()) {
    // Replaced, not merged: its vendor/ folder must hold exactly the files scripts/vendored.json lists (checked by
    // writeNotices below), so a file removed from the fixture must not linger from an earlier build.
    rmSync(join(appDist, 'assets/diagnostics-deck'), { recursive: true, force: true });
    cpSync(reveal, join(appDist, 'assets/diagnostics-deck'), { recursive: true });
  }
  // The `blueline` shims go next to blueline.cjs (6.1; Install Command Line Tool links to dist's or Resources/cli's
  // copy): the POSIX one executable, the Windows one with CRLF line endings, which cmd.exe needs for its labels.
  const shim = join(root, 'packages/cli/src/shim');
  cpSync(join(shim, 'blueline'), join(cliDist, 'blueline'));
  chmodSync(join(cliDist, 'blueline'), 0o755);
  writeFileSync(join(cliDist, 'blueline.cmd'), readFileSync(join(shim, 'blueline.cmd'), 'utf8').replace(/\r?\n/g, '\r\n'));
}

/**
 * Writes out/esbuild-meta.json (every bundle's metafile, merged) and the THIRD-PARTY-NOTICES.txt files. Fails the
 * build when bundled third-party code is not the locked version or has a licence nobody reviewed (third-party.mjs).
 */
function writeMeta(results) {
  const meta = { inputs: {}, outputs: {} };
  for (const r of results) {
    Object.assign(meta.inputs, r.metafile.inputs);
    Object.assign(meta.outputs, r.metafile.outputs);
  }
  mkdirSync(join(root, 'out'), { recursive: true });
  writeFileSync(join(root, 'out', 'esbuild-meta.json'), JSON.stringify(meta));
  writeNotices(meta, root);
}

let child = null;
function startApp() {
  if (child) child.kill();
  child = spawn(process.execPath, [join(root, 'scripts/run-electron.mjs')], { stdio: 'inherit' });
}

if (watch) {
  const ctxs = await Promise.all(configs.map((c) => esbuild.context(c)));
  copyStatic();
  writeMeta(await Promise.all(ctxs.map((c) => c.rebuild())));
  await Promise.all(ctxs.map((c) => c.watch()));
  if (run) startApp();
} else {
  const results = await Promise.all(configs.map((c) => esbuild.build(c)));
  copyStatic();
  writeMeta(results);
  if (readerOnly && existsSync(join(appDist, 'editor.cjs'))) throw new Error('reader-only build produced editor.cjs');
  if (run) startApp();
}
