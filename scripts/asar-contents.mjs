#!/usr/bin/env node
// What an app.asar holds (supply chain, docs/DEPENDENCIES.md): the app ships only package.json and dist/ (its
// esbuild bundles and THIRD-PARTY-NOTICES.txt; dist/shell and dist/assets are listed too, stored unpacked), never
// node_modules. Used by scripts/package-smoke.mjs on its test build and by CI on the real build:
//   node scripts/asar-contents.mjs <path/to/app.asar>     exit 1 when it holds node_modules or anything else
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

/** The archive's entries ('/dist/main.cjs', …), and those that must not be there. */
export function asarContents(asarPath) {
  const asar = require('@electron/asar');
  const entries = asar.listPackage(asarPath, { isPack: false }).map((e) => e.replace(/\\/g, '/'));
  const nodeModules = entries.filter((e) => /(^|\/)node_modules(\/|$)/.test(e));
  const strays = entries.filter((e) => e !== '/package.json' && e !== '/dist' && !e.startsWith('/dist/'));
  return { entries, nodeModules, strays };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/asar-contents.mjs <app.asar>');
    process.exit(2);
  }
  const { entries, nodeModules, strays } = asarContents(resolve(file));
  const ok = entries.length > 0 && nodeModules.length === 0 && strays.length === 0;
  console.log(`${file}: ${entries.length} entries; node_modules: ${nodeModules.length}; outside package.json and dist/: ${strays.length}`);
  for (const e of [...nodeModules, ...strays].slice(0, 20)) console.log(`  ${e}`);
  if (!entries.includes('/dist/THIRD-PARTY-NOTICES.txt')) console.log('  missing /dist/THIRD-PARTY-NOTICES.txt');
  process.exit(ok && entries.includes('/dist/THIRD-PARTY-NOTICES.txt') ? 0 : 1);
}
