// The app's command line (6.1 Mechanics; docs/ARCHITECTURE.md, Commands).
import { describe, expect, it } from 'vitest';
import {
  decodeArgs,
  encodeArgs,
  parseAppArgs,
  parseParentArg,
  validateCheckArgs,
  validateMapArgs,
  validateOpenArgs,
  validateSecondInstanceData,
} from '../../../packages/app/src/main/args';

const DEV = { defaultApp: true };
const PACKAGED = { defaultApp: false };

describe('parseAppArgs', () => {
  it('dev: drops the app folder and keeps plain paths as files (Windows passes files in argv)', () => {
    const r = parseAppArgs(['electron', '--no-sandbox', '/repo/packages/app', 'deck.html', 'b.htm'], DEV);
    expect(r).toEqual({ cmd: 'open', files: ['deck.html', 'b.htm'], protected: false, errors: [] });
  });

  it('packaged: every plain argument after the executable is a file', () => {
    const r = parseAppArgs(['C:\\Blueline\\Blueline.exe', 'C:\\Users\\a\\deck.html'], PACKAGED);
    expect(r).toMatchObject({ cmd: 'open', files: ['C:\\Users\\a\\deck.html'] });
  });

  it('ignores Chromium and Electron switches and macOS -psn_ arguments', () => {
    const r = parseAppArgs(['Blueline', '-psn_0_12345', '--original-process-start-time=1', '--enable-logging', 'x.html'], PACKAGED);
    expect(r).toMatchObject({ cmd: 'open', files: ['x.html'], protected: false });
  });

  it('--protected applies to the files of the invocation (6.10)', () => {
    expect(parseAppArgs(['e', 'app', '--protected', 'x.html'], DEV)).toMatchObject({ files: ['x.html'], protected: true });
  });

  it('open --bl-args adds files and protected', () => {
    const a = encodeArgs({ files: ['/abs/a.html'], protected: true });
    expect(parseAppArgs(['e', 'app', '--bl-cmd=open', `--bl-args=${a}`], DEV)).toEqual({ cmd: 'open', files: ['/abs/a.html'], protected: true, errors: [] });
  });

  it('map: decodes MapArgs and --bl-out', () => {
    const a = encodeArgs({ deck: '/d/deck.html', report: true, json: false, minCoverage: 0.95 });
    const r = parseAppArgs(['e', 'app', '--bl-cmd=map', `--bl-args=${a}`, '--bl-out=/tmp/out.json'], DEV);
    expect(r).toEqual({ cmd: 'map', map: { deck: '/d/deck.html', report: true, json: false, minCoverage: 0.95 }, out: '/tmp/out.json', errors: [] });
  });

  it('map without arguments has map null; invalid arguments are an error', () => {
    expect(parseAppArgs(['e', 'app', '--bl-cmd=map'], DEV)).toMatchObject({ cmd: 'map', map: null, out: null, errors: [] });
    const bad = encodeArgs({ deck: '/d.html', minCoverage: 5 });
    expect(parseAppArgs(['e', 'app', '--bl-cmd=map', `--bl-args=${bad}`], DEV).errors).toHaveLength(1);
  });

  it('check: auto defaults to false', () => {
    expect(parseAppArgs(['e', 'app', '--bl-cmd=check'], DEV)).toEqual({ cmd: 'check', check: { auto: false }, out: null, errors: [] });
    const a = encodeArgs({ auto: true });
    expect(parseAppArgs(['e', 'app', '--bl-cmd=check', `--bl-args=${a}`, '--bl-out=/o'], DEV)).toMatchObject({ check: { auto: true }, out: '/o' });
  });

  it('unknown --bl-cmd and undecodable --bl-args are reported, never guessed', () => {
    expect(parseAppArgs(['e', 'app', '--bl-cmd=pwn'], DEV).errors[0]).toMatch(/unknown --bl-cmd/);
    expect(parseAppArgs(['e', 'app', '--bl-args=***'], DEV).errors[0]).toMatch(/base64url/);
    expect(parseAppArgs(['e', 'app', `--bl-args=${Buffer.from('{nope').toString('base64url')}`], DEV).errors[0]).toMatch(/JSON/);
  });
});

describe('parseParentArg (the watchdog of map and check)', () => {
  it('reads the command pid from --bl-parent, and parseAppArgs ignores it', () => {
    const argv = ['e', 'app', '--bl-cmd=check', '--bl-out=/o', '--bl-parent=4242'];
    expect(parseParentArg(argv)).toBe(4242);
    expect(parseAppArgs(argv, DEV)).toEqual({ cmd: 'check', check: { auto: false }, out: '/o', errors: [] });
    expect(parseAppArgs(['e', 'app', '--bl-parent=7', 'deck.html'], DEV)).toMatchObject({ cmd: 'open', files: ['deck.html'] });
  });

  it('anything but a positive integer is no parent', () => {
    for (const v of ['', '0', '-1', '12x', '1.5', '0x10', ' 3', '99999999999']) expect(parseParentArg(['e', `--bl-parent=${v}`]), v).toBeNull();
    expect(parseParentArg(['e', 'app'])).toBeNull();
    // The executable itself (argv[0]) is never read.
    expect(parseParentArg(['--bl-parent=5'])).toBeNull();
  });
});

describe('argument codecs and validators', () => {
  it('round-trips base64url JSON', () => {
    const v = { files: ['/ä/ü.html'], protected: false };
    expect(decodeArgs(encodeArgs(v))).toEqual({ ok: true, value: v });
  });

  it('validateOpenArgs rebuilds the object and refuses junk', () => {
    expect(validateOpenArgs({ files: ['/a'], protected: true, extra: 1 })).toEqual({ files: ['/a'], protected: true });
    expect(validateOpenArgs({ files: '/a' })).toBeNull();
    expect(validateOpenArgs({ files: ['a\0b'] })).toBeNull();
    expect(validateOpenArgs({ files: [''] })).toBeNull();
    expect(validateOpenArgs({ files: [], protected: 'yes' })).toBeNull();
    expect(validateOpenArgs([])).toBeNull();
    expect(validateOpenArgs(JSON.parse('{"__proto__": {"x": 1}, "files": []}'))).toEqual({ files: [], protected: false });
  });

  it('validateMapArgs: reducedMotion is a boolean, present only when true', () => {
    expect(validateMapArgs({ deck: '/d', reducedMotion: true })).toEqual({ deck: '/d', report: false, json: false, minCoverage: null, reducedMotion: true });
    expect(validateMapArgs({ deck: '/d', reducedMotion: false })).toEqual({ deck: '/d', report: false, json: false, minCoverage: null });
    expect(validateMapArgs({ deck: '/d', reducedMotion: 'yes' })).toBeNull();
  });

  it('validateMapArgs: coverage within 0..1', () => {
    expect(validateMapArgs({ deck: '/d' })).toEqual({ deck: '/d', report: false, json: false, minCoverage: null });
    expect(validateMapArgs({ deck: '/d', minCoverage: 1 })?.minCoverage).toBe(1);
    expect(validateMapArgs({ deck: '/d', minCoverage: -0.1 })).toBeNull();
    expect(validateMapArgs({ deck: '/d', minCoverage: Number.NaN })).toBeNull();
    expect(validateMapArgs({ deck: 1 })).toBeNull();
  });

  it('validateCheckArgs', () => {
    expect(validateCheckArgs({})).toEqual({ auto: false });
    expect(validateCheckArgs({ auto: 1 })).toBeNull();
  });

  it('second-instance data must be exactly the open shape', () => {
    const ok = { v: 1, cmd: 'open', files: ['/a.html'], protected: false, cwd: '/home' };
    expect(validateSecondInstanceData(ok)).toEqual(ok);
    expect(validateSecondInstanceData({ ...ok, cmd: 'map' })).toBeNull();
    expect(validateSecondInstanceData({ ...ok, v: 2 })).toBeNull();
    expect(validateSecondInstanceData({ ...ok, cwd: '' })).toBeNull();
    expect(validateSecondInstanceData(null)).toBeNull();
  });
});
