// History snapshots (9.7 history/, newest 100 kept; 9.2 Undo and redo 4; decisions P2-11, P2-12; 9.9 Derived files
// keep the marker): one file per distinct version named by its sha256, an atomic index, 0600 files, the newest
// entries within a byte budget, checked reads, the base kept apart, and the derived-file marker on every snapshot of
// a Protected document (on the temp file, before the rename).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256Hex } from '../../../packages/app/src/main/atomic-write';
import { HistoryStore, MAX_HISTORY_BYTES, MAX_HISTORY_ENTRIES, historyDirFor, readHistoryIndex, type HistoryOptions, type SnapshotMeta } from '../../../packages/app/src/main/history';
import type { DerivedSource } from '../../../packages/app/src/main/markers';

let root: string;
let n = 0;
beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-history-')));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const DECK = '/Users/j/Decks/deck.html';
const enc = (s: string) => new TextEncoder().encode(s);
const meta = (bytes: Uint8Array, over: Partial<SnapshotMeta> = {}): SnapshotMeta => ({
  sha256: sha256Hex(bytes),
  contentHash: sha256Hex(bytes),
  cause: 'edit',
  at: '2026-10-19T10:00:00.000Z',
  ...over,
});
function fresh(opts: Partial<HistoryOptions> = {}): { dir: string; h: HistoryStore } {
  const dir = path.join(root, `h${n++}`, 'history');
  return { dir, h: HistoryStore.at(dir, { realpath: DECK, ...opts }) };
}
const files = (dir: string) => fs.readdirSync(dir).sort();
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe('layout', () => {
  it('<userData>/files/<fileKey>/history, fileKey checked', () => {
    expect(historyDirFor('/ud', '0123456789abcdef')).toBe(path.join('/ud', 'files', '0123456789abcdef', 'history'));
    expect(() => historyDirFor('/ud', '../../etc')).toThrow();
  });

  it('forFile gives one store per folder, so every window of a file writes through one chain', () => {
    const ud = path.join(root, 'ud-registry');
    const a = HistoryStore.forFile(ud, 'aaaaaaaaaaaaaaaa', { realpath: DECK });
    expect(HistoryStore.forFile(ud, 'aaaaaaaaaaaaaaaa', { realpath: DECK })).toBe(a);
    expect(HistoryStore.forFile(ud, 'bbbbbbbbbbbbbbbb', { realpath: DECK })).not.toBe(a);
    expect(a.dir).toBe(path.join(ud, 'files', 'aaaaaaaaaaaaaaaa', 'history'));
    expect(() => HistoryStore.at(path.join(root, 'rel'), { realpath: 'deck.html' })).toThrow(/absolute/);
  });

  it(`defaults: newest ${MAX_HISTORY_ENTRIES}, ${MAX_HISTORY_BYTES / 1024 / 1024} MiB of snapshot files per document`, () => {
    expect(MAX_HISTORY_ENTRIES).toBe(100);
    // 100 versions of a 2 MB deck fit; a larger deck keeps fewer.
    expect(MAX_HISTORY_BYTES).toBeGreaterThanOrEqual(100 * 2 * 1024 * 1024);
  });
});

describe('snapshot', () => {
  it('writes <sha256>.html (0600, folder 0700) and index.json (0600); lists newest first', async () => {
    const { dir, h } = fresh();
    const v1 = enc('<h1>One</h1>');
    const v2 = enc('<h1>Two</h1>');
    const id1 = await h.snapshot(v1, meta(v1, { noteId: 'n-0001' }));
    const id2 = await h.snapshot(v2, meta(v2, { cause: 'undo', at: '2026-10-19T10:01:00.000Z' }));
    expect([id1, id2]).toEqual(['h-1', 'h-2']);
    expect(files(dir)).toEqual([`${sha256Hex(v1)}.html`, `${sha256Hex(v2)}.html`, 'index.json'].sort());
    expect(new Uint8Array(fs.readFileSync(path.join(dir, `${sha256Hex(v1)}.html`)))).toEqual(v1);
    if (process.platform !== 'win32') {
      expect(mode(dir)).toBe(0o700);
      expect(mode(path.join(dir, 'index.json'))).toBe(0o600);
      expect(mode(path.join(dir, `${sha256Hex(v2)}.html`))).toBe(0o600);
    }
    expect(h.list()).toEqual([
      { id: 'h-2', sha256: sha256Hex(v2), contentHash: sha256Hex(v2), cause: 'undo', at: '2026-10-19T10:01:00.000Z', size: v2.byteLength },
      { id: 'h-1', sha256: sha256Hex(v1), contentHash: sha256Hex(v1), cause: 'edit', noteId: 'n-0001', at: '2026-10-19T10:00:00.000Z', size: v1.byteLength },
    ]);
    expect(await h.read('h-1')).toEqual(v1);
    expect(h.entry('h-2')!.cause).toBe('undo');
    expect(h.entry('h-9')).toBeNull();
    expect(h.findBySha256(sha256Hex(v1))!.id).toBe('h-1');
  });

  it('refuses bytes that do not have the sha256 given, and malformed metadata, writing nothing', async () => {
    const { dir, h } = fresh();
    const v = enc('x');
    await expect(h.snapshot(v, meta(enc('y')))).rejects.toThrow(/sha256/);
    for (const bad of [
      { sha256: 'abc' },
      { contentHash: 'Z'.repeat(64) },
      { cause: 'agent' as never },
      { at: '' },
      { at: 'x'.repeat(65) },
      { at: 't\n' },
      { noteId: '../n-0001' },
      { marker: 5 as never },
    ]) {
      await expect(h.snapshot(v, meta(v, bad)), JSON.stringify(bad)).rejects.toThrow();
    }
    await expect(h.snapshot('x' as never, meta(v))).rejects.toThrow();
    await h.idle();
    expect(fs.existsSync(dir)).toBe(false);
    expect(h.list()).toEqual([]);
  });

  it('dedupes by sha256: the same bytes twice are one file and two entries (an edit undone and redone)', async () => {
    const { dir, h } = fresh();
    const a = enc('<p>A</p>');
    const b = enc('<p>B</p>');
    await h.snapshot(a, meta(a, { cause: 'edit' }));
    await h.snapshot(b, meta(b, { cause: 'undo' }));
    await h.snapshot(a, meta(a, { cause: 'redo' }));
    expect(h.list().map((e) => [e.id, e.cause, e.sha256])).toEqual([
      ['h-3', 'redo', sha256Hex(a)],
      ['h-2', 'undo', sha256Hex(b)],
      ['h-1', 'edit', sha256Hex(a)],
    ]);
    expect(files(dir).filter((f) => f.endsWith('.html'))).toHaveLength(2);
    expect(h.totalBytes()).toBe(a.byteLength + b.byteLength);
  });

  it('snapshots taken without waiting are written one at a time, in order; idle() and busy follow them', async () => {
    const { h } = fresh();
    const vs = Array.from({ length: 8 }, (_, i) => enc(`<p>version ${i}</p>`));
    const all = vs.map((v, i) => h.snapshot(v, meta(v, { at: `2026-10-19T10:00:0${i}.000Z` })));
    expect(h.busy).toBe(true);
    expect(await Promise.all(all)).toEqual(vs.map((_, i) => `h-${i + 1}`));
    await h.idle();
    expect(h.busy).toBe(false);
    expect(h.list().map((e) => e.sha256)).toEqual(vs.map((v) => sha256Hex(v)).reverse());
  });

  it('copies the bytes when called: a caller reusing its buffer does not change the snapshot', async () => {
    const { h } = fresh();
    const v = enc('<p>kept</p>');
    const p = h.snapshot(v, meta(v));
    v.fill(0x41);
    const id = await p;
    expect(new TextDecoder().decode(await h.read(id))).toBe('<p>kept</p>');
  });
});

describe('pruning and the budget', () => {
  it('keeps the newest maxEntries; a file goes when no entry refers to it; ids are never reused', async () => {
    const { dir, h } = fresh({ maxEntries: 3 });
    const vs = ['a', 'b', 'c', 'd', 'a'].map((s) => enc(`<p>${s}</p>`));
    for (const v of vs) await h.snapshot(v, meta(v));
    expect(h.list().map((e) => e.id)).toEqual(['h-5', 'h-4', 'h-3']);
    // a (h-1) went, but a is h-5 again: its file stays; b's (h-2) file is gone.
    const html = files(dir).filter((f) => f.endsWith('.html'));
    expect(html.sort()).toEqual([vs[2], vs[3], vs[4]].map((v) => `${sha256Hex(v)}.html`).sort());
    const e = enc('<p>e</p>');
    expect(await h.snapshot(e, meta(e))).toBe('h-6');
    await expect(h.read('h-1')).rejects.toThrow(/no such snapshot/);
  });

  it('keeps the files within maxBytes, oldest first, but always the newest snapshot', async () => {
    const { dir, h } = fresh({ maxBytes: 250 });
    const big = (c: string) => enc(c.repeat(100));
    for (const c of ['a', 'b', 'c']) await h.snapshot(big(c), meta(big(c)));
    expect(h.list().map((x) => x.id)).toEqual(['h-3', 'h-2']);
    expect(h.totalBytes()).toBe(200);
    // One snapshot larger than the whole budget is still kept, alone.
    const huge = enc('z'.repeat(400));
    await h.snapshot(huge, meta(huge));
    expect(h.list().map((x) => x.id)).toEqual(['h-4']);
    expect(files(dir).filter((f) => f.endsWith('.html'))).toEqual([`${sha256Hex(huge)}.html`]);
    await h.prune();
    expect(h.list()).toHaveLength(1);
  });

  it('countSince(id): what "Restore deck to <time>" discards, the snapshot’s own write included', async () => {
    const { h } = fresh();
    const causes = ['edit', 'external', 'edit', 'undo', 'external', 'restore'] as const;
    const ids: string[] = [];
    for (const [i, cause] of causes.entries()) {
      const v = enc(`<p>${i}</p>`);
      ids.push(await h.snapshot(v, meta(v, { cause })));
    }
    expect(h.countSince(ids[0])).toEqual({ direct: 4, external: 2 });
    expect(h.countSince(ids[2])).toEqual({ direct: 3, external: 1 });
    expect(h.countSince(ids[5])).toEqual({ direct: 1, external: 0 });
    expect(h.countSince('h-99')).toBeNull();
  });
});

describe('the base (P2-12: the last version main knew)', () => {
  it('is stored like a snapshot, read by sha256, and never pruned', async () => {
    const { dir, h } = fresh({ maxEntries: 1, maxBytes: 10 });
    const base = enc('<p>the version main knows</p>');
    await h.setBase(base, { sha256: sha256Hex(base), contentHash: sha256Hex(base), at: 't0' });
    expect(h.base()).toEqual({ sha256: sha256Hex(base), contentHash: sha256Hex(base), at: 't0' });
    for (const s of ['x', 'y', 'z']) await h.snapshot(enc(s), meta(enc(s)));
    expect(h.list()).toHaveLength(1);
    expect(await h.readSha256(sha256Hex(base))).toEqual(base);
    expect(fs.existsSync(path.join(dir, `${sha256Hex(base)}.html`))).toBe(true);
    // A snapshot of the same bytes shares the file.
    await h.snapshot(base, meta(base, { cause: 'edit' }));
    expect(files(dir).filter((f) => f.endsWith('.html'))).toEqual([`${sha256Hex(base)}.html`]);
    // A new base replaces it; the old file goes once nothing refers to it.
    const next = enc('<p>newer</p>');
    await h.setBase(next, { sha256: sha256Hex(next), contentHash: sha256Hex(next), at: 't1' });
    await h.snapshot(enc('w'), meta(enc('w')));
    expect(await h.readSha256(sha256Hex(base))).toBeNull();
    expect(await h.readSha256(sha256Hex(next))).toEqual(next);
    expect(await h.readSha256('nope')).toBeNull();
    await expect(h.setBase(next, { sha256: sha256Hex(base), contentHash: sha256Hex(next), at: 't' })).rejects.toThrow(/sha256/);
    await expect(h.setBase(next, { sha256: sha256Hex(next), contentHash: 'x', at: 't' })).rejects.toThrow();
  });
});

describe('checked reads', () => {
  it('a damaged or replaced snapshot file is refused, never restored', async () => {
    const { dir, h } = fresh();
    const v = enc('<p>original bytes</p>');
    const id = await h.snapshot(v, meta(v));
    const file = path.join(dir, `${sha256Hex(v)}.html`);
    fs.writeFileSync(file, '<p>original bytez</p>');
    await expect(h.read(id)).rejects.toThrow(/damaged/);
    expect(await h.readSha256(sha256Hex(v))).toBeNull();
    fs.writeFileSync(file, '<p>original</p>');
    await expect(h.read(id)).rejects.toThrow();
    // A file put back by a later snapshot of the same bytes reads again.
    fs.rmSync(file);
    await h.snapshot(v, meta(v));
    expect(await h.read(id)).toEqual(v);
  });

  it('a link in place of a snapshot file never yields other bytes', async () => {
    const { dir, h } = fresh();
    const v = enc('<p>v</p>');
    const id = await h.snapshot(v, meta(v));
    const file = path.join(dir, `${sha256Hex(v)}.html`);
    const elsewhere = path.join(root, `elsewhere-${n++}.html`);
    // Same size, other bytes: the size check passes, the hash check refuses.
    fs.writeFileSync(elsewhere, '<p>w</p>');
    fs.rmSync(file);
    fs.symlinkSync(elsewhere, file);
    await expect(h.read(id)).rejects.toThrow(/damaged/);
    // A FIFO there is refused without blocking (readRegularFile).
    if (process.platform !== 'win32') {
      fs.rmSync(file);
      const { spawnSync } = await import('node:child_process');
      if (spawnSync('mkfifo', [file]).status === 0) await expect(h.read(id)).rejects.toThrow();
    }
  });
});

describe('reopening the folder', () => {
  it('reads the index back; an entry whose file is gone is dropped; strays and temp files are swept', async () => {
    const { dir, h } = fresh();
    const a = enc('<p>a</p>');
    const b = enc('<p>b</p>');
    await h.snapshot(a, meta(a));
    await h.snapshot(b, meta(b, { cause: 'external' }));
    await h.setBase(b, { sha256: sha256Hex(b), contentHash: sha256Hex(b), at: 'tb' });
    const listed = h.list();
    const again = HistoryStore.at(dir, { realpath: DECK });
    expect(again.list()).toEqual(listed);
    expect(again.base()).toEqual({ sha256: sha256Hex(b), contentHash: sha256Hex(b), at: 'tb' });
    await again.idle();

    // A crash left a snapshot file without an index entry, and a temp file; someone removed a's file.
    const stray = `${'e'.repeat(64)}.html`;
    fs.writeFileSync(path.join(dir, stray), 'stray');
    fs.writeFileSync(path.join(dir, '.bl-write-0123456789abcdef.tmp'), 'tmp');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');
    fs.rmSync(path.join(dir, `${sha256Hex(a)}.html`));
    const third = HistoryStore.at(dir, { realpath: DECK });
    expect(third.list().map((e) => e.sha256)).toEqual([sha256Hex(b)]);
    await third.idle();
    expect(files(dir)).toEqual([`${sha256Hex(b)}.html`, 'index.json', 'notes.txt'].sort());
    // The id counter survives, so a new snapshot never reuses an id.
    expect(await third.snapshot(a, meta(a))).toBe('h-3');
  });

  it('an unreadable index is kept aside, the list starts empty, and no snapshot file is deleted', async () => {
    const { dir, h } = fresh();
    const a = enc('<p>a</p>');
    await h.snapshot(a, meta(a));
    fs.writeFileSync(path.join(dir, 'index.json'), '{"version": 1, "entries": [');
    const again = HistoryStore.at(dir, { realpath: DECK });
    expect(again.list()).toEqual([]);
    await again.idle();
    expect(files(dir).some((f) => f.startsWith('index.json.unreadable-'))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${sha256Hex(a)}.html`))).toBe(true);
  });

  it('readHistoryIndex rebuilds field by field and drops what it cannot read', () => {
    const sha = 'a'.repeat(64);
    const good = { id: 'h-1', sha256: sha, contentHash: sha, cause: 'edit', at: 't' };
    const s = readHistoryIndex({
      version: 1,
      next: 2,
      files: { [sha]: { size: 3, marked: true, extra: 1 }, ['b'.repeat(64)]: { size: -1 }, nope: { size: 1 } },
      entries: [
        good,
        { ...good, id: 'h-1' },
        { ...good, id: 'h-2', cause: 'agent' },
        { ...good, id: 'h-3', sha256: 'c'.repeat(64) },
        { ...good, id: 'x-4' },
        { ...good, id: 'h-5', noteId: 'bad' },
        { ...good, id: 'h-6', at: 7 },
        { ...good, id: 'h-7', noteId: 'n-0002', evil: true },
      ],
      base: { sha256: 'b'.repeat(64), contentHash: sha, at: 't' },
    })!;
    expect(s.entries.map((e) => e.id)).toEqual(['h-1', 'h-7']);
    expect(s.entries[1]).toEqual({ id: 'h-7', sha256: sha, contentHash: sha, cause: 'edit', at: 't', noteId: 'n-0002', size: 3 });
    expect([...s.files.keys()]).toEqual([sha]);
    expect(s.base).toBeNull();
    // `next` never goes back below an id in use.
    expect(s.next).toBe(8);
    expect(readHistoryIndex({ version: 2 })).toBeNull();
    expect(readHistoryIndex([])).toBeNull();
    expect(readHistoryIndex(JSON.parse('{"version":1,"files":{"__proto__":{"size":1}},"entries":[]}'))!.files.size).toBe(0);
  });
});

describe('derived-file marker (9.9): a Protected document’s snapshots carry its marker', () => {
  type Call = { temp: string; source: DerivedSource; dir: string; existed: boolean };
  const recorder = () => {
    const calls: Call[] = [];
    const mark = async (temp: string, source: DerivedSource) => {
      calls.push({ temp, source, dir: path.dirname(temp), existed: fs.existsSync(temp) });
    };
    return { calls, mark };
  };

  it('Trusted (no marker given): nothing is marked', async () => {
    const r = recorder();
    const { h } = fresh({ mark: r.mark });
    const v = enc('<p>t</p>');
    await h.snapshot(v, meta(v));
    expect(r.calls).toEqual([]);
  });

  it('Protected: the temp file is marked before the rename, with the marker, or a new one naming the document', async () => {
    const r = recorder();
    const { dir, h } = fresh({ mark: r.mark });
    const a = enc('<p>a</p>');
    const b = enc('<p>b</p>');
    await h.snapshot(a, meta(a, { marker: '0083;67000000;Safari;' }));
    await h.snapshot(b, meta(b, { marker: null }));
    expect(r.calls).toHaveLength(2);
    for (const c of r.calls) {
      expect(c.dir).toBe(dir);
      expect(path.basename(c.temp)).toMatch(/^\.bl-write-[0-9a-f]{16}\.tmp$/);
      expect(c.existed).toBe(true);
    }
    expect(r.calls[0].source).toEqual({ realpath: DECK, marker: '0083;67000000;Safari;', protectedView: true });
    expect(r.calls[1].source).toEqual({ realpath: DECK, marker: null, protectedView: true });
  });

  it('a file first stored unmarked is written again with the marker when a Protected snapshot needs it', async () => {
    const r = recorder();
    const { dir, h } = fresh({ mark: r.mark });
    const v = enc('<p>same</p>');
    await h.snapshot(v, meta(v));
    expect(r.calls).toHaveLength(0);
    await h.snapshot(v, meta(v, { marker: 'm' }));
    expect(r.calls).toHaveLength(1);
    // Marked once, it is not written again.
    await h.snapshot(v, meta(v, { marker: 'm' }));
    await h.snapshot(v, meta(v));
    expect(r.calls).toHaveLength(1);
    expect(new Uint8Array(fs.readFileSync(path.join(dir, `${sha256Hex(v)}.html`)))).toEqual(v);
    // The index remembers it (a reopened store does not mark it again).
    const again = HistoryStore.at(dir, { realpath: DECK, mark: r.mark });
    await again.snapshot(v, meta(v, { marker: 'm' }));
    expect(r.calls).toHaveLength(1);
    // A marked file that went missing and was written again unmarked is no longer counted as marked.
    fs.rmSync(path.join(dir, `${sha256Hex(v)}.html`));
    await again.snapshot(v, meta(v));
    expect(r.calls).toHaveLength(1);
    await again.snapshot(v, meta(v, { marker: 'm' }));
    expect(r.calls).toHaveLength(2);
  });

  it('a marker that cannot be written fails the snapshot and leaves no file and no entry', async () => {
    const { dir, h } = fresh({
      mark: async () => {
        throw new Error('Could not write the marker');
      },
    });
    const v = enc('<p>p</p>');
    await expect(h.snapshot(v, meta(v, { marker: 'm' }))).rejects.toThrow(/marker/);
    expect(h.list()).toEqual([]);
    expect(fs.existsSync(dir) ? files(dir).filter((f) => f.endsWith('.html') || f.endsWith('.tmp')) : []).toEqual([]);
    // The store still works for the next snapshot.
    const t = HistoryStore.at(dir, { realpath: DECK });
    await t.snapshot(v, meta(v));
    expect(t.list()).toHaveLength(1);
  });

  it('with markers.ts markDerivedFile (macOS, a fake helper): the quarantine value is set on the temp file', async () => {
    const set: { target: string; arg: unknown }[] = [];
    const helper = {
      readQuarantine: async () => ({ ok: true as const, value: null }),
      copyXattrs: async () => undefined,
      setQuarantine: async (target: string, arg: unknown) => {
        set.push({ target, arg });
      },
    };
    const { dir, h } = fresh({ markOptions: { platform: 'darwin', helper } });
    const a = enc('<p>mac</p>');
    const b = enc('<p>mac 2</p>');
    await h.snapshot(a, meta(a, { marker: '0083;67000000;Safari;' }));
    await h.snapshot(b, meta(b, { marker: null }));
    expect(set).toHaveLength(2);
    expect(path.dirname(set[0].target)).toBe(dir);
    expect(set[0].arg).toEqual({ value: '0083;67000000;Safari;' });
    expect(set[1].arg).toEqual({ properties: { agent: 'Blueline', originUrl: 'file:///Users/j/Decks/deck.html' } });
  });
});
