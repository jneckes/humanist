// The native helpers (6.1 Becoming the default app, 9.6 native/, 9.9): the JSON-lines client with a fake child
// (ids, out-of-order replies, timeouts, crash and restart with backoff, giving up, dispose), the macOS helper and
// its /usr/bin/xattr fallback, the Windows Default Apps link and registry reads, and Linux.
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  HelperClient,
  HelperExitedError,
  HelperTimeoutError,
  REGISTERED_APP_NAME,
  WINDOWS_PROG_ID,
  appBundleOf,
  createNativeHelper,
  defaultAppsUri,
  findHelperBinary,
  parseRegValue,
  quarantineValue,
  supportsRegisteredAppLink,
  windowsBuildOf,
  type ChildLike,
  type ExecFn,
  type SpawnFn,
} from '../../../packages/app/src/main/native-helper';

// ------------------------------------------------------------------------------------------- a fake helper

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly lines: Record<string, unknown>[] = [];
  readonly signals: string[] = [];
  exited = false;
  private buf = '';
  /** Answers each request as it arrives (null: leave it pending). */
  responder: ((req: Record<string, unknown>) => Record<string, unknown> | null) | null = null;

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(this.buf.slice(0, nl)) as Record<string, unknown>;
        this.buf = this.buf.slice(nl + 1);
        this.lines.push(req);
        const r = this.responder?.(req);
        if (r) this.reply({ id: req.id, ...r });
      }
    });
  }

  reply(o: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(o) + '\n');
  }

  raw(s: string): void {
    this.stdout.write(s);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    this.crash(null, signal ?? 'SIGTERM');
    return true;
  }

  crash(code: number | null = 1, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => this.emit('exit', code, signal));
  }
}

function harness(o: { responder?: FakeChild['responder']; backoffMs?: number[]; maxCrashes?: number; timeoutMs?: number } = {}) {
  const children: FakeChild[] = [];
  const spawns: [string, readonly string[]][] = [];
  const spawn: SpawnFn = (file, args) => {
    spawns.push([file, args]);
    const c = new FakeChild();
    c.responder = o.responder ?? null;
    children.push(c);
    return c;
  };
  let now = 1_000;
  const logs: string[] = [];
  const client = new HelperClient({
    binary: '/x/blueline-helper',
    spawn,
    backoffMs: o.backoffMs ?? [0],
    maxCrashes: o.maxCrashes,
    timeoutMs: o.timeoutMs,
    now: () => now,
    log: (m) => logs.push(m),
  });
  return { client, children, spawns, logs, advance: (ms: number) => (now += ms) };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('HelperClient (JSON lines)', () => {
  it('starts the helper lazily, once, and sends one line per request with an id', async () => {
    const h = harness({ responder: (req) => ({ ok: true, echo: req.op }) });
    expect(h.spawns).toHaveLength(0);
    const [a, b] = await Promise.all([h.client.request('readQuarantine', { path: '/a' }), h.client.request('copyXattrs', { from: '/a', to: '/b' })]);
    expect(h.spawns).toEqual([['/x/blueline-helper', []]]);
    expect(h.client.starts).toBe(1);
    expect(h.children[0].lines).toEqual([
      { path: '/a', op: 'readQuarantine', id: 1 },
      { from: '/a', to: '/b', op: 'copyXattrs', id: 2 },
    ]);
    expect(a).toMatchObject({ id: 1, ok: true, echo: 'readQuarantine' });
    expect(b).toMatchObject({ id: 2, ok: true, echo: 'copyXattrs' });
  });

  it('an argument cannot replace the op or the id', async () => {
    const h = harness({ responder: () => ({ ok: true }) });
    await h.client.request('readQuarantine', { op: 'setDefaultHtmlApp', id: 99, path: '/a' });
    expect(h.children[0].lines[0]).toEqual({ op: 'readQuarantine', id: 1, path: '/a' });
  });

  it('matches out-of-order replies by id, across split chunks, and ignores junk', async () => {
    const h = harness();
    const p1 = h.client.request('setDefaultHtmlApp', { app: '/A.app' });
    const p2 = h.client.request('readQuarantine', { path: '/a' });
    await tick();
    const c = h.children[0];
    c.raw('not json\n');
    c.raw('[1,2]\n');
    c.raw('{"id": 77, "ok": true}\n'); // unknown id
    c.raw('{"id": 2, "ok": "yes"}\n'); // ok must be a boolean
    c.raw('{"id": 2, "ok": tr');
    c.raw('ue, "value": null}\n{"id": 1, "ok": false, "error": "no", "declined": true}\n');
    await expect(p2).resolves.toMatchObject({ id: 2, ok: true, value: null });
    await expect(p1).resolves.toMatchObject({ id: 1, ok: false, error: 'no', declined: true });
    expect(h.logs.filter((l) => l.includes('not JSON'))).toHaveLength(1);
  });

  it('a request not answered in time fails and the hung helper is killed, then started again', async () => {
    const h = harness({ timeoutMs: 20 });
    await expect(h.client.request('readQuarantine', { path: '/a' })).rejects.toBeInstanceOf(HelperTimeoutError);
    expect(h.children[0].signals).toEqual(['SIGTERM']);
    h.children.length = 0;
    const p = h.client.request('readQuarantine', { path: '/b' });
    await tick();
    expect(h.client.starts).toBe(2);
    h.children[0].reply({ id: 2, ok: true, value: null });
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it('a request that waits for a person is not killed on timeout (setDefaultHtmlApp)', async () => {
    const h = harness();
    const p = h.client.request('setDefaultHtmlApp', { app: '/A.app' }, { timeoutMs: 20, killOnTimeout: false });
    await expect(p).rejects.toBeInstanceOf(HelperTimeoutError);
    expect(h.children[0].signals).toEqual([]);
    // Its late reply is dropped; the helper keeps serving.
    h.children[0].reply({ id: 1, ok: true });
    h.children[0].responder = () => ({ ok: true, value: null });
    await expect(h.client.request('readQuarantine', { path: '/a' })).resolves.toMatchObject({ id: 2, ok: true });
    expect(h.client.starts).toBe(1);
  });

  it('a crash fails the pending requests; the next request restarts it after the backoff', async () => {
    const h = harness({ backoffMs: [50, 500] });
    const p = h.client.request('readQuarantine', { path: '/a' });
    await tick();
    h.children[0].crash(1);
    await expect(p).rejects.toBeInstanceOf(HelperExitedError);
    expect(h.client.running).toBe(false);
    const t0 = Date.now();
    h.children.length = 0;
    const q = h.client.request('readQuarantine', { path: '/b' });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.client.starts).toBe(1); // still waiting out the backoff
    await new Promise((r) => setTimeout(r, 60));
    expect(h.client.starts).toBe(2);
    h.children[0].reply({ id: 2, ok: true, value: null });
    await expect(q).resolves.toMatchObject({ ok: true });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });

  it('gives up after repeated crashes in a row; a good reply resets the count', async () => {
    const h = harness({ maxCrashes: 3 });
    for (let i = 0; i < 2; i++) {
      const p = h.client.request('readQuarantine', { path: '/a' });
      await tick();
      h.children[h.children.length - 1].crash(1);
      await expect(p).rejects.toBeInstanceOf(HelperExitedError);
    }
    // A good reply: the count starts over.
    const ok = h.client.request('readQuarantine', { path: '/a' });
    await tick();
    h.children[h.children.length - 1].reply({ id: 3, ok: true, value: null });
    await ok;
    for (let i = 0; i < 3; i++) {
      const p = h.client.request('readQuarantine', { path: '/a' });
      await tick();
      h.children[h.children.length - 1].crash(1);
      await expect(p).rejects.toBeInstanceOf(HelperExitedError);
    }
    expect(h.client.broken).toBe(true);
    await expect(h.client.request('readQuarantine', { path: '/a' })).rejects.toThrow(/not available/);
    expect(h.logs.some((l) => /not starting it again/.test(l))).toBe(true);
  });

  it('a reply line that never ends is a protocol error: the helper is killed', async () => {
    const h = harness();
    const p = h.client.request('readQuarantine', { path: '/a' });
    await tick();
    h.children[0].raw('x'.repeat(1024 * 1024 + 10));
    await expect(p).rejects.toBeInstanceOf(HelperExitedError);
    expect(h.children[0].signals).toEqual(['SIGTERM']);
  });

  it('a request too large for the helper is refused before it is sent', async () => {
    const h = harness({ responder: () => ({ ok: true }) });
    await expect(h.client.request('setQuarantine', { path: '/a', value: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow(/too large/);
    expect(h.children.flatMap((c) => c.lines)).toHaveLength(0);
  });

  it('dispose() kills the helper (app quit), fails pending requests and refuses new ones', async () => {
    const h = harness();
    const p = h.client.request('readQuarantine', { path: '/a' });
    await tick();
    h.client.dispose();
    await expect(p).rejects.toBeInstanceOf(HelperExitedError);
    expect(h.children[0].signals).toEqual(['SIGTERM']);
    await expect(h.client.request('readQuarantine', { path: '/a' })).rejects.toBeInstanceOf(HelperExitedError);
    expect(h.client.starts).toBe(1);
  });

  it('stderr is logged, bounded', async () => {
    const h = harness({ responder: () => ({ ok: true }) });
    await h.client.request('readQuarantine', { path: '/a' });
    h.children[0].stderr.write('warning: something\n');
    await tick();
    expect(h.logs.some((l) => l.includes('warning: something'))).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------- macOS

const Q = '0083;65f1c2a3;Safari;6E1F6E7C-1C1B-4B8E-9D2E-123456789ABC';

function mac(o: { responder?: FakeChild['responder']; appBundle?: string | null; binary?: string | null; exec?: ExecFn } = {}) {
  const children: FakeChild[] = [];
  const logs: string[] = [];
  const helper = createNativeHelper({
    platform: 'darwin',
    binary: o.binary === undefined ? '/x/blueline-helper' : o.binary,
    appBundle: o.appBundle === undefined ? '/Applications/Blueline.app' : o.appBundle,
    spawn: () => {
      const c = new FakeChild();
      c.responder = o.responder ?? null;
      children.push(c);
      return c;
    },
    exec: o.exec,
    log: (m) => logs.push(m),
    client: { backoffMs: [0] },
  });
  return { helper, children, logs };
}

describe('macOS helper', () => {
  it('readQuarantine: the whole value, none, or a failure', async () => {
    const values: Record<string, unknown> = { '/a': Q, '/b': null };
    const { helper, children } = mac({
      responder: (req) => (req.path === '/c' ? { ok: false, error: 'getxattr: Permission denied' } : req.path === '/d' ? { ok: true, value: 'x'.repeat(70 * 1024) } : { ok: true, value: values[String(req.path)] }),
    });
    expect(helper.mode).toBe('helper');
    expect(await helper.readQuarantine('/a')).toEqual({ ok: true, value: Q });
    expect(await helper.readQuarantine('/b')).toEqual({ ok: true, value: null });
    expect(await helper.readQuarantine('/c')).toEqual({ ok: false, error: 'getxattr: Permission denied' });
    expect((await helper.readQuarantine('/d')).ok).toBe(false);
    expect((await helper.readQuarantine('relative')).ok).toBe(false);
    expect(children[0].lines.map((l) => l.op)).toEqual(['readQuarantine', 'readQuarantine', 'readQuarantine', 'readQuarantine']);
  });

  it('copyXattrs and setQuarantine send their requests; a failure throws', async () => {
    const { helper, children } = mac({ responder: (req) => (req.to === '/fail' || req.path === '/fail' ? { ok: false, error: 'copyfile: No space left' } : { ok: true, value: Q }) });
    await helper.copyXattrs('/deck.html', '/.bl-write-1.tmp');
    await expect(helper.copyXattrs('/deck.html', '/fail')).rejects.toThrow(/copyfile/);
    await helper.setQuarantine('/copy.html', { value: Q });
    await helper.setQuarantine('/data.csv', { properties: { agent: 'Blueline', originUrl: 'file:///d/deck.html', dataUrl: 'https://x/data.csv' } });
    await expect(helper.setQuarantine('/fail', { value: Q })).rejects.toThrow();
    await expect(helper.setQuarantine('/x', { value: 'bad\nvalue' })).rejects.toThrow(/not a quarantine value/);
    await expect(helper.copyXattrs('rel', '/b')).rejects.toThrow(/absolute/);
    expect(children[0].lines.slice(0, 4)).toEqual([
      { from: '/deck.html', to: '/.bl-write-1.tmp', op: 'copyXattrs', id: 1 },
      { from: '/deck.html', to: '/fail', op: 'copyXattrs', id: 2 },
      { path: '/copy.html', value: Q, op: 'setQuarantine', id: 3 },
      { path: '/data.csv', properties: { agent: 'Blueline', originUrl: 'file:///d/deck.html', dataUrl: 'https://x/data.csv' }, op: 'setQuarantine', id: 4 },
    ]);
  });

  it('isDefaultHtmlApp: compared with the app bundle; a development run cannot set it', async () => {
    const yes = mac({ responder: () => ({ ok: true, isDefault: true, current: '/Applications/Blueline.app', currentName: 'Blueline' }) });
    expect(await yes.helper.isDefaultHtmlApp()).toEqual({ known: true, isDefault: true, current: null, action: 'set', reason: null });
    expect(yes.children[0].lines[0]).toEqual({ app: '/Applications/Blueline.app', op: 'isDefaultHtmlApp', id: 1 });
    const no = mac({ responder: () => ({ ok: true, isDefault: false, current: '/Applications/Safari.app', currentName: 'Safari' }) });
    expect(await no.helper.isDefaultHtmlApp()).toEqual({ known: true, isDefault: false, current: 'Safari', action: 'set', reason: null });
    const dev = mac({ appBundle: null, responder: () => ({ ok: true, isDefault: true, current: '/Applications/Safari.app', currentName: 'Safari' }) });
    const d = await dev.helper.isDefaultHtmlApp();
    expect(d).toMatchObject({ known: true, isDefault: false, current: 'Safari', action: 'none' });
    expect(d.reason).toMatch(/installed Blueline/);
  });

  it('setDefaultHtmlApp: ok, declined (macOS 26.4 Keep), or an error; waits without killing', async () => {
    const ok = mac({ responder: () => ({ ok: true }) });
    expect(await ok.helper.setDefaultHtmlApp()).toEqual({ ok: true });
    expect(ok.children[0].lines[0]).toEqual({ app: '/Applications/Blueline.app', op: 'setDefaultHtmlApp', id: 1 });
    const declined = mac({ responder: () => ({ ok: false, error: 'The operation couldn’t be completed.', declined: true, domain: 'NSCocoaErrorDomain', code: 3072 }) });
    expect(await declined.helper.setDefaultHtmlApp()).toMatchObject({ ok: false, declined: true });
    const failed = mac({ responder: () => ({ ok: false, error: 'not an application bundle' }) });
    expect(await failed.helper.setDefaultHtmlApp()).toEqual({ ok: false, reason: 'not an application bundle' });
    const dev = mac({ appBundle: null, responder: () => ({ ok: true }) });
    expect(await dev.helper.setDefaultHtmlApp()).toMatchObject({ ok: false });
    expect(dev.children).toHaveLength(0); // never asked
  });

  it('without the binary: /usr/bin/xattr for the marker (said once), no default app', async () => {
    const calls: string[][] = [];
    const attrs = new Map<string, string>([['/a', Q]]);
    const exec: ExecFn = async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === '-p') {
        const v = attrs.get(args[2]);
        return v ? { code: 0, stdout: `${v}\n`, stderr: '' } : { code: 1, stdout: '', stderr: `xattr: ${args[2]}: No such xattr: com.apple.quarantine` };
      }
      if (args[0] === '-w') {
        attrs.set(args[3], args[2]);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 2, stdout: '', stderr: 'usage' };
    };
    const { helper, logs } = mac({ binary: null, exec });
    expect(helper.mode).toBe('xattr');
    expect(await helper.readQuarantine('/a')).toEqual({ ok: true, value: Q });
    expect(await helper.readQuarantine('/none')).toEqual({ ok: true, value: null });
    await helper.copyXattrs('/a', '/tmp-1');
    expect(attrs.get('/tmp-1')).toBe(Q);
    await helper.copyXattrs('/none', '/tmp-2');
    expect(attrs.has('/tmp-2')).toBe(false);
    await helper.setQuarantine('/c', { value: Q });
    await helper.setQuarantine('/d', { properties: { agent: 'Blueline' } });
    expect(attrs.get('/d')).toMatch(/^0081;[0-9a-f]{8};Blueline;$/);
    await expect(helper.setQuarantine('/e', { value: '-n evil' })).rejects.toThrow();
    expect(calls[0]).toEqual(['/usr/bin/xattr', '-p', 'com.apple.quarantine', '/a']);
    expect(calls).toContainEqual(['/usr/bin/xattr', '-w', 'com.apple.quarantine', Q, '/tmp-1']);
    expect(await helper.setDefaultHtmlApp()).toMatchObject({ ok: false });
    expect((await helper.isDefaultHtmlApp()).action).toBe('none');
    expect(logs.filter((l) => /not found; quarantine markers go through \/usr\/bin\/xattr/.test(l))).toHaveLength(1);
  });

  it('an xattr failure fails the copy (a write must not drop the marker)', async () => {
    const { helper } = mac({ binary: null, exec: async () => ({ code: 13, stdout: '', stderr: 'Permission denied' }) });
    expect((await helper.readQuarantine('/a')).ok).toBe(false);
    await expect(helper.copyXattrs('/a', '/b')).rejects.toThrow(/quarantine marker/);
  });

  it('falls back to xattr once the helper is given up', async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: `${Q}\n`, stderr: '' });
    const children: FakeChild[] = [];
    const logs: string[] = [];
    const helper = createNativeHelper({
      platform: 'darwin',
      binary: '/x/blueline-helper',
      appBundle: '/Applications/Blueline.app',
      spawn: () => {
        const c = new FakeChild();
        children.push(c);
        setImmediate(() => c.crash(134));
        return c;
      },
      exec,
      log: (m) => logs.push(m),
      client: { backoffMs: [0], maxCrashes: 2 },
    });
    expect((await helper.readQuarantine('/a')).ok).toBe(false);
    expect((await helper.readQuarantine('/a')).ok).toBe(false);
    expect(helper.mode).toBe('xattr');
    expect(await helper.readQuarantine('/a')).toEqual({ ok: true, value: Q });
    expect(logs.some((l) => /not available; quarantine markers go through \/usr\/bin\/xattr/.test(l))).toBe(true);
  });

  it('quarantineValue: flags;hex seconds;agent;', () => {
    expect(quarantineValue('Blueline', 0x65f1c2a3 * 1000)).toBe('0081;65f1c2a3;Blueline;');
    expect(quarantineValue('Blue;line\n', 0)).toBe('0081;00000000;Blueline;');
    expect(quarantineValue('', 0)).toBe('0081;00000000;Blueline;');
  });

  it('findHelperBinary: Resources/helper when packaged (never the checkout), native/macos/build in development', () => {
    const seen: string[] = [];
    const ok = (p: string) => (seen.push(p), true);
    expect(findHelperBinary({ isPackaged: true, resourcesPath: '/Applications/Blueline.app/Contents/Resources', distDir: '/repo/packages/app/dist', isExecutableFile: ok })).toBe(
      '/Applications/Blueline.app/Contents/Resources/helper/blueline-helper',
    );
    expect(findHelperBinary({ isPackaged: false, distDir: '/repo/packages/app/dist', isExecutableFile: ok })).toBe(path.resolve('/repo/native/macos/build/blueline-helper'));
    expect(findHelperBinary({ isPackaged: true, distDir: '/repo/packages/app/dist', isExecutableFile: ok })).toBeNull();
    expect(findHelperBinary({ isPackaged: false, distDir: '/repo/packages/app/dist', isExecutableFile: () => false })).toBeNull();
    expect(seen.every((p) => !p.includes('/repo/') || !p.includes('Resources'))).toBe(true);
    // The real checkout: the dev path is native/macos/build relative to packages/app/dist.
    const real = findHelperBinary({ isPackaged: false, distDir: path.resolve(__dirname, '../../../packages/app/dist'), isExecutableFile: (p) => (seen.push(p), false) });
    expect(real).toBeNull();
    expect(seen[seen.length - 1]).toBe(path.resolve(__dirname, '../../../native/macos/build/blueline-helper'));
  });

  it('appBundleOf: the .app of a packaged executable', () => {
    expect(appBundleOf('/Applications/Blueline.app/Contents/MacOS/Blueline')).toBe('/Applications/Blueline.app');
    expect(appBundleOf('/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')).toBe('/repo/node_modules/electron/dist/Electron.app');
    expect(appBundleOf('/usr/local/bin/blueline')).toBeNull();
    expect(appBundleOf('/x/Contents/MacOS/Blueline')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------- Windows

describe('Windows: Default Apps settings (6.1)', () => {
  it('supportsRegisteredAppLink: Windows 11 21H2 with the 2023-04 update or later', () => {
    const cases: [number | null, number | null, boolean][] = [
      [19045, 3803, false], // Windows 10 22H2
      [22000, 1816, false], // 21H2 before KB5025224
      [22000, 1817, true], // 21H2, KB5025224 (2023-04)
      [22000, null, false], // update revision unknown: the plain page
      [22621, 1634, false], // 22H2 before KB5025305
      [22621, 1635, true], // 22H2, KB5025305 (2023-04 preview)
      [22621, null, false],
      [22631, null, true], // 23H2
      [26100, null, true], // 24H2
      [26200, 0, true], // 25H2
      [22500, 100, false], // an Insider build between releases
      [null, null, false],
    ];
    for (const [build, ubr, want] of cases) expect(supportsRegisteredAppLink(build, ubr), `${build}.${ubr}`).toBe(want);
  });

  it('defaultAppsUri: registeredAppUser / registeredAppMachine / plain', () => {
    expect(defaultAppsUri({ build: 26100, ubr: null, scope: 'user' })).toBe('ms-settings:defaultapps?registeredAppUser=Blueline');
    expect(defaultAppsUri({ build: 26100, ubr: null, scope: 'machine' })).toBe('ms-settings:defaultapps?registeredAppMachine=Blueline');
    expect(defaultAppsUri({ build: 26100, ubr: null, scope: 'none' })).toBe('ms-settings:defaultapps');
    expect(defaultAppsUri({ build: 19045, ubr: 1, scope: 'user' })).toBe('ms-settings:defaultapps');
    expect(REGISTERED_APP_NAME).toBe('Blueline');
  });

  it('windowsBuildOf reads os.release()', () => {
    expect(windowsBuildOf('10.0.22621')).toBe(22621);
    expect(windowsBuildOf('10.0.19045')).toBe(19045);
    expect(windowsBuildOf('garbage')).toBeNull();
  });

  it('parseRegValue reads reg.exe output', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.html\\UserChoice\r\n    Hash    REG_SZ    abc=\r\n    ProgId    REG_SZ    ChromeHTML\r\n\r\n';
    expect(parseRegValue(out, 'ProgId')).toEqual({ type: 'REG_SZ', data: 'ChromeHTML' });
    expect(parseRegValue('    UBR    REG_DWORD    0x719\r\n', 'ubr')).toEqual({ type: 'REG_DWORD', data: '0x719' });
    expect(parseRegValue('    Blueline    REG_SZ    Software\\Blueline\\Capabilities\r\n', 'Blueline')?.data).toBe('Software\\Blueline\\Capabilities');
    expect(parseRegValue('ERROR: The system was unable to find the specified registry key or value.', 'ProgId')).toBeNull();
  });

  function win(reg: Record<string, string>, o: { release?: string; open?: (u: string) => Promise<void> } = {}) {
    const calls: string[][] = [];
    const opened: string[] = [];
    const exec: ExecFn = async (file, args) => {
      calls.push([file, ...args]);
      const key = `${args[1]}|${args[3]}`;
      return key in reg ? { code: 0, stdout: `\r\n${args[1]}\r\n    ${args[3]}    ${reg[key]}\r\n\r\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'ERROR: not found' };
    };
    const helper = createNativeHelper({
      platform: 'win32',
      exec,
      env: { SystemRoot: 'C:\\Windows' },
      osRelease: () => o.release ?? '10.0.26100',
      openExternal: o.open ?? (async (u) => void opened.push(u)),
    });
    return { helper, calls, opened };
  }
  const USER = 'HKCU\\Software\\RegisteredApplications|Blueline';
  const MACHINE = 'HKLM\\Software\\RegisteredApplications|Blueline';
  const UBR = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion|UBR';

  it('opens Blueline’s page for the hive the installer wrote, with reg.exe from System32', async () => {
    const u = win({ [USER]: 'REG_SZ    Software\\Blueline\\Capabilities' });
    expect(await u.helper.setDefaultHtmlApp()).toEqual({ ok: true, openedSettings: true });
    expect(u.opened).toEqual(['ms-settings:defaultapps?registeredAppUser=Blueline']);
    expect(u.calls[0][0]).toBe('C:\\Windows\\System32\\reg.exe');
    const m = win({ [MACHINE]: 'REG_SZ    Software\\Blueline\\Capabilities' });
    await m.helper.setDefaultHtmlApp();
    expect(m.opened).toEqual(['ms-settings:defaultapps?registeredAppMachine=Blueline']);
    const none = win({});
    await none.helper.setDefaultHtmlApp();
    expect(none.opened).toEqual(['ms-settings:defaultapps']);
  });

  it('on 21H2 and 22H2 the update revision decides; Windows 10 gets the plain page', async () => {
    const ok = win({ [USER]: 'REG_SZ    x', [UBR]: 'REG_DWORD    0x719' }, { release: '10.0.22000' });
    await ok.helper.setDefaultHtmlApp();
    expect(ok.opened).toEqual(['ms-settings:defaultapps?registeredAppUser=Blueline']);
    const old = win({ [USER]: 'REG_SZ    x', [UBR]: 'REG_DWORD    0x718' }, { release: '10.0.22000' });
    await old.helper.setDefaultHtmlApp();
    expect(old.opened).toEqual(['ms-settings:defaultapps']);
    const w10 = win({ [USER]: 'REG_SZ    x' }, { release: '10.0.19045' });
    await w10.helper.setDefaultHtmlApp();
    expect(w10.opened).toEqual(['ms-settings:defaultapps']);
    expect(w10.calls.some((c) => c.includes('UBR'))).toBe(false); // read only where it decides
  });

  it('a failure to open settings is reported', async () => {
    const f = win({}, { open: async () => Promise.reject(new Error('no handler')) });
    expect(await f.helper.setDefaultHtmlApp()).toMatchObject({ ok: false, reason: expect.stringMatching(/no handler/) });
  });

  it('isDefaultHtmlApp reads the user’s choice for .html (UserChoiceLatest, then UserChoice)', async () => {
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.html';
    const latest = win({ [`${base}\\UserChoiceLatest|ProgId`]: `REG_SZ    ${WINDOWS_PROG_ID}`, [`${base}\\UserChoice|ProgId`]: 'REG_SZ    ChromeHTML' });
    expect(await latest.helper.isDefaultHtmlApp()).toEqual({ known: true, isDefault: true, current: null, action: 'open-settings', reason: null });
    const chrome = win({ [`${base}\\UserChoice|ProgId`]: 'REG_SZ    ChromeHTML' });
    expect(await chrome.helper.isDefaultHtmlApp()).toMatchObject({ known: true, isDefault: false });
    const unknown = win({});
    expect(await unknown.helper.isDefaultHtmlApp()).toMatchObject({ known: false, isDefault: false, action: 'open-settings' });
  });

  it('has no helper process; quarantine operations are no-ops (markers.ts handles Zone.Identifier)', async () => {
    const { helper } = win({});
    expect(helper.mode).toBe('windows');
    expect(await helper.readQuarantine('C:\\x')).toEqual({ ok: true, value: null });
    await helper.copyXattrs('C:\\a', 'C:\\b');
    await helper.setQuarantine('C:\\a', { value: Q });
  });
});

describe('Linux and others', () => {
  it('no markers; the default app is not set here', async () => {
    const h = createNativeHelper({ platform: 'linux' });
    expect(h.mode).toBe('none');
    expect(await h.readQuarantine('/a')).toEqual({ ok: true, value: null });
    expect(await h.setDefaultHtmlApp()).toMatchObject({ ok: false });
    expect(await h.isDefaultHtmlApp()).toMatchObject({ known: false, action: 'none', reason: expect.stringMatching(/Linux/) });
  });
});
