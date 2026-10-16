// The `blueline` command line (6.1).
import { describe, expect, it } from 'vitest';
import { LATER, encodeAppArgs, parseCli, parseCoverage } from '../../../packages/cli/src/args';
import { decodeArgs } from '../../../packages/app/src/main/args';

describe('parseCli', () => {
  it('blueline <file> = blueline open <file>', () => {
    expect(parseCli(['deck.html'])).toEqual({ kind: 'open', files: ['deck.html'], protected: false });
    expect(parseCli(['open', 'deck.html'])).toEqual({ kind: 'open', files: ['deck.html'], protected: false });
    expect(parseCli(['deck.html', '--protected'])).toEqual({ kind: 'open', files: ['deck.html'], protected: true });
    expect(parseCli(['open', '--protected', 'a.html', 'b.htm'])).toEqual({ kind: 'open', files: ['a.html', 'b.htm'], protected: true });
    expect(parseCli(['open', '--', '--weird.html'])).toEqual({ kind: 'open', files: ['--weird.html'], protected: false });
  });

  it('open needs a file and refuses unknown options', () => {
    expect(parseCli(['open']).kind).toBe('usage');
    expect(parseCli(['open', '--net', 'a.html']).kind).toBe('usage');
    expect(parseCli([]).kind).toBe('usage');
  });

  it('map <deck> [--report] [--json] [--min-coverage N]', () => {
    expect(parseCli(['map', 'deck.html', '--report'])).toEqual({ kind: 'map', deck: 'deck.html', report: true, json: false, minCoverage: null, reducedMotion: false });
    expect(parseCli(['map', 'deck.html', '--reduced-motion'])).toMatchObject({ kind: 'map', reducedMotion: true });
    expect(parseCli(['map', '--json', 'deck.html', '--min-coverage', '0.95'])).toEqual({ kind: 'map', deck: 'deck.html', report: false, json: true, minCoverage: 0.95, reducedMotion: false });
    expect(parseCli(['map', 'deck.html', '--min-coverage=1'])).toMatchObject({ minCoverage: 1 });
    expect(parseCli(['map']).kind).toBe('usage');
    expect(parseCli(['map', 'a.html', 'b.html']).kind).toBe('usage');
    expect(parseCli(['map', 'a.html', '--min-coverage', '95']).kind).toBe('usage');
    expect(parseCli(['map', 'a.html', '--min-coverage']).kind).toBe('usage');
    expect(parseCli(['map', 'a.html', '--fast']).kind).toBe('usage');
  });

  it('check [--auto] [--json]', () => {
    expect(parseCli(['check'])).toEqual({ kind: 'check', auto: false, json: false });
    expect(parseCli(['check', '--auto', '--json'])).toEqual({ kind: 'check', auto: true, json: true });
    expect(parseCli(['check', 'x']).kind).toBe('usage');
  });

  it('pdf, export, mcp and attach arrive in later phases', () => {
    expect(parseCli(['pdf', 'deck.html'])).toEqual({ kind: 'later', name: 'pdf', phase: 1 });
    expect(parseCli(['export', 'deck.html'])).toEqual({ kind: 'later', name: 'export', phase: 3 });
    expect(parseCli(['mcp'])).toEqual({ kind: 'later', name: 'mcp', phase: 4 });
    expect(parseCli(['attach', 'd.html', 'memo.m4a'])).toEqual({ kind: 'later', name: 'attach', phase: 5 });
    expect(Object.keys(LATER).sort()).toEqual(['attach', 'export', 'mcp', 'pdf']);
  });

  it('help and version', () => {
    expect(parseCli(['--help'])).toEqual({ kind: 'help' });
    expect(parseCli(['-h'])).toEqual({ kind: 'help' });
    expect(parseCli(['--version'])).toEqual({ kind: 'version' });
  });

  it('parseCoverage accepts 0..1 only', () => {
    expect(parseCoverage('0.95')).toBe(0.95);
    expect(parseCoverage('.5')).toBe(0.5);
    expect(parseCoverage('0')).toBe(0);
    expect(parseCoverage('1')).toBe(1);
    for (const bad of ['1.5', '95', '-0.1', 'abc', '', '0x1', '1e-1', undefined]) expect(parseCoverage(bad as string)).toBeNull();
  });

  it('--bl-args encoding round-trips through the app parser', () => {
    const v = { deck: '/Users/j/Q4 plan — final.html', report: true, json: true, minCoverage: 0.9 };
    expect(decodeArgs(encodeAppArgs(v))).toEqual({ ok: true, value: v });
  });
});
