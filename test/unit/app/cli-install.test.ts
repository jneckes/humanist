// Help › Install Command Line Tool (6.1): where the `blueline` link goes on each platform, that only a previous
// Blueline link is ever replaced, the PATH check against the login shell, the macOS administrator prompt's
// arguments, and the Windows wrapper. Real files in temp folders for macOS and Linux decisions (the platform is
// injected), an in-memory file system for Windows paths.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SHIM_MARKER,
  WRAPPER_MARKER,
  classifyExisting,
  cliInstallMessage,
  installCommandLineTool,
  isBluelineCommandPath,
  isOnPath,
  nodeCliFs,
  osascriptArgs,
  parsePathLine,
  pathHint,
  readLoginShellPath,
  runAsAdminMac,
  shippedCommand,
  unstableLocation,
  windowsWrapper,
  type CliInstallEnv,
  type CliInstallFs,
  type ExecFileFn,
} from '../../../packages/app/src/main/cli-install';

let root: string;
let home: string;
let sys: string;
let devCli: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-cli-install-')));
  home = path.join(root, 'home');
  sys = path.join(root, 'usr-local-bin');
  devCli = path.join(root, 'packages', 'cli', 'dist');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(sys, { recursive: true });
  fs.mkdirSync(devCli, { recursive: true });
  fs.writeFileSync(path.join(devCli, 'blueline'), `#!/bin/sh\n# ${SHIM_MARKER}: test\n`, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function env(o: Partial<CliInstallEnv> & { loginPathValue?: string | null; calls?: string[] } = {}): CliInstallEnv {
  const calls = o.calls ?? [];
  return {
    platform: 'linux',
    home,
    env: {},
    isPackaged: false,
    resourcesPath: '/nowhere',
    devCliDir: devCli,
    systemDir: sys,
    fs: nodeCliFs,
    loginPath: async () => (o.loginPathValue === undefined ? `/usr/bin:${home}/.local/bin` : o.loginPathValue),
    loginShell: () => '/bin/bash',
    runAsAdmin: async (a) => {
      calls.push(`admin ${a.target} ${a.link} ${a.dir} ${a.replace}`);
      return { ok: true };
    },
    choose: async () => {
      calls.push('choose');
      return 'system';
    },
    ...o,
  };
}

const target = () => path.join(devCli, 'blueline');
const userLink = () => path.join(home, '.local', 'bin', 'blueline');

describe('where the command is and what counts as Blueline’s', () => {
  it('shippedCommand: Resources/cli when packaged, packages/cli/dist in development', () => {
    expect(shippedCommand({ platform: 'darwin', isPackaged: true, resourcesPath: '/Applications/Blueline.app/Contents/Resources', devCliDir: '/x' })).toBe(
      '/Applications/Blueline.app/Contents/Resources/cli/blueline',
    );
    expect(shippedCommand({ platform: 'linux', isPackaged: true, resourcesPath: '/opt/Blueline/resources', devCliDir: '/x' })).toBe('/opt/Blueline/resources/cli/blueline');
    expect(shippedCommand({ platform: 'win32', isPackaged: true, resourcesPath: 'C:\\Program Files\\Blueline\\resources', devCliDir: 'C:\\x' })).toBe(
      'C:\\Program Files\\Blueline\\resources\\cli\\blueline.cmd',
    );
    expect(shippedCommand({ platform: 'linux', isPackaged: false, resourcesPath: '/r', devCliDir: '/repo/packages/cli/dist' })).toBe('/repo/packages/cli/dist/blueline');
  });

  it('isBluelineCommandPath: a Blueline cli folder of any app copy, or the repo’s cli dist', () => {
    expect(isBluelineCommandPath('/Applications/Blueline.app/Contents/Resources/cli/blueline')).toBe(true);
    expect(isBluelineCommandPath('/Volumes/Old/Blueline 0.9.app/Contents/Resources/cli/blueline')).toBe(true);
    expect(isBluelineCommandPath('/opt/Blueline/resources/cli/blueline')).toBe(true);
    expect(isBluelineCommandPath('/home/j/src/humanist/packages/cli/dist/blueline')).toBe(true);
    for (const p of ['/usr/bin/blueline', '/opt/other/cli/blueline', '/x/Resources/cli/blueline.sh', '/x/Resources/cli/other', '/x/cli/dist/blueline']) {
      expect(isBluelineCommandPath(p)).toBe(false);
    }
  });

  it('macOS: a translocated app or one on a disk image cannot be linked to', () => {
    expect(unstableLocation({ platform: 'darwin', isPackaged: true, resourcesPath: '/private/var/folders/x/AppTranslocation/ABC/d/Blueline.app/Contents/Resources' })).toMatch(/Applications folder/);
    expect(unstableLocation({ platform: 'darwin', isPackaged: true, resourcesPath: '/Volumes/Blueline/Blueline.app/Contents/Resources' })).toMatch(/disk image/);
    expect(unstableLocation({ platform: 'darwin', isPackaged: true, resourcesPath: '/Applications/Blueline.app/Contents/Resources' })).toBeNull();
    expect(unstableLocation({ platform: 'darwin', isPackaged: false, resourcesPath: '/Volumes/dev' })).toBeNull();
  });

  it('classifyExisting: absent, same, ours (old app copy or a moved shim), and everything else foreign', async () => {
    const e = { platform: 'linux' as const, fs: nodeCliFs };
    const at = (n: string) => path.join(root, n);
    expect(await classifyExisting(at('none'), target(), e)).toBe('absent');
    fs.symlinkSync(target(), at('same'));
    expect(await classifyExisting(at('same'), target(), e)).toBe('same');
    fs.symlinkSync('/Applications/Blueline 0.9.app/Contents/Resources/cli/blueline', at('old'));
    expect(await classifyExisting(at('old'), target(), e)).toBe('ours');
    const moved = at('moved-shim');
    fs.writeFileSync(moved, `#!/bin/sh\n# ${SHIM_MARKER}\n`);
    fs.symlinkSync(moved, at('to-moved'));
    expect(await classifyExisting(at('to-moved'), target(), e)).toBe('ours');
    fs.symlinkSync('/usr/bin/true', at('foreign-link'));
    expect(await classifyExisting(at('foreign-link'), target(), e)).toBe('foreign-link');
    fs.writeFileSync(at('file'), `#!/bin/sh\n# ${SHIM_MARKER}\n`);
    expect(await classifyExisting(at('file'), target(), e)).toBe('foreign-file');
    fs.mkdirSync(at('dir'));
    expect(await classifyExisting(at('dir'), target(), e)).toBe('folder');
  });
});

describe('Linux (and macOS with ~/.local/bin on PATH): ~/.local/bin', () => {
  it('creates ~/.local/bin and the link; a second install is up to date', async () => {
    const r = await installCommandLineTool(env());
    expect(r).toMatchObject({ ok: true, link: userLink(), target: target(), replaced: false, upToDate: false, onPath: true, pathHint: null, admin: false });
    expect(fs.readlinkSync(userLink())).toBe(target());
    expect(fs.realpathSync(userLink())).toBe(target());
    expect(await installCommandLineTool(env())).toMatchObject({ ok: true, upToDate: true });
    // No temporary link is left behind.
    expect(fs.readdirSync(path.dirname(userLink()))).toEqual(['blueline']);
  });

  it('replaces a previous Blueline link (an old app copy, now gone), and only that', async () => {
    fs.mkdirSync(path.dirname(userLink()), { recursive: true });
    fs.symlinkSync('/opt/Blueline-old/resources/cli/blueline', userLink());
    const r = await installCommandLineTool(env());
    expect(r).toMatchObject({ ok: true, replaced: true });
    expect(fs.readlinkSync(userLink())).toBe(target());
  });

  it('never replaces another program’s file, link or a folder', async () => {
    fs.mkdirSync(path.dirname(userLink()), { recursive: true });
    fs.writeFileSync(userLink(), '#!/bin/sh\necho someone else\n', { mode: 0o755 });
    let r = await installCommandLineTool(env());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/another program’s file/);
    expect(fs.readFileSync(userLink(), 'utf8')).toContain('someone else');
    fs.unlinkSync(userLink());
    fs.symlinkSync('/usr/bin/true', userLink());
    r = await installCommandLineTool(env());
    expect(r.ok).toBe(false);
    expect(fs.readlinkSync(userLink())).toBe('/usr/bin/true');
    fs.unlinkSync(userLink());
    fs.mkdirSync(userLink());
    r = await installCommandLineTool(env());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/is a folder/);
  });

  it('not on the login shell’s PATH: installed, and the result says how to add it for that shell', async () => {
    const r = await installCommandLineTool(env({ loginPathValue: '/usr/bin:/bin' }));
    expect(r).toMatchObject({ ok: true, onPath: false });
    if (r.ok) expect(r.pathHint).toBe('Add it to your PATH: add the line export PATH="$HOME/.local/bin:$PATH" to ~/.profile, then open a new terminal.');
    const z = await installCommandLineTool(env({ loginPathValue: '/usr/bin', loginShell: () => '/bin/zsh' }));
    if (z.ok) expect(z.pathHint).toContain('~/.zprofile');
    const unknown = await installCommandLineTool(env({ loginPathValue: null }));
    expect(unknown).toMatchObject({ ok: true, onPath: null, pathHint: null });
    const m = cliInstallMessage(unknown);
    expect(m.detail).toMatch(/could not read your PATH/);
  });

  it('Linux never asks for an administrator: /usr/local/bin is used only to update a writable Blueline link there', async () => {
    const calls: string[] = [];
    fs.chmodSync(sys, 0o555);
    try {
      const r = await installCommandLineTool(env({ loginPathValue: '/usr/bin', calls }));
      expect(r).toMatchObject({ ok: true, link: userLink() });
      expect(calls).toEqual([]);
    } finally {
      fs.chmodSync(sys, 0o755);
    }
  });

  it('a command that is not built, or not executable, is refused with what to do', async () => {
    fs.chmodSync(target(), 0o644);
    if (process.getuid?.() !== 0) {
      const r = await installCommandLineTool(env());
      expect(r.ok).toBe(false);
    }
    fs.rmSync(target());
    const dev = await installCommandLineTool(env());
    expect(dev.ok).toBe(false);
    if (!dev.ok) expect(dev.reason).toMatch(/npm run build/);
    const packaged = await installCommandLineTool(env({ isPackaged: true, resourcesPath: path.join(root, 'Resources') }));
    if (!packaged.ok) expect(packaged.reason).toMatch(/Reinstall Blueline/);
  });
});

describe('macOS decisions (platform injected, real files)', () => {
  const mac = (o: Parameters<typeof env>[0] = {}) => env({ platform: 'darwin', loginPathValue: '/usr/bin:/bin:/usr/sbin:/sbin', loginShell: () => '/bin/zsh', ...o });

  it('~/.local/bin not on PATH and /usr/local/bin writable (Homebrew on Intel): links there, no prompt', async () => {
    const calls: string[] = [];
    const r = await installCommandLineTool(mac({ calls, loginPathValue: `/usr/bin:${sys}` }));
    expect(r).toMatchObject({ ok: true, link: path.join(sys, 'blueline'), admin: false, onPath: true });
    expect(calls).toEqual([]);
    expect(fs.readlinkSync(path.join(sys, 'blueline'))).toBe(target());
  });

  it('/usr/local/bin not writable: asks where; the system folder goes through the administrator prompt', async () => {
    const calls: string[] = [];
    fs.chmodSync(sys, 0o555);
    try {
      const e = mac({ calls, fs: { ...nodeCliFs, access: async (p, m) => (p === sys && m === 'write' ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) : nodeCliFs.access(p, m)) } });
      const r = await installCommandLineTool(e);
      expect(calls).toEqual(['choose', `admin ${target()} ${path.join(sys, 'blueline')} ${sys} false`]);
      expect(r).toMatchObject({ ok: true, admin: true, replaced: false });
    } finally {
      fs.chmodSync(sys, 0o755);
    }
  });

  it('asked, the user picks ~/.local/bin (with the PATH line) or cancels', async () => {
    const noWrite: CliInstallFs = { ...nodeCliFs, access: async (p, m) => (p === sys && m === 'write' ? Promise.reject(new Error('EACCES')) : nodeCliFs.access(p, m)) };
    const user = await installCommandLineTool(mac({ fs: noWrite, choose: async () => 'user' }));
    expect(user).toMatchObject({ ok: true, link: userLink(), onPath: false });
    if (user.ok) expect(user.pathHint).toContain('~/.zprofile');
    fs.unlinkSync(userLink());
    const cancel = await installCommandLineTool(mac({ fs: noWrite, choose: async () => null }));
    expect(cancel).toMatchObject({ ok: false, canceled: true });
    expect(fs.existsSync(userLink())).toBe(false);
  });

  it('an existing Blueline link in /usr/local/bin is updated where it is (administrator when not writable, replace)', async () => {
    fs.symlinkSync('/Applications/Blueline 0.9.app/Contents/Resources/cli/blueline', path.join(sys, 'blueline'));
    const calls: string[] = [];
    const noWrite: CliInstallFs = { ...nodeCliFs, access: async (p, m) => (p === sys && m === 'write' ? Promise.reject(new Error('EACCES')) : nodeCliFs.access(p, m)) };
    const r = await installCommandLineTool(mac({ calls, fs: noWrite, loginPathValue: `/usr/bin:${home}/.local/bin` }));
    expect(calls).toEqual([`admin ${target()} ${path.join(sys, 'blueline')} ${sys} true`]);
    expect(r).toMatchObject({ ok: true, replaced: true, admin: true });
  });

  it('a cancelled administrator prompt installs nothing', async () => {
    const noWrite: CliInstallFs = { ...nodeCliFs, access: async (p, m) => (p === sys && m === 'write' ? Promise.reject(new Error('EACCES')) : nodeCliFs.access(p, m)) };
    const r = await installCommandLineTool(mac({ fs: noWrite, runAsAdmin: async () => ({ ok: false, canceled: true }) }));
    expect(r).toMatchObject({ ok: false, canceled: true });
    expect(cliInstallMessage(r).type).toBe('info');
  });

  it('~/.local/bin on PATH: no question, no prompt', async () => {
    const calls: string[] = [];
    const r = await installCommandLineTool(mac({ calls, loginPathValue: `/usr/bin:~/.local/bin` }));
    expect(r).toMatchObject({ ok: true, link: userLink(), onPath: true });
    expect(calls).toEqual([]);
  });

  it('a foreign /usr/local/bin/blueline is left alone: ~/.local/bin instead', async () => {
    fs.writeFileSync(path.join(sys, 'blueline'), 'other');
    const r = await installCommandLineTool(mac());
    expect(r).toMatchObject({ ok: true, link: userLink() });
    expect(fs.readFileSync(path.join(sys, 'blueline'), 'utf8')).toBe('other');
  });

  it('the administrator command: constant script text, the paths only as arguments, quoted by AppleScript', async () => {
    const evil = { target: `/A "x" & do shell script "rm -rf ~" & "/cli/blueline`, link: "/usr/local/bin/blue'line", dir: '/usr/local/bin', replace: false };
    const args = osascriptArgs(evil);
    const script = args.filter((_, i) => args[i - 1] === '-e');
    expect(script.join('\n')).not.toContain('rm -rf');
    expect(script.join('\n')).toMatch(/quoted form of \(item 1 of argv\)/);
    expect(script.join('\n')).toMatch(/with administrator privileges/);
    expect(args.slice(-3)).toEqual([evil.target, evil.link, evil.dir]);
    expect(osascriptArgs({ ...evil, replace: true }).join(' ')).toContain('/bin/ln -sfh ');
    const seen: { file: string; args: readonly string[] }[] = [];
    const exec = (code: number, stderr: string): ExecFileFn => async (file, a) => {
      seen.push({ file, args: a });
      return { code, stdout: '', stderr };
    };
    expect(await runAsAdminMac(evil, exec(0, ''))).toEqual({ ok: true });
    expect(seen[0].file).toBe('/usr/bin/osascript');
    expect(await runAsAdminMac(evil, exec(1, '0:200: execution error: User canceled. (-128)'))).toEqual({ ok: false, canceled: true });
    expect(await runAsAdminMac(evil, exec(1, 'ln: /usr/local/bin/blueline: File exists'))).toEqual({ ok: false, reason: 'ln: /usr/local/bin/blueline: File exists' });
  });
});

/** An in-memory file system for Windows paths (they cannot be made on Linux). */
function memFs(files: Record<string, string>, dirs: string[] = []): CliInstallFs & { files: Record<string, string> } {
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const isDir = (p: string) => dirs.includes(p);
  const st = (p: string) => {
    if (isDir(p)) return { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true };
    if (p in files) return { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
    throw enoent();
  };
  return {
    files,
    lstat: async (p) => st(p),
    stat: async (p) => st(p),
    readlink: async () => Promise.reject(enoent()),
    readHead: async (p) => (p in files ? files[p] : Promise.reject(enoent())),
    access: async (p) => (p in files || isDir(p) ? undefined : Promise.reject(enoent())),
    mkdirp: async (p) => {
      dirs.push(p);
    },
    symlink: async () => Promise.reject(new Error('no symlinks on Windows here')),
    rename: async (a, b) => {
      files[b] = files[a];
      delete files[a];
    },
    unlink: async (p) => {
      delete files[p];
    },
    writeFile: async (p, t) => {
      files[p] = t;
    },
  };
}

describe('Windows (the documented minimum, in memory)', () => {
  const res = 'C:\\Program Files\\Blueline\\resources';
  const shipped = `${res}\\cli\\blueline.cmd`;
  const wrapper = 'C:\\Users\\Anna\\AppData\\Local\\Blueline\\bin\\blueline.cmd';
  const win = (m: CliInstallFs, pathValue: string) =>
    env({ platform: 'win32', isPackaged: true, resourcesPath: res, home: 'C:\\Users\\Anna', env: { LOCALAPPDATA: 'C:\\Users\\Anna\\AppData\\Local', Path: pathValue }, fs: m });

  it('writes a blueline.cmd that calls the shipped one, and says how to add its folder to PATH', async () => {
    const m = memFs({ [shipped]: '@echo off\r\nrem blueline-shim\r\n' });
    const r = await installCommandLineTool(win(m, 'C:\\Windows\\system32;C:\\Windows'));
    expect(r).toMatchObject({ ok: true, link: wrapper, target: shipped, onPath: false, replaced: false });
    expect(m.files[wrapper]).toBe(windowsWrapper(shipped));
    expect(m.files[wrapper]).toContain(`"${shipped}" %*`);
    expect(m.files[wrapper]).toContain(WRAPPER_MARKER);
    expect(m.files[wrapper].split('\r\n').length).toBeGreaterThan(3);
    if (r.ok) expect(r.pathHint).toMatch(/Edit environment variables for your account/);
  });

  it('on PATH (any case, a trailing backslash): no hint; the same wrapper again is up to date; an old one is replaced', async () => {
    const m = memFs({ [shipped]: 'x' });
    const onPath = 'C:\\Windows;c:\\users\\anna\\appdata\\local\\blueline\\BIN\\';
    expect(await installCommandLineTool(win(m, onPath))).toMatchObject({ ok: true, onPath: true, pathHint: null });
    expect(await installCommandLineTool(win(m, onPath))).toMatchObject({ ok: true, upToDate: true });
    m.files[wrapper] = windowsWrapper('D:\\Old\\resources\\cli\\blueline.cmd');
    expect(await installCommandLineTool(win(m, onPath))).toMatchObject({ ok: true, replaced: true });
    expect(m.files[wrapper]).toBe(windowsWrapper(shipped));
  });

  it('another program’s blueline.cmd is never replaced', async () => {
    const m = memFs({ [shipped]: 'x', [wrapper]: '@echo off\r\necho mine\r\n' });
    const r = await installCommandLineTool(win(m, ''));
    expect(r.ok).toBe(false);
    expect(m.files[wrapper]).toContain('echo mine');
  });
});

describe('PATH and the login shell', () => {
  it('isOnPath expands ~ and $HOME and ignores trailing slashes and relative entries', () => {
    const o = { platform: 'linux' as const, home: '/home/j' };
    expect(isOnPath('/home/j/.local/bin', '/usr/bin:~/.local/bin', o)).toBe(true);
    expect(isOnPath('/home/j/.local/bin', '/usr/bin:$HOME/.local/bin/', o)).toBe(true);
    expect(isOnPath('/home/j/.local/bin', '/usr/bin:.local/bin:', o)).toBe(false);
    expect(isOnPath('/home/j/.local/bin', null, o)).toBeNull();
    expect(isOnPath('/usr/local/bin', '/usr/local/bin//', o)).toBe(true);
  });

  it('pathHint per shell', () => {
    expect(pathHint('/home/j/.local/bin', { platform: 'linux', home: '/home/j', shell: '/usr/bin/fish' })).toBe('Add it to your PATH with: fish_add_path /home/j/.local/bin. Then open a new terminal.');
    expect(pathHint('/Users/j/.local/bin', { platform: 'darwin', home: '/Users/j', shell: '/bin/bash' })).toContain('~/.bash_profile');
  });

  it('parsePathLine takes the last PATH= line', () => {
    expect(parsePathLine('HOME=/h\nPATH=/a:/b\nX=PATH=no\nPATH=/c\n')).toBe('/c');
    expect(parsePathLine('HOME=/h\n')).toBeNull();
  });

  it('readLoginShellPath runs `<shell> -l -c /usr/bin/env` (a fake, then the real /bin/sh)', async () => {
    const seen: (readonly string[])[] = [];
    const exec: ExecFileFn = async (_f, a) => {
      seen.push(a);
      return { code: 0, stdout: 'motd line\nPATH=/x:/y\n', stderr: '' };
    };
    expect(await readLoginShellPath('/bin/zsh', exec)).toBe('/x:/y');
    expect(seen[0]).toEqual(['-l', '-c', '/usr/bin/env']);
    expect(await readLoginShellPath(null, exec)).toBeNull();
    expect(await readLoginShellPath('zsh', exec)).toBeNull();
    expect(await readLoginShellPath('/bin/zsh', async () => ({ code: 1, stdout: '', stderr: '' }))).toBeNull();
    if (fs.existsSync('/bin/sh') && fs.existsSync('/usr/bin/env')) {
      const real = await readLoginShellPath('/bin/sh', undefined, { ...process.env, PATH: '/usr/bin:/bin:/opt/test-marker' });
      expect(typeof real).toBe('string');
      expect(real!.split(':')).toContain('/usr/bin');
    }
  });
});

describe('the result message', () => {
  it('says where the command is, what it needs, and the PATH line when needed', () => {
    const ok = cliInstallMessage({ ok: true, link: '/u/.local/bin/blueline', target: '/A/cli/blueline', dir: '/u/.local/bin', replaced: false, upToDate: false, onPath: false, pathHint: 'Add it.', admin: false });
    expect(ok.type).toBe('warning');
    expect(ok.detail).toContain('/u/.local/bin/blueline now runs /A/cli/blueline.');
    expect(ok.detail).toContain('Node.js 22');
    expect(ok.detail).toContain('is not on your PATH yet');
    const fail = cliInstallMessage({ ok: false, reason: 'nope' });
    expect(fail).toEqual({ type: 'error', message: 'The command line tool could not be installed', detail: 'nope' });
  });
});
