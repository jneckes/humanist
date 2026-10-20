// Builds the Chromium fuzz harness (scripts/fuzz.mjs): its Electron main (harness/main.ts) and the field probe
// (harness/field-probe.ts, an IIFE run in an isolated world of the render view), into the work folder.
//
// Like the parity harness (test/parity/harness/bundle.mjs), the main imports the app's main-process modules from
// source (documents, protocol, trust hooks, the render service, map-command's walker, the probe) and uses the built
// deck preload (packages/app/dist/preload-deck.cjs). The Edit capability is NOT bundled: the harness loads the
// shipped packages/app/dist/editor.cjs at run time through editor-loader.ts, exactly as main does (the capability
// seam, D11), so the gate tests the bundle that ships. Any import of @blueline/editor fails this build.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, PRELOAD } from '../../parity/harness/bundle.mjs';

export { ROOT, PRELOAD };
export { electronBinary, offlineEnv, runElectron } from '../../parity/harness/bundle.mjs';

/** dist/editor.cjs: the Edit capability the harness loads at run time. */
export const EDITOR_DIR = join(ROOT, 'packages/app/dist');

/** Core subpath imports (@blueline/core/foo) resolve to packages/core/src/foo.ts, as in scripts/build.mjs. */
const coreSubpaths = {
  name: 'core-subpaths',
  setup(build) {
    build.onResolve({ filter: /^@blueline\/core\// }, (a) => ({ path: join(ROOT, 'packages/core/src', a.path.slice('@blueline/core/'.length) + '.ts') }));
    build.onResolve({ filter: /^@blueline\/editor(\/.*)?$/ }, (a) => ({
      errors: [{ text: `${a.importer} imports ${a.path}: the fuzz harness loads dist/editor.cjs through the seam, never the editor's source (D11)` }],
    }));
  },
};

/** Bundles harness/main.ts (Electron main) and harness/field-probe.ts (isolated-world IIFE) into `outDir`. */
export async function bundleHarness(outDir) {
  if (!existsSync(PRELOAD)) throw new Error(`${PRELOAD} is missing: run \`npm run build\` first`);
  if (!existsSync(join(EDITOR_DIR, 'editor.cjs'))) throw new Error(`${join(EDITOR_DIR, 'editor.cjs')} is missing: the fuzz gate needs a full build (npm run build), not a reader-only one`);
  const esbuild = await import('esbuild');
  mkdirSync(outDir, { recursive: true });
  const common = { bundle: true, charset: 'ascii', legalComments: 'none', logLevel: 'warning', alias: { '@blueline/core': join(ROOT, 'packages/core/src/index.ts') }, plugins: [coreSubpaths] };
  const main = join(outDir, 'fuzz-main.cjs');
  const fieldProbe = join(outDir, 'field-probe.js');
  await Promise.all([
    esbuild.build({ ...common, entryPoints: [join(ROOT, 'test/fuzz/harness/main.ts')], outfile: main, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], sourcemap: 'linked' }),
    esbuild.build({ ...common, entryPoints: [join(ROOT, 'test/fuzz/harness/field-probe.ts')], outfile: fieldProbe, platform: 'browser', format: 'iife', target: 'chrome152' }),
  ]);
  return { main, fieldProbe };
}
