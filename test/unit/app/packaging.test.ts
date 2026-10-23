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
  it('declares html and htm with role Editor for macOS only (9.10 File associations; 6.1)', () => {
    expect(builder.mac.fileAssociations).toEqual([{ ext: ['html', 'htm'], name: 'HTML Document', role: 'Editor', rank: 'Default' }]);
    // Windows registration comes only from build/installer.nsh (6.1): electron-builder merges a top-level list
    // into every platform, and its NSIS APP_ASSOCIATE then sets .html's and .htm's own default ProgID (HKLM for a
    // per-machine install) with an unquoted command (review finding 22).
    expect(builder.fileAssociations).toBeUndefined();
    expect(builder.win.fileAssociations).toBeUndefined();
    expect(builder.nsis.fileAssociations).toBeUndefined();
    expect(builder.linux.fileAssociations).toBeUndefined();
    expect(builder.productName).toBe('Blueline');
    expect(typeof builder.appId).toBe('string');
  });

  it('ships the CLI outside app.asar in Resources/cli (6.1), with its bundles\' licence notices', () => {
    expect(builder.asar).toBe(true);
    expect(builder.extraResources).toEqual([
      expect.objectContaining({ to: 'cli', filter: ['blueline.cjs', 'blueline-editor.cjs', 'blueline', 'blueline.cmd', 'THIRD-PARTY-NOTICES.txt'] }),
    ]);
    expect(builder.extraResources[0].from).toBe(path.join(repo, 'packages/cli/dist'));
  });

  it('ships no node_modules: packages/app has no runtime dependencies, and files excludes node_modules (supply chain)', () => {
    // Every package the app uses is bundled by esbuild; electron-builder copies packages/app's production
    // dependencies into app.asar, so there must be none (docs/DEPENDENCIES.md; package-smoke checks the archive).
    const appPkg = JSON.parse(fs.readFileSync(path.join(repo, 'packages/app/package.json'), 'utf8'));
    expect(appPkg.dependencies ?? {}).toEqual({});
    expect(appPkg.optionalDependencies ?? {}).toEqual({});
    expect(builder.files).toContain('!node_modules/**');
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

  it('afterExtract keeps Electron\'s and Chromium\'s licence notices in the Mac app (electron-builder deletes them there)', async () => {
    expect(builder.afterExtract).toBe(path.join(repo, 'scripts/electron-notices.cjs'));
    const afterExtract = req('./scripts/electron-notices.cjs');
    fs.mkdirSync(path.join(repo, 'test-results'), { recursive: true });
    const tmp = fs.mkdtempSync(path.join(repo, 'test-results', 'unit-electron-notices-'));
    try {
      const make = (dir: string, withNotices: boolean) => {
        fs.mkdirSync(path.join(dir, 'Electron.app', 'Contents', 'Resources'), { recursive: true });
        if (withNotices) {
          fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT electron');
          fs.writeFileSync(path.join(dir, 'LICENSES.chromium.html'), '<html>chromium</html>');
        }
      };
      const context = (appOutDir: string, platform: string, electronDist?: string) => ({
        appOutDir,
        electronPlatformName: platform,
        packager: { info: { framework: { distMacOsAppName: 'Electron.app' } }, config: { electronDist }, projectDir: repo },
      });
      const res = (dir: string) => path.join(dir, 'Electron.app', 'Contents', 'Resources');
      // The release zip: the notices next to Electron.app.
      const zip = path.join(tmp, 'zip');
      make(zip, true);
      await afterExtract(context(zip, 'darwin'));
      expect(fs.readFileSync(path.join(res(zip), 'LICENSE.electron.txt'), 'utf8')).toBe('MIT electron');
      expect(fs.readFileSync(path.join(res(zip), 'LICENSES.chromium.html'), 'utf8')).toContain('chromium');
      // An unpacked electronDist: electron-builder copies only Electron.app, so they come from that folder.
      const out = path.join(tmp, 'out');
      const dist = path.join(tmp, 'dist');
      make(out, false);
      make(dist, true);
      await afterExtract(context(out, 'darwin', dist));
      expect(fs.existsSync(path.join(res(out), 'LICENSES.chromium.html'))).toBe(true);
      // Nowhere to be found: the build fails rather than ship without them.
      const bare = path.join(tmp, 'bare');
      make(bare, false);
      await expect(afterExtract(context(bare, 'darwin'))).rejects.toThrow(/LICENSE was not found/);
      // Linux and Windows: electron-builder keeps them itself.
      await afterExtract(context(bare, 'linux'));
      expect(fs.readdirSync(res(bare))).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('afterPack is the fuses script', () => {
    expect(builder.afterPack).toBe(path.join(repo, 'scripts/fuses.cjs'));
    expect(typeof fuses).toBe('function');
  });
});

describe('installer.nsh (6.1): uninstall removes exactly what install wrote, and a per-machine install the per-user copy', () => {
  const nsh = fs.readFileSync(path.join(repo, 'packages/app/build/installer.nsh'), 'utf8');
  const code = nsh
    .split('\n')
    .map((l) => l.replace(/^\s*;.*$/, ''))
    .join('\n');
  const defines = new Map<string, string>();
  for (const m of code.matchAll(/!define\s+(\w+)\s+"([^"]*)"/g)) defines.set(m[1], m[2]);
  const expand = (s: string | undefined) => (s === undefined ? undefined : s.replace(/\$\{(\w+)\}/g, (all, k: string) => defines.get(k) ?? all));
  const macro = (name: string) => {
    const m = new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`).exec(code);
    if (!m) throw new Error(`no macro ${name}`);
    return m[1];
  };
  const args = (line: string) => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const lines = (body: string) =>
    body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  type Write = { root: string; key: string; value: string };
  type Delete = { kind: string; ifempty: boolean; root: string; key: string; value?: string };
  const writesIn = (body: string): Write[] =>
    lines(body)
      .filter((l) => /^WriteReg(Str|ExpandStr|DWORD|None|Bin)\b/.test(l))
      .map((l) => {
        const [, root, key, value] = args(l);
        return { root, key: expand(key)!, value: expand(value)! };
      });
  const deletesIn = (body: string): Delete[] =>
    lines(body)
      .filter((l) => /^DeleteReg(Key|Value)\b/.test(l))
      .map((l) => {
        const a = args(l);
        const ifempty = a[1] === '/ifempty';
        const rest = ifempty ? a.slice(2) : a.slice(1);
        return { kind: a[0], ifempty, root: rest[0], key: expand(rest[1])!, value: expand(rest[2]) };
      });
  const lower = (s: string) => s.toLowerCase();
  const under = (key: string, parent: string) => lower(key) === lower(parent) || lower(key).startsWith(`${lower(parent)}\\`);

  const install = macro('customInstall');
  const uninstall = macro('customUnInstall');
  // The per-machine branch of customInstall: everything between `${if} $installMode == "all"` and its `${endIf}`.
  const branch = /\$\{if\}\s+\$installMode\s*==\s*"all"\s*\n([\s\S]*?)\n\s*\$\{endIf\}/.exec(install)?.[1] ?? null;
  const writes = writesIn(install);
  const removes = deletesIn(uninstall);
  const removedBy = (w: Write, d: Delete) => (d.kind === 'DeleteRegKey' && !d.ifempty && under(w.key, d.key)) || (d.kind === 'DeleteRegValue' && lower(d.key) === lower(w.key) && d.value === w.value);

  it('every key and value install writes is removed on uninstall, and uninstall removes nothing install did not write', () => {
    for (const w of writes) expect(removes.some((d) => removedBy(w, d)), `${w.key} :: ${w.value}`).toBe(true);
    for (const d of removes) {
      // /ifempty removes a key only once nothing else is in it: it must be a key Blueline wrote into.
      const wrote = d.ifempty ? writes.some((w) => under(w.key, d.key)) : writes.some((w) => removedBy(w, d));
      expect(wrote, `${d.kind} ${d.key} :: ${d.value ?? ''}`).toBe(true);
    }
    // Install never writes an extension's own default value, so uninstall never reads or clears one (finding 22).
    expect(writes.some((w) => /^Software\\Classes\\\.html?$/i.test(w.key) && w.value === '')).toBe(false);
    expect(uninstall).not.toMatch(/ReadRegStr|HTML Document/);
  });

  it('a per-machine install removes the per-user registration a per-user install left (finding 23)', () => {
    // electron-builder runs the old per-user uninstaller with --updated, so its customUnInstall is skipped and the
    // HKCU ProgID would keep naming the deleted per-user Blueline.exe.
    expect(branch, 'customInstall has a $installMode == "all" branch').not.toBeNull();
    const body = lines(branch!);
    // SHELL_CONTEXT is HKCU between these two (the pattern electron-builder's own templates use), and HKLM again
    // after, for the rest of the install.
    expect(body[0]).toBe('SetShellVarContext current');
    expect(body.at(-1)).toBe('SetShellVarContext all');
    // It removes exactly what uninstall removes, in the same order.
    expect(deletesIn(branch!)).toEqual(removes);
    expect(writesIn(branch!)).toEqual([]);
    // After this install's own writes, and before Explorer is told the associations changed.
    expect(install.indexOf('$installMode')).toBeGreaterThan(install.lastIndexOf('WriteReg'));
    expect(install.lastIndexOf('SHChangeNotify')).toBeGreaterThan(install.lastIndexOf('SetShellVarContext all'));
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
