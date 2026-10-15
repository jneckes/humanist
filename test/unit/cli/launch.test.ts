// Finding and starting the app from the `blueline` command (6.1).
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { devAppDir, findApp, packagedExecutable, planLaunch, type LaunchContext } from '../../../packages/cli/src/launch';

function ctx(over: Partial<LaunchContext> & { files?: string[] } = {}): LaunchContext {
  const files = new Set(over.files ?? []);
  return {
    env: {},
    platform: 'linux',
    uid: 1000,
    cliDir: '/repo/packages/cli/dist',
    exists: (p) => files.has(p),
    resolveElectron: () => '/repo/node_modules/electron/dist/electron',
    which: (c) => (c === 'xvfb-run' ? '/usr/bin/xvfb-run' : null),
    ...over,
  };
}
const DEV_FILES = ['/repo/packages/app/package.json', '/repo/packages/app/dist/main.cjs', '/repo/node_modules/electron/dist/electron'];

describe('findApp', () => {
  it('development: Electron from packages/app, with the app folder', () => {
    expect(devAppDir('/repo/packages/cli/dist')).toBe(path.resolve('/repo/packages/app'));
    expect(findApp(ctx({ files: DEV_FILES }))).toEqual({ ok: true, value: { executable: '/repo/node_modules/electron/dist/electron', appDir: path.resolve('/repo/packages/app') } });
  });

  it('development: an unbuilt app or missing Electron is explained', () => {
    expect(findApp(ctx({ files: ['/repo/packages/app/package.json'] }))).toMatchObject({ ok: false, error: expect.stringMatching(/npm run build/) });
    expect(findApp(ctx({ files: DEV_FILES.slice(0, 2), resolveElectron: () => null }))).toMatchObject({ ok: false, error: expect.stringMatching(/npm install/) });
  });

  it('BLUELINE_ELECTRON wins, with BLUELINE_APP_DIR or the dev app folder', () => {
    const c = ctx({ env: { BLUELINE_ELECTRON: '/e/electron', BLUELINE_APP_DIR: '/my/app' }, files: ['/e/electron'] });
    expect(findApp(c)).toEqual({ ok: true, value: { executable: '/e/electron', appDir: '/my/app' } });
    expect(findApp(ctx({ env: { BLUELINE_ELECTRON: '/e/electron' }, files: ['/e/electron', ...DEV_FILES] }))).toMatchObject({ value: { appDir: path.resolve('/repo/packages/app') } });
    expect(findApp(ctx({ env: { BLUELINE_ELECTRON: '/nope' } }))).toMatchObject({ ok: false });
  });

  it('packaged: the executable next to Resources/cli', () => {
    expect(packagedExecutable('/Applications/Blueline.app/Contents/Resources/cli', 'darwin')).toBe('/Applications/Blueline.app/Contents/MacOS/Blueline');
    expect(packagedExecutable('/opt/Blueline/resources/cli', 'linux')).toBe('/opt/Blueline/blueline');
    const mac = ctx({ platform: 'darwin', cliDir: '/Applications/Blueline.app/Contents/Resources/cli', files: ['/Applications/Blueline.app/Contents/MacOS/Blueline'] });
    expect(findApp(mac)).toEqual({ ok: true, value: { executable: '/Applications/Blueline.app/Contents/MacOS/Blueline', appDir: null } });
    expect(findApp(ctx({ cliDir: '/somewhere/cli' }))).toMatchObject({ ok: false, error: expect.stringMatching(/Install Command Line Tool/) });
  });
});

describe('planLaunch', () => {
  const app = { executable: '/e/electron', appDir: '/repo/packages/app' };
  const args = ['--bl-cmd=map', '--bl-args=e30', '--bl-out=/tmp/o.json'];

  it('with a display: the executable, the app folder, then the app arguments', () => {
    expect(planLaunch(app, args, ctx({ env: { DISPLAY: ':0' } }))).toEqual({ ok: true, value: { command: '/e/electron', args: ['/repo/packages/app', ...args], warnings: [] } });
    expect(planLaunch({ executable: '/A/Blueline', appDir: null }, args, ctx({ platform: 'darwin' }))).toMatchObject({ value: { command: '/A/Blueline', args } });
  });

  it('Linux without a display runs under xvfb-run with a 3840x2160 screen', () => {
    const r = planLaunch(app, args, ctx());
    expect(r).toEqual({ ok: true, value: { command: '/usr/bin/xvfb-run', args: ['-a', '-s', '-screen 0 3840x2160x24', '/e/electron', '/repo/packages/app', ...args], warnings: [] } });
    expect(planLaunch(app, args, ctx({ env: { WAYLAND_DISPLAY: 'wayland-0' } }))).toMatchObject({ value: { command: '/e/electron' } });
    expect(planLaunch(app, args, ctx({ which: () => null }))).toMatchObject({ ok: false, error: expect.stringMatching(/xvfb-run/) });
  });

  it('as root on Linux adds --no-sandbox with a warning', () => {
    const r = planLaunch(app, args, ctx({ uid: 0, env: { DISPLAY: ':1' } }));
    expect(r.ok && r.value.args[0]).toBe('--no-sandbox');
    expect(r.ok && r.value.warnings[0]).toMatch(/--no-sandbox/);
    expect(planLaunch(app, args, ctx({ uid: 0, platform: 'darwin' }))).toMatchObject({ value: { warnings: [] } });
  });
});

describe('never npx (9.5)', () => {
  it('no user-facing text in the CLI suggests npx', async () => {
    const fs = await import('node:fs');
    for (const f of ['index.ts', 'args.ts', 'launch.ts']) {
      const src = fs.readFileSync(path.resolve(__dirname, '../../../packages/cli/src', f), 'utf8');
      const strings = src.match(/(['"`])(?:\\.|(?!\1).)*\1/g) ?? [];
      expect(strings.filter((s) => /\bnpx\b/.test(s))).toEqual([]);
    }
  });
});
