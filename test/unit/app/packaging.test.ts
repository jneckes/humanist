// Packaging (9.10) and fuses (9.9): the config is valid and states what the spec requires.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const repo = path.resolve(__dirname, '../../..');
const req = createRequire(path.join(repo, 'package.json'));
const builder = req('./packages/app/electron-builder.config.cjs');
const fuses = req('./scripts/fuses.cjs');

describe('electron-builder config', () => {
  it('declares html and htm with role Editor (9.10 File associations)', () => {
    expect(builder.fileAssociations).toEqual([{ ext: ['html', 'htm'], name: 'HTML Document', role: 'Editor', rank: 'Default' }]);
    expect(builder.productName).toBe('Blueline');
    expect(typeof builder.appId).toBe('string');
  });

  it('ships the CLI outside app.asar in Resources/cli (6.1)', () => {
    expect(builder.asar).toBe(true);
    expect(builder.extraResources).toEqual([expect.objectContaining({ to: 'cli', filter: ['blueline.cjs', 'blueline-editor.cjs'] })]);
    expect(builder.extraResources[0].from).toBe(path.join(repo, 'packages/cli/dist'));
  });

  it('macOS: hardened runtime; the microphone entitlement in both entitlements files; NSMicrophoneUsageDescription (9.10)', () => {
    expect(builder.mac.hardenedRuntime).toBe(true);
    expect(builder.mac.extendInfo.NSMicrophoneUsageDescription).toMatch(/\S/);
    for (const f of [builder.mac.entitlements, builder.mac.entitlementsInherit]) {
      const xml = fs.readFileSync(f, 'utf8');
      expect(xml).toMatch(/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
    }
    expect(builder.mac.entitlements).not.toBe(builder.mac.entitlementsInherit);
  });

  it("validates against electron-builder's own configuration schema", async () => {
    const { validateConfiguration } = req('app-builder-lib/out/util/config/config');
    const { DebugLogger } = req('builder-util/out/DebugLogger');
    await expect(validateConfiguration(JSON.parse(JSON.stringify(builder)), new DebugLogger(false))).resolves.toBeUndefined();
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
