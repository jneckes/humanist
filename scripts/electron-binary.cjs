// The development Electron binary, without installing it (supply chain, docs/DEPENDENCIES.md).
//
// Install scripts are off (.npmrc ignore-scripts), so `npm ci` leaves node_modules/electron without its binary.
// Fetching it is one explicit step, `npm run install:electron` (electron's own install.js: it downloads the zip
// for this platform and checks it against the SHA-256 in electron's checksums.json, which package-lock.json's
// integrity covers). `require('electron')` would instead download it silently, in the middle of whatever
// needed it (electron's index.js runs install.js when the binary is missing), so the scripts and tests that
// launch Electron take its path from here: it reads what install.js wrote (path.txt and dist/version) and fails
// with that one instruction when the binary is missing or is another version.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

/** node_modules/electron, as resolved from `fromDir` (default: packages/app, which depends on electron). */
function electronPackageDir(fromDir = path.join(__dirname, '..', 'packages', 'app')) {
  return path.dirname(createRequire(path.join(fromDir, 'package.json')).resolve('electron/package.json'));
}

/**
 * The Electron binary's path. Throws, with the command that installs it, when node_modules/electron has no binary
 * of its own version. ELECTRON_OVERRIDE_DIST_PATH is honoured as electron's index.js honours it.
 */
function electronBinary(fromDir) {
  const dir = electronPackageDir(fromDir);
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return null;
    }
  };
  const rel = read('path.txt');
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) return path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, rel || 'electron');
  const installed = (read(path.join('dist', 'version')) ?? '').trim().replace(/^v/, '');
  const bin = rel ? path.join(dir, 'dist', rel) : null;
  if (!bin || installed !== version || !fs.existsSync(bin)) {
    const found = installed ? `found ${installed}` : 'none found';
    throw new Error(
      `The Electron ${version} binary is not installed in ${path.join(dir, 'dist')} (${found}). npm install scripts are off ` +
        '(.npmrc ignore-scripts=true), so it is a separate step: run `npm run install:electron` (docs/DEPENDENCIES.md).',
    );
  }
  return bin;
}

/** The Electron binary, or exits the process with the message (for the command-line scripts). */
function electronBinaryOrExit(fromDir) {
  try {
    return electronBinary(fromDir);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

exports.electronPackageDir = electronPackageDir;
exports.electronBinary = electronBinary;
exports.electronBinaryOrExit = electronBinaryOrExit;
