// electron-builder configuration (SPEC 9.10, 6.1). `npm run dist` uses it from the repo root, so every path
// is absolute (from this file's folder). `npm run package:smoke` (scripts/package-smoke.mjs) packs an unpacked
// test build with it and checks the shell, the trust bar and `blueline check --auto` on the packaged app.
//
// - The app ships its esbuild bundles (dist/) in app.asar. dist/shell and dist/assets (the shell UI and the
//   bundled decks) ship unpacked, in app.asar.unpacked: main serves them through the confined protocol
//   handlers (resolveConfined, 9.9), which refuse every file inside an archive (Electron's fs gives lstat
//   synthetic stats there), so main resolves them to the unpacked copy when packaged (src/main/app-paths.ts).
// - The `blueline` command ships outside app.asar, in Resources/cli, because the system's Node cannot read
//   app.asar (6.1). blueline-editor.cjs is left out of reader-only builds by the build itself.
// - fileAssociations declare html and htm with role Editor, so Blueline appears in Open With (6.1).
// - macOS: hardened runtime with entitlements; the microphone entitlement is in both entitlements files,
//   because Electron's helper processes take the inherited set (9.10).
// - afterPack flips the Electron fuses (scripts/fuses.cjs, 9.9).
'use strict';

const path = require('node:path');

const appDir = __dirname;
const root = path.resolve(appDir, '..', '..');
const buildResources = path.join(appDir, 'assets', 'build');

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
  files: ['package.json', 'dist/**/*', '!dist/**/*.map', '!dist/assets/build/**'],
  asarUnpack: ['dist/shell/**', 'dist/assets/**'],
  extraResources: [
    {
      from: path.join(root, 'packages', 'cli', 'dist'),
      to: 'cli',
      filter: ['blueline.cjs', 'blueline-editor.cjs'],
    },
  ],
  asar: true,
  npmRebuild: false,
  fileAssociations: [{ ext: ['html', 'htm'], name: 'HTML Document', role: 'Editor', rank: 'Default' }],
  mac: {
    category: 'public.app-category.productivity',
    target: ['dmg', 'zip'],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: path.join(buildResources, 'entitlements.mac.plist'),
    entitlementsInherit: path.join(buildResources, 'entitlements.mac.inherit.plist'),
    extendInfo: {
      // 6.8 / 9.10: the in-card recorder (Phase 5) records in the shell; main asks for access first.
      NSMicrophoneUsageDescription: 'Blueline records voice notes on your documents when you press the microphone button on a note.',
    },
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
    oneClick: false,
    perMachine: false,
    // Phase 1/6: a custom nsis.include writes the ProgID, OpenWithProgids, Capabilities and the
    // RegisteredApplications value for the install mode, and removes them on uninstall (6.1).
  },
  // Phase 6: electron-updater on GitHub Releases, stable channel, never allowDowngrade (9.10).
  publish: null,
  afterPack: path.join(root, 'scripts', 'fuses.cjs'),
};
