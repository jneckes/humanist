// electron-builder configuration (SPEC 9.10, 6.1). `npm run dist` uses it from the repo root, so every path
// is absolute (from this file's folder). `npm run package:smoke` (scripts/package-smoke.mjs) packs an unpacked
// test build with it and checks the shell, the trust bar and `blueline check --auto` on the packaged app.
//
// - The app ships its esbuild bundles (dist/) in app.asar, and nothing else: no node_modules. Every package the app
//   uses is bundled, so packages/app has no "dependencies" for electron-builder to copy, and '!node_modules/**'
//   keeps one out if it ever gets one (supply chain, docs/DEPENDENCIES.md; scripts/package-smoke.mjs checks it).
//   dist/THIRD-PARTY-NOTICES.txt holds the licence text of every package in the bundles (scripts/third-party.mjs).
// - dist/shell and dist/assets (the shell UI and the
//   bundled decks) ship unpacked, in app.asar.unpacked: main serves them through the confined protocol
//   handlers (resolveConfined, 9.9), which refuse every file inside an archive (Electron's fs gives lstat
//   synthetic stats there), so main resolves them to the unpacked copy when packaged (src/main/app-paths.ts).
// - The `blueline` command ships outside app.asar, in Resources/cli, because the system's Node cannot read
//   app.asar (6.1). blueline-editor.cjs is left out of reader-only builds by the build itself.
// - mac.fileAssociations declare html and htm with role Editor, so Blueline appears in Open With (6.1). They are
//   macOS's only: a top-level list reaches every platform, and electron-builder's NSIS template then sets .html's
//   and .htm's own default value to its "HTML Document" class (HKLM for a per-machine install), which an app must
//   not do (6.1: the user chooses in Default Apps), with an unquoted command. Windows is registered only by
//   build/installer.nsh (review finding 22).
// - macOS: hardened runtime with entitlements; the microphone entitlement is in both entitlements files,
//   because Electron's helper processes take the inherited set (9.10).
// - afterPack flips the Electron fuses (scripts/fuses.cjs, 9.9).
// - The macOS native helper (native/macos, 6.1, 9.9) ships outside app.asar in Resources/helper, signed and
//   notarized with the app, only when native/macos/build.sh has built it, so this config still works on
//   Linux and in CI without it (main then falls back to /usr/bin/xattr and cannot set the default app).
// - Windows: the NSIS include (build/installer.nsh) writes the ProgID, OpenWithProgids, Capabilities and the
//   RegisteredApplications value in the install mode's hive, and removes them on uninstall (6.1); a per-machine
//   install also removes the copy a per-user install wrote.
// - Local unsigned builds for dogfooding (SPEC 10 Phase 1, Builds): without a configured signing identity,
//   `npm run dist` on a Mac makes an ad-hoc signed, unnotarized build (scripts/mac-signing.cjs; README.md,
//   Dogfooding on a Mac). Developer ID signing and notarization (9.10) are Phase 6, from CI.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { macSigningFor } = require('../../scripts/mac-signing.cjs');

const appDir = __dirname;
const root = path.resolve(appDir, '..', '..');
const buildResources = path.join(appDir, 'assets', 'build');
/** native/macos/build.sh's output (6.1, 9.6 native/). */
const macHelper = path.join(root, 'native', 'macos', 'build', 'blueline-helper');

/** Release signing, or the ad-hoc local build (scripts/mac-signing.cjs). */
const signing = macSigningFor(process.env);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  // Placeholder until the publisher is settled (SPEC 13, question 4).
  appId: 'app.blueline.desktop',
  productName: 'Blueline',
  copyright: 'Copyright (c) Blueline contributors',
  directories: {
    app: appDir,
    output: path.join(root, 'release'),
    buildResources,
  },
  files: ['package.json', 'dist/**/*', '!dist/**/*.map', '!dist/assets/build/**', '!node_modules/**'],
  asarUnpack: ['dist/shell/**', 'dist/assets/**'],
  extraResources: [
    {
      from: path.join(root, 'packages', 'cli', 'dist'),
      to: 'cli',
      // The shims (the POSIX script and blueline.cmd) find Node 22+ and run blueline.cjs; Help › Install Command
      // Line Tool links to Resources/cli/blueline (6.1; cli-install.ts shippedCommand). THIRD-PARTY-NOTICES.txt: the
      // licences of the packages bundled into these files (scripts/third-party.mjs).
      filter: ['blueline.cjs', 'blueline-editor.cjs', 'blueline', 'blueline.cmd', 'THIRD-PARTY-NOTICES.txt'],
    },
  ],
  asar: true,
  npmRebuild: false,
  mac: {
    category: 'public.app-category.productivity',
    // Open With (6.1, 9.10 File associations); macOS only, see the header.
    fileAssociations: [{ ext: ['html', 'htm'], name: 'HTML Document', role: 'Editor', rank: 'Default' }],
    target: ['dmg', 'zip'],
    // Release: hardened runtime, Developer ID, notarization; local: ad hoc, no hardened runtime (macSigningFor).
    ...signing.mac,
    gatekeeperAssess: false,
    entitlements: path.join(buildResources, 'entitlements.mac.plist'),
    entitlementsInherit: path.join(buildResources, 'entitlements.mac.inherit.plist'),
    extendInfo: {
      // 6.8 / 9.10: the in-card recorder (Phase 5) records in the shell; main asks for access first.
      NSMicrophoneUsageDescription: 'Blueline records voice notes on your documents when you press the microphone button on a note.',
    },
    // The native helper, outside app.asar (an executable cannot run from inside the archive): main runs
    // process.resourcesPath/helper/blueline-helper (src/main/native-helper.ts findHelperBinary). osx-sign signs
    // it with the app (hardened runtime, the inherited entitlements). Added to the top-level extraResources.
    extraResources: fs.existsSync(macHelper) ? [{ from: path.dirname(macHelper), to: 'helper', filter: ['blueline-helper'] }] : [],
  },
  linux: {
    // Linux packages are Later (9.10); the name is where the `blueline` command looks (packages/cli/src/launch.ts).
    executableName: 'blueline',
  },
  win: {
    target: ['nsis'],
    // Phase 6: Azure Artifact Signing, and verifyUpdateCodeSignature with publisherName (9.10).
  },
  nsis: {
    // An assisted installer that offers both install modes: per user (HKCU, no admin) or per machine (HKLM,
    // after elevation). installer.nsh writes into the chosen mode's hive (SHELL_CONTEXT), and main opens
    // Default Apps with registeredAppUser= or registeredAppMachine= to match (6.1).
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    include: path.join(appDir, 'build', 'installer.nsh'),
  },
  // Phase 6: electron-updater on GitHub Releases, stable channel, never allowDowngrade (9.10).
  publish: null,
  afterPack: path.join(root, 'scripts', 'fuses.cjs'),
};
