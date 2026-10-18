// The controller's "one window per file" identity (6.1), finding 26: windows are keyed on the file's device and
// inode, with the realpath as returned as the fallback, and never case-folded, on any platform.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileKeyMap, fileKeys, windowKey } from '../../../packages/app/src/main/window-key';
import { protectedRequestNotice } from '../../../packages/app/src/main/controller';

let dir: string;
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function asPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: p });
}

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-winkey-')));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => Object.defineProperty(process, 'platform', realPlatform));

/** True when this temp folder tells Deck.html and deck.html apart (ext4, a case-sensitive APFS volume). */
function caseSensitive(): boolean {
  const probe = path.join(dir, 'CaseProbe');
  fs.writeFileSync(probe, '');
  try {
    return !fs.existsSync(path.join(dir, 'caseprobe'));
  } finally {
    fs.rmSync(probe);
  }
}

describe('windowKey', () => {
  it.runIf(caseSensitive)('Deck.html and deck.html on a case-sensitive volume are two files, even on macOS and Windows', async () => {
    const upper = path.join(dir, 'Deck.html');
    const lower = path.join(dir, 'deck.html');
    fs.writeFileSync(upper, '<title>Upper</title>');
    fs.writeFileSync(lower, '<title>Lower</title>');
    for (const p of ['darwin', 'win32', 'linux'] as const) {
      asPlatform(p);
      expect(await windowKey(upper), `platform ${p}`).not.toBe(await windowKey(lower));
    }
  });

  it('a symlink and its target are one file', async () => {
    const target = path.join(dir, 'target.html');
    const link = path.join(dir, 'link.html');
    fs.writeFileSync(target, '<title>T</title>');
    fs.symlinkSync(target, link);
    expect(await windowKey(link)).toBe(await windowKey(target));
  });
});

describe('fileKeys and FileKeyMap', () => {
  it('a hard link is the same file; the realpath key is never case-folded', async () => {
    const a = path.join(dir, 'a.html');
    const b = path.join(dir, 'b.html');
    fs.writeFileSync(a, 'a');
    fs.linkSync(a, b);
    const ka = await fileKeys(a);
    const kb = await fileKeys(b);
    expect(ka.inode).not.toBeNull();
    expect(ka.inode).toBe(kb.inode);
    asPlatform('darwin');
    expect((await fileKeys('/X/Deck.html', async () => Promise.reject(new Error('ENOENT')))).path).toBe('path:/X/Deck.html');
    expect(await windowKey('/X/Deck.html', async () => Promise.reject(new Error('ENOENT')))).toBe('path:/X/Deck.html');
  });

  it('finds a window by either key; after an atomic write (new inode) by its realpath; a reused inode is re-read', async () => {
    const deck = path.join(dir, 'deck.html');
    fs.writeFileSync(deck, 'v1');
    const m = new FileKeyMap<{ name: string; realpath: string }>();
    const w = { name: 'deck', realpath: deck };
    const atOpen = await fileKeys(deck);
    m.set(atOpen, w);
    // A symlink to it: found by the inode key.
    const link = path.join(dir, 'deck-link.html');
    fs.symlinkSync(deck, link);
    expect(m.get(await fileKeys(link))).toBe(w);
    // An atomic write replaces the file (a temp file renamed over it): new inode, same realpath.
    const tmp = path.join(dir, '.deck.tmp');
    fs.writeFileSync(tmp, 'v2');
    fs.renameSync(tmp, deck);
    expect(m.get(await fileKeys(deck))).toBe(w);
    // Another file that happens to get the window's old inode number would match a stale key: rekey reads the
    // window's current inode, so only its current file matches.
    const stale = { inode: atOpen.inode, path: 'path:/elsewhere/other.html' };
    expect(m.get(stale), 'before rekey the old inode still matches').toBe(w);
    await m.rekey((v) => v.realpath);
    expect(m.get(stale)).toBeUndefined();
    expect(m.get(await fileKeys(link))).toBe(w);
    // Deleted: found by nothing; values() lists each value once.
    expect(m.values()).toEqual([w]);
    m.delete(w);
    expect(m.get(await fileKeys(deck))).toBeUndefined();
    expect(m.values()).toEqual([]);
  });

  it('rekey keeps the order values were added in (the most recent window is the last)', async () => {
    const files = ['one.html', 'two.html', 'three.html'].map((n) => {
      const p = path.join(dir, `order-${n}`);
      fs.writeFileSync(p, n);
      return p;
    });
    const m = new FileKeyMap<string>();
    for (const f of files) m.set(await fileKeys(f), f);
    // Stats that finish in reverse order must not reorder the values.
    let delay = 30;
    await m.rekey(
      (v) => v,
      async (p) => {
        await new Promise((r) => setTimeout(r, (delay -= 10)));
        return fs.promises.stat(p, { bigint: true });
      },
    );
    expect(m.values()).toEqual(files);
  });
});

describe('Open in Protected View on a file that is already open (review finding 6; 6.1, 6.10)', () => {
  it('a Trusted window: the request is not dropped without a word', () => {
    expect(protectedRequestNotice('a.html', { trust: 'trusted', networkAllowed: false, editingAllowed: true })).toBe(
      'a.html is already open in Trusted view. Close it to open it in Protected view.',
    );
  });

  it('a Protected window with a switch on says which', () => {
    expect(protectedRequestNotice('a.html', { trust: 'protected', networkAllowed: true, editingAllowed: false })).toBe(
      'a.html is already open in Protected view with network on. Close it to open it with both off.',
    );
    expect(protectedRequestNotice('a.html', { trust: 'protected', networkAllowed: true, editingAllowed: true })).toContain('network and editing on');
    expect(protectedRequestNotice('a.html', { trust: 'protected', networkAllowed: false, editingAllowed: true })).toContain('with editing on');
  });

  it('a Protected window with both off is what was asked for: no message', () => {
    expect(protectedRequestNotice('a.html', { trust: 'protected', networkAllowed: false, editingAllowed: false })).toBeNull();
  });
});
