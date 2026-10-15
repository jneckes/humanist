// Confinement fuzz for the blueline:// handler (9.1 Refusals steps 2–4; section 11 Security suite).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

// Hooks that run inside confine.ts's file-system calls, to simulate an attacker swapping files between
// the check and the open. Every call still goes to the real node:fs.
const hooks = vi.hoisted(() => ({
  beforeLstat: null as null | ((p: string) => void),
  beforeOpen: null as null | ((p: string) => void),
  ran: 0,
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const lstatSync = ((p: string, o?: unknown) => {
    hooks.beforeLstat?.(p);
    return (real.lstatSync as (p: string, o?: unknown) => unknown)(p, o);
  }) as typeof real.lstatSync;
  const openSync = ((p: string, flags: number, mode?: number) => {
    hooks.beforeOpen?.(p);
    return real.openSync(p, flags, mode);
  }) as typeof real.openSync;
  const mod = { ...real, lstatSync, openSync };
  return { ...mod, default: mod };
});

import * as fs from 'node:fs';
import {
  FILES_EXTENSIONS,
  decodePathSegments,
  extOf,
  isCaseInsensitiveVolume,
  isInsideFolder,
  resolveConfined,
  resolveConfinedPath,
  segmentAllowed,
} from '../../../packages/app/src/main/confine';

let root: string;
let folder: string;
let outside: string;

function write(p: string, data: string | Uint8Array = 'x'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

function ok(pathname: string, opts?: Parameters<typeof resolveConfined>[2]) {
  const f = resolveConfined(folder, pathname, opts);
  if (f) fs.closeSync(f.fd);
  return f;
}

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-confine-')));
  folder = path.join(root, 'Deck Folder');
  outside = path.join(root, 'outside');
  write(path.join(folder, 'deck.html'), '<p>deck</p>');
  write(path.join(folder, 'img.png'), 'PNGDATA');
  write(path.join(folder, 'sub', 'a.css'), 'p{}');
  write(path.join(folder, 'sub', 'deep', 'b.js'), '1');
  write(path.join(folder, '.ssh', 'id_rsa'), 'SECRET KEY');
  write(path.join(folder, '.hidden.png'), 'hidden');
  write(path.join(folder, 'secret.txt'), 'secret');
  write(path.join(folder, 'notes.txt'), 'notes');
  write(path.join(folder, 'Upper.PNG'), 'upper');
  write(path.join(folder, 'café.png'), 'nfd'); // NFD name on disk
  write(path.join(folder, 'space name.png'), 'space');
  write(path.join(folder, 'pct%2e.png'), 'literal percent');
  write(path.join(outside, 'secret.png'), 'OUTSIDE');
  write(path.join(outside, 'id_rsa.png'), 'OUTSIDE KEY');
  fs.mkdirSync(path.join(folder, 'emptydir'));
  fs.symlinkSync(path.join(outside, 'secret.png'), path.join(folder, 'link-out.png'));
  fs.symlinkSync(path.join(folder, 'img.png'), path.join(folder, 'link-in.png'));
  fs.symlinkSync(outside, path.join(folder, 'linkdir'));
  fs.symlinkSync(path.join(folder, 'notes.txt'), path.join(folder, 'alias.png'));
  fs.symlinkSync('../outside/secret.png', path.join(folder, 'rel-out.png'));
  fs.symlinkSync(path.join(folder, 'missing.png'), path.join(folder, 'dangling.png'));
  // A sibling folder whose name starts with the folder's name: a string-prefix test would accept it.
  write(path.join(root, 'Deck Folder-evil', 'x.png'), 'prefix');
  fs.symlinkSync(path.join(root, 'Deck Folder-evil', 'x.png'), path.join(folder, 'prefix.png'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  hooks.beforeLstat = null;
  hooks.beforeOpen = null;
  hooks.ran = 0;
});

describe('segments (step 2)', () => {
  it('splits before decoding and decodes once', () => {
    expect(decodePathSegments('/a/b.png')).toEqual(['a', 'b.png']);
    expect(decodePathSegments('/space%20name.png')).toEqual(['space name.png']);
    // %252e decodes once to the literal text %2e, never to a dot.
    expect(decodePathSegments('/%252e%252e/x.png')).toEqual(['%2e%2e', 'x.png']);
    expect(decodePathSegments('/caf%C3%A9.png')).toEqual(['café.png']);
  });

  it.each([
    ['', 'empty pathname'],
    ['img.png', 'no leading slash'],
    ['/', 'bare root'],
    ['//img.png', 'empty segment'],
    ['/sub//a.css', 'empty middle segment'],
    ['/sub/', 'trailing slash'],
    ['/.', 'dot'],
    ['/..', 'dot dot'],
    ['/../outside/secret.png', 'raw dot dot'],
    ['/%2e%2e/outside/secret.png', 'encoded dot dot'],
    ['/%2E%2E/outside/secret.png', 'encoded dot dot, upper case'],
    ['/%2e%2E/outside/secret.png', 'encoded dot dot, mixed case'],
    ['/.%2e/outside/secret.png', 'half-encoded dot dot'],
    ['/%2e/img.png', 'encoded dot'],
    ['/..%2Foutside%2Fsecret.png', 'encoded slash after dot dot'],
    ['/sub%2Fa.css', 'encoded slash'],
    ['/sub%2fa.css', 'encoded slash, lower case'],
    ['/sub%5Ca.css', 'encoded backslash'],
    ['/sub\\a.css', 'raw backslash'],
    ['/..\\outside\\secret.png', 'backslash traversal'],
    ['/C%3A/x.png', 'colon'],
    ['/img.png:stream', 'raw colon'],
    ['/.ssh/id_rsa', 'dotfile directory'],
    ['/%2essh/id_rsa', 'encoded dotfile directory'],
    ['/.hidden.png', 'dotfile'],
    ['/img.png%00.png', 'NUL'],
    ['/img%01.png', 'C0 control'],
    ['/img%0A.png', 'newline'],
    ['/img%7F.png', 'DEL'],
    ['/img%C2%85.png', 'C1 control (NEL)'],
    ['/%E9.png', 'invalid UTF-8'],
    ['/%ZZ.png', 'malformed escape'],
    ['/%', 'truncated escape'],
    ['/%ED%A0%80.png', 'encoded lone surrogate'],
  ])('refuses %s (%s)', (p) => {
    expect(decodePathSegments(p)).toBeNull();
    expect(resolveConfined(folder, p)).toBeNull();
  });

  it('refuses over-long segments and paths', () => {
    expect(decodePathSegments('/' + 'a'.repeat(256))).toBeNull();
    expect(decodePathSegments('/a'.repeat(65))).toBeNull();
    expect(decodePathSegments('/a'.repeat(64))).not.toBeNull();
  });

  it.each([
    'CON', 'con', 'Con.png', 'NUL.txt', 'nul', 'PRN.css', 'aux.js', 'COM1', 'com9.png', 'LPT1.png', 'lpt9',
    'COM¹.png', 'CONIN$', 'conout$.png', 'CON .png', 'img.png.', 'img.png ', 'a<b.png', 'a>b.png', 'a"b.png',
    'a|b.png', 'a?b.png', 'a*b.png',
  ])('refuses %j on win32', (name) => {
    expect(segmentAllowed(name, 'win32')).toBe(false);
    expect(decodePathSegments('/' + encodeURIComponent(name), 'win32')).toBeNull();
  });

  it.each(['console.png', 'CONTENT.css', 'com10.png', 'nulls.js', 'lpt.png', 'a.b.png'])('allows %j on win32', (name) => {
    expect(segmentAllowed(name, 'win32')).toBe(true);
  });

  it('does not apply win32 rules on other platforms', () => {
    expect(segmentAllowed('CON', 'linux')).toBe(true);
    expect(segmentAllowed('img.png.', 'darwin')).toBe(true);
  });

  it('extOf lowercases and ignores dot-leading names', () => {
    expect(extOf('a.PNG')).toBe('png');
    expect(extOf('a.tar.gz')).toBe('gz');
    expect(extOf('noext')).toBe('');
    expect(extOf('.bashrc')).toBe('');
  });
});

describe('resolveConfined (steps 3 and 4)', () => {
  it('serves files inside the folder with fd, size, realpath and ext', () => {
    const f = resolveConfined(folder, '/img.png', { allowedExtensions: FILES_EXTENSIONS });
    expect(f).not.toBeNull();
    try {
      expect(f!.size).toBe(7);
      expect(f!.realpath).toBe(path.join(folder, 'img.png'));
      expect(f!.ext).toBe('png');
      const buf = Buffer.alloc(7);
      fs.readSync(f!.fd, buf, 0, 7, 0);
      expect(buf.toString()).toBe('PNGDATA');
    } finally {
      fs.closeSync(f!.fd);
    }
    expect(ok('/sub/a.css')?.ext).toBe('css');
    expect(ok('/sub/deep/b.js')?.ext).toBe('js');
    expect(ok('/space%20name.png')?.size).toBe(5);
    expect(ok('/Upper.PNG', { allowedExtensions: FILES_EXTENSIONS })?.ext).toBe('png');
    // A literal %2e in a file name is reachable by encoding the percent sign.
    expect(ok('/pct%252e.png')?.size).toBe(15);
  });

  it('refuses symlinks that lead outside, absolute or relative, file or directory', () => {
    expect(ok('/link-out.png')).toBeNull();
    expect(ok('/rel-out.png')).toBeNull();
    expect(ok('/linkdir/secret.png')).toBeNull();
    expect(ok('/linkdir/id_rsa.png')).toBeNull();
    expect(ok('/dangling.png')).toBeNull();
  });

  it('never uses a string-prefix test (a sibling folder sharing the name prefix is outside)', () => {
    expect(ok('/prefix.png')).toBeNull();
    expect(isInsideFolder(folder, path.join(root, 'Deck Folder-evil', 'x.png'), false)).toBe(false);
    expect(isInsideFolder(folder, folder, false)).toBe(false);
    expect(isInsideFolder(folder, path.join(folder, 'a', 'b'), false)).toBe(true);
  });

  it('follows symlinks that stay inside, and uses the target for the extension check', () => {
    expect(ok('/link-in.png')?.realpath).toBe(path.join(folder, 'img.png'));
    // alias.png -> notes.txt: the realpath's extension is not allowlisted.
    expect(ok('/alias.png', { allowedExtensions: FILES_EXTENSIONS })).toBeNull();
    expect(ok('/alias.png')?.ext).toBe('txt');
  });

  it('applies the extension allowlist before touching the disk', () => {
    expect(ok('/secret.txt', { allowedExtensions: FILES_EXTENSIONS })).toBeNull();
    expect(ok('/deck.html', { allowedExtensions: FILES_EXTENSIONS })).toBeNull();
    expect(ok('/secret.txt')?.ext).toBe('txt');
  });

  it('refuses directories, missing files and a non-absolute folder', () => {
    expect(ok('/emptydir')).toBeNull();
    expect(ok('/sub')).toBeNull();
    expect(ok('/missing.png')).toBeNull();
    expect(resolveConfined('relative/folder', '/img.png')).toBeNull();
  });

  it('refuses a FIFO without blocking', () => {
    const fifo = path.join(folder, 'pipe.png');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo on this system
    }
    try {
      const t = Date.now();
      expect(ok('/pipe.png')).toBeNull();
      expect(Date.now() - t).toBeLessThan(2000);
    } finally {
      fs.rmSync(fifo, { force: true });
    }
  });

  it('handles Unicode names by exact bytes on a normalization-sensitive volume', () => {
    // On disk the name is NFD. The NFD request always works; the NFC one works only where the volume
    // treats both spellings as one name (macOS), and never resolves outside.
    expect(ok('/' + encodeURIComponent('café.png'))?.size).toBe(3);
    const nfc = ok('/' + encodeURIComponent('café.png'));
    if (process.platform === 'darwin') expect(nfc?.size).toBe(3);
    else expect(nfc).toBeNull();
  });

  it('compares case-insensitively only on case-insensitive volumes', () => {
    expect(isInsideFolder('/A/Deck', '/a/deck/x.png', true)).toBe(true);
    expect(isInsideFolder('/A/Deck', '/a/deck/x.png', false)).toBe(false);
    expect(isInsideFolder('/A/Deck', '/a/deckx/x.png', true)).toBe(false);
    // Detection on this temp volume agrees with whether a case-flipped path names the same folder.
    const flipped = path.join(root, 'dECK fOLDER');
    const same = fs.existsSync(flipped) && fs.statSync(flipped).ino === fs.statSync(folder).ino;
    expect(isCaseInsensitiveVolume(folder)).toBe(same);
    // A mixed-case request on a case-sensitive volume does not find the file.
    if (!same) expect(ok('/IMG.png')).toBeNull();
  });

  it('refuses a symlink swapped in after the realpath (final component)', () => {
    const victim = path.join(folder, 'victim.png');
    write(victim, 'victim');
    hooks.beforeOpen = (p) => {
      if (p !== victim) return;
      fs.rmSync(victim);
      fs.symlinkSync(path.join(outside, 'secret.png'), victim);
      hooks.ran++;
    };
    expect(ok('/victim.png')).toBeNull();
    expect(hooks.ran).toBe(1);
    fs.rmSync(victim, { force: true });
  });

  it('refuses a different file renamed over the checked one (dev+ino mismatch)', () => {
    const victim = path.join(folder, 'victim2.png');
    write(victim, 'victim');
    write(path.join(folder, 'other.png'), 'other!');
    hooks.beforeOpen = (p) => {
      if (p !== victim) return;
      fs.renameSync(path.join(folder, 'other.png'), victim);
      hooks.ran++;
    };
    expect(ok('/victim2.png')).toBeNull();
    expect(hooks.ran).toBe(1);
    fs.rmSync(victim, { force: true });
  });

  it('refuses a directory component swapped for a symlink after the check', () => {
    const dir = path.join(folder, 'swapdir');
    write(path.join(dir, 'id_rsa.png'), 'inside');
    hooks.beforeOpen = (p) => {
      if (p !== path.join(dir, 'id_rsa.png')) return;
      fs.renameSync(dir, dir + '.moved');
      fs.symlinkSync(outside, dir);
      hooks.ran++;
    };
    expect(ok('/swapdir/id_rsa.png')).toBeNull();
    expect(hooks.ran).toBe(1);
    fs.rmSync(dir, { force: true });
    fs.rmSync(dir + '.moved', { recursive: true, force: true });
  });

  it.runIf(process.platform === 'linux')('refuses a directory swap before the lstat (caught by /proc/self/fd)', () => {
    const dir = path.join(folder, 'swapdir2');
    write(path.join(dir, 'id_rsa.png'), 'inside');
    hooks.beforeLstat = (p) => {
      if (p !== path.join(dir, 'id_rsa.png')) return;
      fs.renameSync(dir, dir + '.moved');
      fs.symlinkSync(outside, dir);
      hooks.ran++;
    };
    expect(ok('/swapdir2/id_rsa.png')).toBeNull();
    expect(hooks.ran).toBe(1);
    fs.rmSync(dir, { force: true });
    fs.rmSync(dir + '.moved', { recursive: true, force: true });
  });

  it('resolveConfinedPath closes the descriptor and returns the realpath', () => {
    expect(resolveConfinedPath(folder, '/deck.html', { allowedExtensions: new Set(['html']) })).toBe(path.join(folder, 'deck.html'));
    expect(resolveConfinedPath(folder, '/img.png', { allowedExtensions: new Set(['html']) })).toBeNull();
  });

  it('fuzz: no random path ever resolves outside the folder or to a dotfile', () => {
    // Seeded generator so failures reproduce.
    let seed = 0x5eed;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pieces = [
      '..', '.', '%2e', '%2E', '%2e%2e', '.%2e', '%2f', '%2F', '%5c', '\\', '%00', '%0a', 'img.png', 'sub', 'a.css',
      'linkdir', 'secret.png', 'id_rsa', '.ssh', '%2essh', 'link-out.png', 'rel-out.png', 'outside', '%252e',
      'caf%C3%A9.png', 'cafe%CC%81.png', 'IMG.PNG', 'Upper.PNG', '', '%3a', ':', 'deep', 'b.js', 'prefix.png',
      '%E2%80%AE', '%EF%BC%8F', 'con', 'NUL.png', 'x.png.', 'a ',
    ];
    for (let i = 0; i < 4000; i++) {
      const n = 1 + rand(5);
      const segs: string[] = [];
      for (let j = 0; j < n; j++) segs.push(pieces[rand(pieces.length)]);
      const p = '/' + segs.join('/');
      for (const platform of ['linux', 'win32'] as const) {
        const f = resolveConfined(folder, p, { platform });
        if (!f) continue;
        try {
          const rel = path.relative(folder, f.realpath);
          expect(rel.startsWith('..') || path.isAbsolute(rel), p).toBe(false);
          expect(rel.split(path.sep).some((s) => s.startsWith('.')), p).toBe(false);
          expect(f.realpath.startsWith(outside), p).toBe(false);
        } finally {
          fs.closeSync(f.fd);
        }
      }
    }
  });
});
