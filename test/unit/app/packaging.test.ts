// Packaging (9.10) and fuses (9.9): the config is valid and states what the spec requires.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const repo = path.resolve(__dirname, '../../..');
const req = createRequire(path.join(repo, 'package.json'));
const builder = req('./packages/app/electron-builder.config.cjs');
const fuses = req('./scripts/fuses.cjs');
const { macSigningFor } = req('./scripts/mac-signing.cjs');

describe('electron-builder config', () => {
  it('declares html and htm with role Editor (9.10 File associations)', () => {
    expect(builder.fileAssociations).toEqual([{ ext: ['html', 'htm'], name: 'HTML Document', role: 'Editor', rank: 'Default' }]);
    expect(builder.productName).toBe('Blueline');
    expect(typeof builder.appId).toBe('string');
  });

  it('ships the CLI outside app.asar in Resources/cli (6.1)', () => {
    expect(builder.asar).toBe(true);
    expect(builder.extraResources).toEqual([expect.objectContaining({ to: 'cli', filter: ['blueline.cjs', 'blueline-editor.cjs', 'blueline', 'blueline.cmd'] })]);
    expect(builder.extraResources[0].from).toBe(path.join(repo, 'packages/cli/dist'));
  });

  it('ships the served folders (dist/shell, dist/assets) unpacked, outside app.asar (9.10; app-paths.ts)', () => {
    // Inside the archive the confined protocol handlers refuse every file: a blank shell, no trust bar.
    expect(builder.asarUnpack).toEqual(expect.arrayContaining(['dist/shell/**', 'dist/assets/**']));
    // The build resources (entitlements, icons) never ship.
    expect(builder.files).toContain('!dist/assets/build/**');
    // A Linux build's executable is where the `blueline` command looks for it (packages/cli/src/launch.ts).
    expect(builder.linux.executableName).toBe('blueline');
  });

  it('main builds every served path through app-paths.ts, never from __dirname alone', () => {
    const main = path.join(repo, 'packages/app/src/main');
    for (const f of fs.readdirSync(main).filter((n) => n.endsWith('.ts') && n !== 'app-paths.ts')) {
      const src = fs.readFileSync(path.join(main, f), 'utf8');
      expect(src, f).not.toMatch(/path\.join\([^)]*['"](?:shell|assets)['"]/);
    }
    const sources = ['index.ts', 'diagnostics.ts'].map((f) => fs.readFileSync(path.join(main, f), 'utf8'));
    for (const s of sources) expect(s).toMatch(/servedDirs\(/);
  });

  it('macOS: hardened runtime for release signing; the microphone entitlement in both entitlements files; NSMicrophoneUsageDescription (9.10)', () => {
    expect(macSigningFor({ CSC_LINK: '/secret/cert.p12' })).toEqual({ release: true, mac: { hardenedRuntime: true } });
    expect(macSigningFor({ CSC_NAME: 'Blueline Contributors (TEAMID)' }).mac.hardenedRuntime).toBe(true);
    expect(macSigningFor({ BLUELINE_SIGN: '1' }).release).toBe(true);
    expect(builder.mac.extendInfo.NSMicrophoneUsageDescription).toMatch(/\S/);
    for (const f of [builder.mac.entitlements, builder.mac.entitlementsInherit]) {
      const xml = fs.readFileSync(f, 'utf8');
      expect(xml).toMatch(/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
    }
    expect(builder.mac.entitlements).not.toBe(builder.mac.entitlementsInherit);
  });

  it('macOS without a signing identity: an ad-hoc signed, unnotarized local build (SPEC 10 Phase 1 Builds)', () => {
    // Apple silicon runs no unsigned code, so the local build is signed ad hoc ('-'), not left unsigned; ad hoc
    // signing under the hardened runtime fails library validation, so the runtime is off; nothing is notarized.
    expect(macSigningFor({})).toEqual({ release: false, mac: { identity: '-', hardenedRuntime: false, notarize: false } });
    expect(macSigningFor({ BLUELINE_SIGN: '0' }).release).toBe(false);
    // The config itself follows the environment it is loaded in (no signing variables in the test run).
    if (!process.env.CSC_LINK && !process.env.CSC_NAME && process.env.BLUELINE_SIGN !== '1') {
      expect(builder.mac).toMatchObject({ identity: '-', hardenedRuntime: false, notarize: false });
    }
  });

  it("validates against electron-builder's own configuration schema", async () => {
    const { validateConfiguration } = req('app-builder-lib/out/util/config/config');
    const { DebugLogger } = req('builder-util/out/DebugLogger');
    await expect(validateConfiguration(JSON.parse(JSON.stringify(builder)), new DebugLogger(false))).resolves.toBeUndefined();
    // And in release mode (hardened runtime, no ad-hoc identity).
    const { identity: _i, notarize: _n, ...mac } = builder.mac;
    const release = { ...builder, mac: { ...mac, ...macSigningFor({ BLUELINE_SIGN: '1' }).mac } };
    await expect(validateConfiguration(JSON.parse(JSON.stringify(release)), new DebugLogger(false))).resolves.toBeUndefined();
  });

  it('afterPack is the fuses script', () => {
    expect(builder.afterPack).toBe(path.join(repo, 'scripts/fuses.cjs'));
    expect(typeof fuses).toBe('function');
  });
});

describe('fuses (9.9)', () => {
  it('release: runAsNode off, inspect off, asar integrity on, only asar on, NODE_OPTIONS off, file privileges off', () => {
    expect(fuses.expectedFuses(false)).toEqual({
      RunAsNode: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
      EnableNodeOptionsEnvironmentVariable: false,
      GrantFileProtocolExtraPrivileges: false,
    });
  });

  it('the test build differs only in enableNodeCliInspectArguments', () => {
    const a = fuses.expectedFuses(false);
    const b = fuses.expectedFuses(true);
    const diff = Object.keys(a).filter((k) => a[k] !== b[k]);
    expect(diff).toEqual(['EnableNodeCliInspectArguments']);
  });

  it('every fuse name exists in @electron/fuses', async () => {
    const { FuseV1Options } = await import('@electron/fuses');
    for (const k of Object.keys(fuses.expectedFuses(false))) expect(k in FuseV1Options, k).toBe(true);
  });

  it('finds the packed binary per platform', () => {
    const ctx = (p: string) => ({ electronPlatformName: p, appOutDir: '/out', packager: { appInfo: { productFilename: 'Blueline' }, executableName: 'blueline' } });
    expect(fuses.electronBinaryPath(ctx('darwin'))).toBe(path.join('/out', 'Blueline.app'));
    expect(fuses.electronBinaryPath(ctx('win32'))).toBe(path.join('/out', 'Blueline.exe'));
    expect(fuses.electronBinaryPath(ctx('linux'))).toBe(path.join('/out', 'blueline'));
  });
});
