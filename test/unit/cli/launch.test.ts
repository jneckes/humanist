// Finding and starting the app from the `blueline` command (6.1).
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  FORWARDED_SIGNALS,
  commandExitCode,
  devAppDir,
  findApp,
  packagedExecutable,
  parseProcStat,
  planLaunch,
  signalExitCode,
  xvfbAppPid,
  type LaunchContext,
} from '../../../packages/cli/src/launch';

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
    expect(findApp(ctx({ files: DEV_FILES.slice(0, 2), resolveElectron: () => null }))).toMatchObject({ ok: false, error: expect.stringMatching(/npm run install:electron/) });
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
    expect(planLaunch(app, args, ctx({ env: { DISPLAY: ':0' } }))).toEqual({
      ok: true,
      value: { command: '/e/electron', args: ['/repo/packages/app', ...args], warnings: [], ownGroup: true, viaXvfb: false, executable: '/e/electron' },
    });
    expect(planLaunch({ executable: '/A/Blueline', appDir: null }, args, ctx({ platform: 'darwin' }))).toMatchObject({ value: { command: '/A/Blueline', args } });
  });

  it('Linux without a display runs under xvfb-run with a 3840x2160 screen', () => {
    const r = planLaunch(app, args, ctx());
    expect(r).toEqual({
      ok: true,
      value: {
        command: '/usr/bin/xvfb-run',
        args: ['-a', '-s', '-screen 0 3840x2160x24', '/e/electron', '/repo/packages/app', ...args],
        warnings: [],
        ownGroup: true,
        viaXvfb: true,
        executable: '/e/electron',
      },
    });
    expect(planLaunch(app, args, ctx({ env: { WAYLAND_DISPLAY: 'wayland-0' } }))).toMatchObject({ value: { command: '/e/electron' } });
    expect(planLaunch(app, args, ctx({ which: () => null }))).toMatchObject({ ok: false, error: expect.stringMatching(/xvfb-run/) });
  });

  it('POSIX: the app runs in its own process group, so a signal to the command reaches xvfb-run, Xvfb and Electron (6.1)', () => {
    expect(planLaunch(app, args, ctx({ env: { DISPLAY: ':0' } }))).toMatchObject({ value: { ownGroup: true } });
    expect(planLaunch({ executable: '/A/Blueline', appDir: null }, args, ctx({ platform: 'darwin' }))).toMatchObject({ value: { ownGroup: true, viaXvfb: false } });
    // Windows has no process groups: the command signals the child itself.
    expect(planLaunch({ executable: 'C:\\B\\Blueline.exe', appDir: null }, args, ctx({ platform: 'win32', uid: null }))).toMatchObject({ value: { ownGroup: false, viaXvfb: false } });
  });

  it('as root on Linux adds --no-sandbox with a warning', () => {
    const r = planLaunch(app, args, ctx({ uid: 0, env: { DISPLAY: ':1' } }));
    expect(r.ok && r.value.args[0]).toBe('--no-sandbox');
    expect(r.ok && r.value.warnings[0]).toMatch(/--no-sandbox/);
    expect(planLaunch(app, args, ctx({ uid: 0, platform: 'darwin' }))).toMatchObject({ value: { warnings: [] } });
  });
});

describe('commandExitCode (6.1; section 10 Mutation probe step 1)', () => {
  it('passes on SIGINT, SIGTERM and SIGHUP', () => {
    expect([...FORWARDED_SIGNALS].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
    expect(signalExitCode('SIGHUP')).toBe(129);
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGTERM')).toBe(143);
  });

  it("the app's own result decides when there is one", () => {
    // An interrupted map writes 143 itself; xvfb-run, stopped by the same signal, reports no code.
    expect(commandExitCode({ resultExitCode: 143, received: 'SIGTERM', code: null, signal: 'SIGTERM' })).toBe(143);
    // check --auto passed, but xvfb-run's own status was 1.
    expect(commandExitCode({ resultExitCode: 0, received: null, code: 1, signal: null })).toBe(0);
    expect(commandExitCode({ resultExitCode: 1, received: null, code: 0, signal: null })).toBe(1);
  });

  it('without a result: 128 + the signal, else the exit code, never 0', () => {
    expect(commandExitCode({ resultExitCode: null, received: 'SIGTERM', code: 0, signal: null })).toBe(143);
    expect(commandExitCode({ resultExitCode: null, received: null, code: null, signal: 'SIGKILL' })).toBe(137);
    expect(commandExitCode({ resultExitCode: null, received: 'SIGINT', code: null, signal: 'SIGKILL' })).toBe(130);
    expect(commandExitCode({ resultExitCode: null, received: null, code: 3, signal: null })).toBe(3);
    expect(commandExitCode({ resultExitCode: null, received: null, code: 0, signal: null })).toBe(1);
  });
});

describe('passing a signal on under xvfb-run (Linux)', () => {
  it('parses /proc/<pid>/stat, whatever the command name holds', () => {
    expect(parseProcStat('4242 (electron) S 4200 4200 4200 0 -1 4194560 …')).toEqual({ pid: 4242, comm: 'electron', ppid: 4200, pgrp: 4200 });
    expect(parseProcStat('77 (a (b) c) R 1 77 77 0')).toEqual({ pid: 77, comm: 'a (b) c', ppid: 1, pgrp: 77 });
    expect(parseProcStat('garbage')).toBeNull();
  });

  it("the signal goes to the app's main process (xvfb-run's child running the app), never to xvfb-run, Xvfb or xauth", () => {
    const members = [
      { pid: 100, comm: 'xvfb-run', ppid: 50, pgrp: 100 },
      { pid: 101, comm: 'xauth', ppid: 100, pgrp: 100 },
      { pid: 102, comm: 'Xvfb', ppid: 100, pgrp: 100 },
      { pid: 103, comm: 'electron', ppid: 100, pgrp: 100 },
      { pid: 104, comm: 'electron', ppid: 103, pgrp: 100 },
    ];
    expect(xvfbAppPid(members, 100, '/repo/node_modules/electron/dist/electron')).toBe(103);
    // Not started yet: the caller stops the whole group.
    expect(xvfbAppPid(members.slice(0, 3), 100, '/repo/node_modules/electron/dist/electron')).toBeNull();
    // comm is the executable's name cut to 15 bytes.
    expect(xvfbAppPid([{ pid: 9, comm: 'a-very-long-exe', ppid: 8, pgrp: 8 }], 8, '/opt/a-very-long-executable-name')).toBe(9);
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
