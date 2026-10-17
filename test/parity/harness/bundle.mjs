// Builds and starts the exit-gate harness (scripts/parity.mjs, scripts/first-paint.mjs, test/parity/*.spec.ts).
//
// The harness is its own Electron main (harness/main.ts), so measuring needs no change to the app's entry
// point: it imports the app's main-process modules from source (documents, protocol, trust hooks, the render
// service, the slide index, the PDF) the way scripts/build.mjs bundles them, and uses the built deck preload
// (packages/app/dist/preload-deck.cjs, from `npm run build`), so Blueline's render runs the shipped preload in
// render mode. Only the harness itself is compiled here, into the work folder; the app is never rebuilt.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const PRELOAD = join(ROOT, 'packages/app/dist/preload-deck.cjs');

/** Core subpath imports (@blueline/core/foo) resolve to packages/core/src/foo.ts, as in scripts/build.mjs. */
const coreSubpaths = {
  name: 'core-subpaths',
  setup(build) {
    build.onResolve({ filter: /^@blueline\/core\// }, (a) => ({ path: join(ROOT, 'packages/core/src', a.path.slice('@blueline/core/'.length) + '.ts') }));
    build.onResolve({ filter: /^@blueline\/editor(\/.*)?$/ }, (a) => ({ errors: [{ text: `${a.importer} imports ${a.path}: the harness never loads the editor (D11)` }] }));
  },
};

/** Bundles harness/main.ts (Electron main) and harness/plain-probe.ts (isolated-world IIFE) into `outDir`. */
export async function bundleHarness(outDir) {
  if (!existsSync(PRELOAD)) throw new Error(`${PRELOAD} is missing: run \`npm run build\` first`);
  const esbuild = await import('esbuild');
  mkdirSync(outDir, { recursive: true });
  const common = { bundle: true, charset: 'ascii', legalComments: 'none', logLevel: 'warning', alias: { '@blueline/core': join(ROOT, 'packages/core/src/index.ts') }, plugins: [coreSubpaths] };
  const main = join(outDir, 'parity-main.cjs');
  const probe = join(outDir, 'plain-probe.js');
  await Promise.all([
    esbuild.build({ ...common, entryPoints: [join(ROOT, 'test/parity/harness/main.ts')], outfile: main, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], sourcemap: 'linked' }),
    esbuild.build({ ...common, entryPoints: [join(ROOT, 'test/parity/harness/plain-probe.ts')], outfile: probe, platform: 'browser', format: 'iife', target: 'chrome152' }),
  ]);
  return { main, probe };
}

/** The Electron binary of the app workspace. */
export function electronBinary() {
  return createRequire(join(ROOT, 'packages/app/package.json'))('electron');
}

/**
 * The environment without proxy variables. Chromium on Linux takes its proxy from them, but Protected view's
 * proxy sends its CDN allowlist DIRECT (network-policy.ts protectedProxyConfig): in a machine that reaches the
 * internet only through such a proxy, the plain render and a Trusted render would load web fonts that a
 * Protected render cannot. Without them every render sees the same network (here: none).
 */
export function offlineEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (/^(https?|all|no)_proxy$/i.test(k)) delete out[k];
  return out;
}

/**
 * Starts `electron <main> <args…>` and resolves to its exit code. On Linux without a display it runs under
 * xvfb-run with a 3840×2160 screen (an offscreen window is clamped to the X screen size, PHASE0-FINDINGS F4);
 * as root it adds --no-sandbox (a dev-container convenience; the OS sandbox is then off, as for `blueline map`).
 * The harness's stderr lines are passed to `onLine`. By default it runs without proxy variables (offlineEnv).
 */
export function runElectron(main, args, { onLine = (l) => process.stderr.write(`${l}\n`), env = offlineEnv(process.env) } = {}) {
  const electron = electronBinary();
  const eargs = [main, ...args];
  if (process.platform === 'linux' && process.getuid?.() === 0) eargs.unshift('--no-sandbox');
  let cmd = electron;
  let cmdArgs = eargs;
  if (process.platform === 'linux' && !env.DISPLAY) {
    cmd = 'xvfb-run';
    cmdArgs = ['-a', '-s', '-screen 0 3840x2160x24', electron, ...eargs];
  }
  return new Promise((resolvePromise, reject) => {
    // Its own process group, so a signal reaches Electron under xvfb-run too (xvfb-run does not pass it on).
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], env, detached: true });
    let buf = '';
    const feed = (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    const stop = (sig) => () => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    const handlers = ['SIGINT', 'SIGTERM'].map((s) => [s, stop(s)]);
    for (const [s, h] of handlers) process.once(s, h);
    child.on('exit', (code, signal) => {
      for (const [s, h] of handlers) process.removeListener(s, h);
      if (buf.trim()) onLine(buf);
      resolvePromise(code ?? (signal ? 128 : 1));
    });
  });
}
