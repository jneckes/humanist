// open-file routing (6.1 Mechanics; 6.1: map and check run standalone). A file macOS delivers to a `map` or
// `check` process is handed to a regular instance instead of being swallowed.
import { describe, expect, it } from 'vitest';
import type { AppCommand } from '@blueline/core/ipc';
import { decodeArgs, parseAppArgs } from '../../../packages/app/src/main/args';
import { OpenFileRouter, handOffCommand, handOffToRegularInstance, type HandOffDeps, type SpawnLike } from '../../../packages/app/src/main/open-file';

function fakeSpawn(opts: { error?: Error; throws?: Error } = {}) {
  const calls: { command: string; args: readonly string[]; options: Parameters<SpawnLike>[2]; unref: number }[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    if (opts.throws) throw opts.throws;
    const call = { command, args, options, unref: 0 };
    calls.push(call);
    return {
      unref: () => void call.unref++,
      on: (_ev, listener) => {
        if (opts.error) listener(opts.error);
        return undefined;
      },
    };
  };
  return { spawn, calls };
}

function event() {
  const e = { prevented: 0, preventDefault: () => void e.prevented++ };
  return e;
}

function deps(over: Partial<HandOffDeps> = {}): HandOffDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    spawn: fakeSpawn().spawn,
    execPath: '/Applications/Blueline.app/Contents/MacOS/Blueline',
    defaultApp: false,
    appPath: '/Applications/Blueline.app/Contents/Resources/app.asar',
    noSandbox: false,
    env: { HOME: '/Users/josh' },
    log: (m) => logs.push(m),
    logs,
    ...over,
  };
}

describe('OpenFileRouter', () => {
  it('open: queues until the controller is ready, then delivers at once (as before)', () => {
    const handed: string[] = [];
    const r = new OpenFileRouter(() => 'open', (f) => handed.push(f));
    const e = event();
    r.onOpenFile(e, '/Users/josh/q4-plan.html');
    expect(e.prevented).toBe(1);
    const delivered: string[] = [];
    expect(r.start((o) => delivered.push(o.path))).toEqual([{ path: '/Users/josh/q4-plan.html', protected: false }]);
    r.onOpenFile(event(), '/Users/josh/b.html');
    r.queue({ path: '/x/c.html', protected: true });
    expect(delivered).toEqual(['/Users/josh/b.html', '/x/c.html']);
    expect(handed).toEqual([]);
  });

  for (const cmd of ['map', 'check'] as AppCommand[]) {
    it(`${cmd}: the event is handled (no "could not be opened") and the file goes to a regular instance, never into a queue nobody reads`, () => {
      const handed: string[] = [];
      const r = new OpenFileRouter(() => cmd, (f) => handed.push(f));
      const e = event();
      r.onOpenFile(e, '/Users/josh/q4-plan.html');
      expect(e.prevented).toBe(1);
      expect(handed).toEqual(['/Users/josh/q4-plan.html']);
      expect(r.start(() => undefined)).toEqual([]);
    });
  }
});

describe('handOffToRegularInstance', () => {
  it('packaged: spawns the same executable with the file, detached, stdio ignored, unref’d', () => {
    const { spawn, calls } = fakeSpawn();
    const d = deps({ spawn });
    handOffToRegularInstance('/Users/josh/q4-plan.html', d);
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.command).toBe('/Applications/Blueline.app/Contents/MacOS/Blueline');
    expect(c.options).toEqual({ detached: true, stdio: 'ignore', env: { HOME: '/Users/josh' } });
    expect(c.unref).toBe(1);
    // The new process opens the file: what it parses from this argv is `open` with exactly that file.
    expect(parseAppArgs([c.command, ...c.args], { defaultApp: false })).toEqual({ cmd: 'open', files: ['/Users/josh/q4-plan.html'], protected: false, errors: [] });
  });

  it('dev: the app folder comes first; --no-sandbox is kept when this process has it', () => {
    const cmd = handOffCommand('/d/-weird.html', { execPath: '/repo/node_modules/electron/dist/electron', defaultApp: true, appPath: '/repo/packages/app', noSandbox: true });
    expect(cmd.args.slice(0, 2)).toEqual(['--no-sandbox', '/repo/packages/app']);
    // A path that looks like a switch still arrives as a file.
    expect(parseAppArgs([cmd.command, ...cmd.args], { defaultApp: true })).toMatchObject({ cmd: 'open', files: ['/d/-weird.html'] });
    const enc = cmd.args.find((a) => a.startsWith('--bl-args='))!.slice('--bl-args='.length);
    expect(decodeArgs(enc)).toEqual({ ok: true, value: { files: ['/d/-weird.html'], protected: false } });
  });

  it('a spawn that fails is logged, never thrown into the open-file listener', () => {
    const failing = deps({ spawn: fakeSpawn({ error: new Error('spawn EACCES') }).spawn });
    expect(() => handOffToRegularInstance('/a.html', failing)).not.toThrow();
    expect(failing.logs.join('\n')).toMatch(/could not hand \/a\.html to Blueline: spawn EACCES/);
    const throwing = deps({ spawn: fakeSpawn({ throws: new Error('ENOMEM') }).spawn });
    expect(() => handOffToRegularInstance('/a.html', throwing)).not.toThrow();
    expect(throwing.logs.join('\n')).toMatch(/ENOMEM/);
  });
});
