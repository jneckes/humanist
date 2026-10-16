// The `blueline` command's launches (6.1 The command line tool; section 10, Mutation probe step 1), with
// stand-in programs instead of Electron and xvfb-run: `open` reports a launch that failed, and `map` and
// `check` pass a signal sent to the command alone on to the app and exit with the app's result.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OPEN_GRACE_MS, main } from '../../../packages/cli/src/index';

const posix = process.platform !== 'win32';
let dir: string;
let deck: string;
let fakeApp: string;
let fakeBin: string;
const savedEnv = { ...process.env };

/** A stand-in app: writes a CommandResult to --bl-out as FAKE_APP_MODE says. */
const FAKE_APP = `#!${process.execPath}
const fs = require('node:fs');
const os = require('node:os');
const arg = (k) => (process.argv.find((a) => a.startsWith(k + '=')) || '').slice(k.length + 1);
const out = arg('--bl-out');
const mark = process.env.FAKE_APP_MARK;
const write = (exitCode, text) => fs.writeFileSync(out, JSON.stringify({ command: 'check', exitCode, text, json: { text } }));
if (mark) fs.writeFileSync(mark + '.pid', String(process.pid));
const mode = process.env.FAKE_APP_MODE;
if (mode === 'signal') {
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(s, () => {
      const code = 128 + os.constants.signals[s];
      write(code, 'interrupted (' + s + ')');
      process.exit(code);
    });
  }
  setInterval(() => undefined, 1000);
} else if (mode === 'result0-exit1') {
  write(0, 'all passed');
  process.exit(1);
} else if (mode === 'no-result') {
  process.exit(0);
}
`;

/** A stand-in xvfb-run: runs its command as a child (as the real one does) and notes when it cleaned up. */
const FAKE_XVFB = `#!/bin/sh
shift 3
"$@"
code=$?
[ -n "$FAKE_XVFB_MARK" ] && echo "cleaned up after $code" > "$FAKE_XVFB_MARK"
exit $code
`;

function writeExe(p: string, text: string): void {
  fs.writeFileSync(p, text, { mode: 0o755 });
}

function setEnv(env: Record<string, string | undefined>): void {
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'BLUELINE_ELECTRON', 'BLUELINE_APP_DIR', 'FAKE_APP_MODE', 'FAKE_APP_MARK', 'FAKE_XVFB_MARK', 'PATH']) {
    if (k in env) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  }
}

function captureStderr(): { text: () => string } {
  let text = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return { text: () => text };
}

async function waitFor(pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-cli-index-'));
  deck = path.join(dir, 'deck.html');
  fs.writeFileSync(deck, '<!doctype html><title>x</title><p>Hello</p>');
  fakeApp = path.join(dir, 'fake-electron');
  writeExe(fakeApp, FAKE_APP);
  fakeBin = path.join(dir, 'bin');
  fs.mkdirSync(fakeBin);
  writeExe(path.join(fakeBin, 'xvfb-run'), FAKE_XVFB);
  fs.mkdirSync(path.join(dir, 'app'));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)('blueline open: a launch that fails exits 1 (6.1)', () => {
  it('the executable cannot run (EACCES): exit 1 with the reason', async () => {
    const err = captureStderr();
    setEnv({ DISPLAY: ':99', BLUELINE_ELECTRON: '/etc/hostname', BLUELINE_APP_DIR: path.join(dir, 'app') });
    expect(await main(['open', deck])).toBe(1);
    expect(err.text()).toMatch(/could not start the app: .*EACCES/);
    // The bare form too.
    expect(await main([deck])).toBe(1);
  });

  it('under xvfb-run (no display): the app failing inside xvfb-run is reported, exit 1', async () => {
    const err = captureStderr();
    // The stand-in xvfb-run runs /etc/hostname, which fails inside it (exit 126), as a bad Electron does.
    setEnv({ DISPLAY: undefined, WAYLAND_DISPLAY: undefined, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`, BLUELINE_ELECTRON: '/etc/hostname', BLUELINE_APP_DIR: path.join(dir, 'app') });
    expect(await main(['open', deck])).toBe(1);
    expect(err.text()).toMatch(/the app exited at once \(exit code 126\)/);
  });

  it('under xvfb-run: a running app (still running after the grace period) or a hand-off (exit 0) is success', async () => {
    captureStderr();
    const mark = path.join(dir, 'running');
    setEnv({ DISPLAY: undefined, WAYLAND_DISPLAY: undefined, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`, BLUELINE_ELECTRON: fakeApp, BLUELINE_APP_DIR: path.join(dir, 'app'), FAKE_APP_MODE: 'signal', FAKE_APP_MARK: mark });
    const t0 = Date.now();
    expect(await main(['open', deck])).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(OPEN_GRACE_MS - 50);
    await waitFor(() => fs.existsSync(`${mark}.pid`));
    const pid = Number(fs.readFileSync(`${mark}.pid`, 'utf8'));
    expect(alive(pid)).toBe(true);
    process.kill(pid, 'SIGTERM');
    setEnv({ FAKE_APP_MODE: 'no-result', FAKE_APP_MARK: undefined });
    expect(await main(['open', deck])).toBe(0);
  });

  it('with a display: a started app is success at once', async () => {
    captureStderr();
    setEnv({ DISPLAY: ':99', BLUELINE_ELECTRON: fakeApp, BLUELINE_APP_DIR: path.join(dir, 'app'), FAKE_APP_MODE: 'no-result' });
    const t0 = Date.now();
    expect(await main(['open', deck])).toBe(0);
    expect(Date.now() - t0).toBeLessThan(OPEN_GRACE_MS);
  });
});

describe.skipIf(!posix)('blueline check/map: signals sent to the command alone reach the app (6.1; section 10)', () => {
  it('with a display: SIGTERM to the command reaches the app, and the command exits with its result (143)', async () => {
    const out = captureStderr();
    const mark = path.join(dir, 'direct');
    setEnv({ DISPLAY: ':99', BLUELINE_ELECTRON: fakeApp, BLUELINE_APP_DIR: path.join(dir, 'app'), FAKE_APP_MODE: 'signal', FAKE_APP_MARK: mark });
    const run = main(['check']);
    await waitFor(() => fs.existsSync(`${mark}.pid`));
    const pid = Number(fs.readFileSync(`${mark}.pid`, 'utf8'));
    // As a CI timeout or a parent's child.kill() does: the signal reaches this process only.
    process.emit('SIGTERM', 'SIGTERM');
    expect(await run).toBe(143);
    expect(out.text()).toContain('interrupted (SIGTERM)');
    expect(alive(pid)).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });

  it('under xvfb-run: the signal goes to the app, not to xvfb-run, so xvfb-run still cleans up (130)', async () => {
    const out = captureStderr();
    const mark = path.join(dir, 'xvfb');
    const xvfbMark = path.join(dir, 'xvfb-cleaned');
    setEnv({
      DISPLAY: undefined,
      WAYLAND_DISPLAY: undefined,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      BLUELINE_ELECTRON: fakeApp,
      BLUELINE_APP_DIR: path.join(dir, 'app'),
      FAKE_APP_MODE: 'signal',
      FAKE_APP_MARK: mark,
      FAKE_XVFB_MARK: xvfbMark,
    });
    const run = main(['check']);
    await waitFor(() => fs.existsSync(`${mark}.pid`));
    const pid = Number(fs.readFileSync(`${mark}.pid`, 'utf8'));
    process.emit('SIGINT', 'SIGINT');
    expect(await run).toBe(130);
    expect(out.text()).toContain('interrupted (SIGINT)');
    expect(alive(pid)).toBe(false);
    // xvfb-run was not signalled: it saw its command end and ran its cleanup (the real one stops Xvfb there).
    expect(fs.readFileSync(xvfbMark, 'utf8')).toBe('cleaned up after 130\n');
  });

  it("exits with the result's exit code, not the process status (xvfb-run reports its own)", async () => {
    captureStderr();
    setEnv({ DISPLAY: ':99', BLUELINE_ELECTRON: fakeApp, BLUELINE_APP_DIR: path.join(dir, 'app'), FAKE_APP_MODE: 'result0-exit1', FAKE_APP_MARK: undefined });
    expect(await main(['check'])).toBe(0);
    setEnv({ FAKE_APP_MODE: 'no-result' });
    const err = captureStderr();
    expect(await main(['check'])).toBe(1);
    expect(err.text()).toContain('without a result');
  });

  it('tells the app its pid (--bl-parent), so the app stops if the command is killed outright', async () => {
    captureStderr();
    const argsFile = path.join(dir, 'argv.json');
    const recorder = path.join(dir, 'record-argv');
    writeExe(recorder, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n`);
    setEnv({ DISPLAY: ':99', BLUELINE_ELECTRON: recorder, BLUELINE_APP_DIR: path.join(dir, 'app') });
    await main(['check', '--auto']);
    const argv = JSON.parse(fs.readFileSync(argsFile, 'utf8')) as string[];
    expect(argv).toContain(`--bl-parent=${process.pid}`);
    expect(argv.some((a) => a.startsWith('--bl-out='))).toBe(true);
  });
});
