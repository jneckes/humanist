// The atomic writer (9.2 Atomic write steps 2–4; 9.9 Writes, Write protocol addition).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CoalescingWriter,
  WriteConflictError,
  atomicWriteFile,
  createDeckIO,
  macQuarantineCopier,
  readRegularFile,
  sha256Hex,
  windowsZoneCopier,
  type ExecFn,
  type XattrCopier,
} from '../../../packages/app/src/main/atomic-write';

let dir: string;
const enc = (s: string) => new TextEncoder().encode(s);
const tmpFiles = () => fs.readdirSync(dir).filter((f) => f.startsWith('.bl-write-'));

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-atomic-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: string, mode = 0o644): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  fs.chmodSync(p, mode);
  return p;
}

describe('atomicWriteFile', () => {
  it('replaces the file byte-exactly and leaves no temp file', async () => {
    const p = file('a.html', 'old');
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x0d, 0x0a, 0xf0, 0x9f, 0x98, 0x80]);
    await atomicWriteFile(p, bytes, { expectHash: sha256Hex(enc('old')) });
    expect(new Uint8Array(fs.readFileSync(p))).toEqual(bytes);
    expect(tmpFiles()).toEqual([]);
  });

  it('writes by rename: the inode changes, the old content is never half-written', async () => {
    const p = file('b.html', 'before');
    const ino = fs.statSync(p).ino;
    await atomicWriteFile(p, enc('after'), { expectHash: sha256Hex(enc('before')) });
    expect(fs.statSync(p).ino).not.toBe(ino);
    expect(fs.readFileSync(p, 'utf8')).toBe('after');
  });

  it("copies the original's mode bits (9.2 step 4.2)", async () => {
    const p = file('c.html', 'x', 0o640);
    await atomicWriteFile(p, enc('y'), { expectHash: sha256Hex(enc('x')) });
    expect(fs.statSync(p).mode & 0o777).toBe(0o640);
    const q = file('c2.html', 'x', 0o755);
    await atomicWriteFile(q, enc('y'));
    expect(fs.statSync(q).mode & 0o777).toBe(0o755);
  });

  it('a new file (app data) is private: 0600', async () => {
    const p = path.join(dir, 'new.json');
    await atomicWriteFile(p, enc('{}'));
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it('a hash other than expectHash aborts with WriteConflictError; the file and folder are unchanged (9.2 step 4.3)', async () => {
    const p = file('d.html', 'theirs');
    const err = await atomicWriteFile(p, enc('mine'), { expectHash: sha256Hex(enc('what I read')) }).catch((e) => e);
    expect(err).toBeInstanceOf(WriteConflictError);
    expect(err.name).toBe('WriteConflictError');
    expect(fs.readFileSync(p, 'utf8')).toBe('theirs');
    expect(tmpFiles()).toEqual([]);
  });

  it('a file that vanished is a conflict when a hash was expected', async () => {
    const err = await atomicWriteFile(path.join(dir, 'gone.html'), enc('x'), { expectHash: sha256Hex(enc('x')) }).catch((e) => e);
    expect(err.name).toBe('WriteConflictError');
    expect(fs.existsSync(path.join(dir, 'gone.html'))).toBe(false);
  });

  it('copies extended attributes onto the temp file before the rename', async () => {
    const p = file('e.html', 'x');
    const seen: string[] = [];
    const xattrs: XattrCopier = {
      async copy(from, to) {
        seen.push(from, path.dirname(to));
        expect(fs.existsSync(to)).toBe(true);
      },
    };
    await atomicWriteFile(p, enc('y'), { xattrs });
    expect(seen).toEqual([p, dir]);
  });

  it('a failing xattr copy aborts the write: losing an internet marker would reset trust (9.9)', async () => {
    const p = file('f.html', 'keep');
    const xattrs: XattrCopier = {
      copy: async () => {
        throw new Error('no marker');
      },
    };
    await expect(atomicWriteFile(p, enc('lose'), { xattrs })).rejects.toThrow('no marker');
    expect(fs.readFileSync(p, 'utf8')).toBe('keep');
    expect(tmpFiles()).toEqual([]);
  });

  it('refuses a read-only file and a relative path', async () => {
    if (process.getuid?.() === 0) return; // root can write anything; the W_OK check is a no-op
    const p = file('ro.html', 'x', 0o444);
    await expect(atomicWriteFile(p, enc('y'))).rejects.toThrow(/read-only/);
  });

  it('refuses a relative path and a directory', async () => {
    await expect(atomicWriteFile('rel.html', enc('y'))).rejects.toThrow(/absolute/);
    await expect(atomicWriteFile(dir, enc('y'))).rejects.toThrow(/regular file/);
  });

  it('a concurrent write between the re-hash and the rename is the only window left; the re-hash catches earlier ones', async () => {
    const p = file('g.html', 'v1');
    // A writer that lands before the re-hash (simulated by changing the file before the call) is caught.
    fs.writeFileSync(p, 'external');
    await expect(atomicWriteFile(p, enc('mine'), { expectHash: sha256Hex(enc('v1')) })).rejects.toThrow(WriteConflictError);
    expect(fs.readFileSync(p, 'utf8')).toBe('external');
  });
});

describe('xattr copiers', () => {
  it('macOS: copies com.apple.quarantine with /usr/bin/xattr, absent marker is fine', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (f, args) => {
      calls.push([f, ...args]);
      if (args[0] === '-p') return { code: 0, stdout: '0083;6720f2a1;Safari;0F2E\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    await macQuarantineCopier(exec).copy('/a/deck.html', '/a/.tmp');
    expect(calls).toEqual([
      ['/usr/bin/xattr', '-p', 'com.apple.quarantine', '/a/deck.html'],
      ['/usr/bin/xattr', '-w', 'com.apple.quarantine', '0083;6720f2a1;Safari;0F2E', '/a/.tmp'],
    ]);
    const none: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'xattr: /a/deck.html: No such xattr: com.apple.quarantine' });
    await expect(macQuarantineCopier(none).copy('/a/deck.html', '/a/.tmp')).resolves.toBeUndefined();
  });

  it('macOS: an unreadable or unwritable marker fails the copy (when unsure, refuse)', async () => {
    const broken: ExecFn = async () => ({ code: -1, stdout: '', stderr: 'spawn failed' });
    await expect(macQuarantineCopier(broken).copy('/a', '/b')).rejects.toThrow(/quarantine/);
    const noWrite: ExecFn = async (_f, args) => (args[0] === '-p' ? { code: 0, stdout: '0081;1;x;y', stderr: '' } : { code: 1, stdout: '', stderr: 'denied' });
    await expect(macQuarantineCopier(noWrite).copy('/a', '/b')).rejects.toThrow(/quarantine/);
  });

  it('Windows: copies the Zone.Identifier stream; no stream is fine', async () => {
    const written: [string, string][] = [];
    const io = {
      readFile: async (p: string) => {
        if (p === 'C:\\d\\deck.html:Zone.Identifier') return enc('[ZoneTransfer]\r\nZoneId=3\r\n');
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
      writeFile: async (p: string, b: Uint8Array) => {
        written.push([p, new TextDecoder().decode(b)]);
      },
    };
    await windowsZoneCopier(io).copy('C:\\d\\deck.html', 'C:\\d\\.tmp');
    expect(written).toEqual([['C:\\d\\.tmp:Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n']]);
    await windowsZoneCopier(io).copy('C:\\d\\other.html', 'C:\\d\\.tmp2');
    expect(written).toHaveLength(1);
    const denied = { ...io, readFile: async () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })) };
    await expect(windowsZoneCopier(denied).copy('C:\\a', 'C:\\b')).rejects.toThrow(/Zone/);
  });
});

describe('readRegularFile', () => {
  it('reads a file and refuses a directory and a FIFO without blocking', async () => {
    const p = file('r.html', 'hello');
    expect(new TextDecoder().decode(await readRegularFile(p))).toBe('hello');
    await expect(readRegularFile(dir)).rejects.toThrow();
    if (process.platform !== 'win32') {
      const fifo = path.join(dir, 'pipe.html');
      execFileSync('mkfifo', [fifo]);
      await expect(readRegularFile(fifo)).rejects.toMatchObject({ code: 'ENOTREG' });
    }
  });
});

describe('createDeckIO (core/capabilities DeckIO)', () => {
  it('reads, hashes and writes through the atomic writer; refuses when the guard says so', async () => {
    const p = file('io.html', 'one');
    let refuse: string | null = null;
    const written: string[] = [];
    const io = createDeckIO(p, { refuse: () => refuse, onWritten: (h) => written.push(h) });
    expect(io.realpath).toBe(p);
    const bytes = await io.read();
    expect(io.sha256(bytes)).toBe(sha256Hex(enc('one')));
    await io.atomicWrite(enc('two'), io.sha256(bytes));
    expect(fs.readFileSync(p, 'utf8')).toBe('two');
    expect(written).toEqual([sha256Hex(enc('two'))]);
    refuse = 'Editing is not allowed in Protected view';
    await expect(io.atomicWrite(enc('three'), sha256Hex(enc('two')))).rejects.toThrow(/Protected/);
    expect(fs.readFileSync(p, 'utf8')).toBe('two');
    await expect(io.atomicWrite(enc('x'), 'not-a-hash')).rejects.toThrow(/sha256/);
    refuse = null;
    const conflict = await io.atomicWrite(enc('x'), sha256Hex(enc('one'))).catch((e) => e);
    expect(conflict.name).toBe('WriteConflictError');
  });
});

describe('CoalescingWriter', () => {
  it('runs one write at a time and writes only the newest state when writes pile up', async () => {
    const target = path.join(dir, 'sub', 'session.json');
    const order: string[] = [];
    let release: () => void = () => undefined;
    let first = true;
    const results: (Error | null)[] = [];
    const w = new CoalescingWriter(
      target,
      (e) => results.push(e),
      async (p, b) => {
        order.push(new TextDecoder().decode(b));
        if (first) {
          first = false;
          await new Promise<void>((r) => (release = r));
        }
        await atomicWriteFile(p, b);
      },
    );
    let state = 'v1';
    const a = w.schedule(() => enc(state));
    await new Promise((r) => setTimeout(r, 10));
    state = 'v2';
    void w.schedule(() => enc(state));
    state = 'v3';
    void w.schedule(() => enc(state));
    release();
    await a;
    await w.idle();
    expect(order).toEqual(['v1', 'v3']);
    expect(fs.readFileSync(target, 'utf8')).toBe('v3');
    expect(results).toEqual([null, null]);
    expect(fs.statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
  });

  it('reports failures and keeps going', async () => {
    const results: (Error | null)[] = [];
    let n = 0;
    const w = new CoalescingWriter(path.join(dir, 'x.json'), (e) => results.push(e), async () => {
      if (n++ === 0) throw new Error('disk full');
    });
    await w.schedule(() => enc('a'));
    await w.schedule(() => enc('b'));
    expect(results.map((r) => r?.message ?? null)).toEqual(['disk full', null]);
  });
});

describe('CoalescingWriter.busy', () => {
  it('is true while a write is pending or running', async () => {
    let release: () => void = () => undefined;
    const w = new CoalescingWriter(path.join(dir, 'busy.json'), () => undefined, () => new Promise<void>((r) => (release = r)));
    expect(w.busy).toBe(false);
    const p = w.schedule(() => enc('x'));
    expect(w.busy).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await p;
    expect(w.busy).toBe(false);
  });
});
