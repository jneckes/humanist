// Recent files (6.1 Open Recent; 9.7 recent.json): realpaths, newest first, at most 20, without duplicates,
// missing files dropped when the menu is built, the system's recent list on macOS and Windows, Clear Menu.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import { MAX_RECENT, RecentFiles, recentLabels, recentMenuItems, sanitizeRecent, withRecent } from '../../../packages/app/src/main/recent';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-recent-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function deckFile(name: string, sub = ''): string {
  const d = path.join(dir, sub);
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, name);
  fs.writeFileSync(p, `<title>${name}</title>`);
  return p;
}

function fakeApp() {
  const calls: string[] = [];
  return { calls, app: { addRecentDocument: (p: string) => calls.push(`add ${p}`), clearRecentDocuments: () => calls.push('clear') } };
}

function labels(items: MenuItemConstructorOptions[]): (string | undefined)[] {
  return items.map((i) => (i.type === 'separator' ? '—' : i.label));
}

describe('the list rules', () => {
  it('newest first, deduplicated, at most 20', () => {
    let l: string[] = [];
    for (let i = 0; i < 25; i++) l = withRecent(l, `/d/${i}.html`);
    expect(l).toHaveLength(MAX_RECENT);
    expect(l[0]).toBe('/d/24.html');
    expect(l.at(-1)).toBe('/d/5.html');
    l = withRecent(l, '/d/10.html');
    expect(l[0]).toBe('/d/10.html');
    expect(l.filter((p) => p === '/d/10.html')).toHaveLength(1);
    expect(l).toHaveLength(MAX_RECENT);
  });

  it('paths are compared exactly, never case-folded (as window keys are)', () => {
    expect(withRecent(['/d/Deck.html'], '/d/deck.html')).toEqual(['/d/deck.html', '/d/Deck.html']);
  });

  it('sanitizeRecent keeps absolute paths only, without control characters or duplicates', () => {
    expect(sanitizeRecent({ files: ['/a.html', 'rel.html', '/b\u0000.html', '/a.html', 7, '', '/c\n.html', '/d.htm'] })).toEqual(['/a.html', '/d.htm']);
    expect(sanitizeRecent({ files: Array.from({ length: 50 }, (_, i) => `/${i}.html`) })).toHaveLength(MAX_RECENT);
    for (const bad of [null, [], 'x', { files: 'x' }, { files: null }]) expect(sanitizeRecent(bad)).toEqual([]);
    expect(sanitizeRecent({ files: ['C:\\Decks\\a.html', '/x.html'] }, path.win32)).toEqual(['C:\\Decks\\a.html', '/x.html']);
  });

  it('labels: the file name, with its folder when two entries share a name; long names cut in the middle', () => {
    expect(recentLabels(['/a/q4/deck.html', '/a/q3/deck.html', '/a/notes.html'])).toEqual(['deck.html — q4', 'deck.html — q3', 'notes.html']);
    const long = recentLabels([`/a/${'x'.repeat(200)}.html`])[0];
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).toContain('…');
    expect(recentLabels(['C:\\Decks\\Q4\\plan.html'], path.win32)).toEqual(['plan.html']);
  });
});

describe('recentMenuItems (File › Open Recent)', () => {
  it('one item per file, then Clear Menu; an empty list says so', () => {
    const opened: string[] = [];
    let cleared = 0;
    const items = recentMenuItems(['/a/one.html', '/b/two.htm'], { platform: 'darwin', onOpen: (p) => opened.push(p), onClear: () => cleared++ });
    expect(labels(items)).toEqual(['one.html', 'two.htm', '—', 'Clear Menu']);
    expect(items[0].toolTip).toBe('/a/one.html');
    (items[1].click as () => void)();
    (items[3].click as () => void)();
    expect(opened).toEqual(['/b/two.htm']);
    expect(cleared).toBe(1);
    const empty = recentMenuItems([], { platform: 'linux', onOpen: () => undefined, onClear: () => undefined });
    expect(labels(empty)).toEqual(['No Recent Files', '—', 'Clear Menu']);
    expect(empty[0].enabled).toBe(false);
    expect(empty[2].enabled).toBe(false);
  });

  it('a "&" in a file name shows as itself on Windows and Linux (not a mnemonic)', () => {
    const l = (platform: NodeJS.Platform) => recentMenuItems(['/a/R&D.html'], { platform, onOpen: () => undefined, onClear: () => undefined })[0].label;
    expect(l('win32')).toBe('R&&D.html');
    expect(l('linux')).toBe('R&&D.html');
    expect(l('darwin')).toBe('R&D.html');
  });
});

describe('RecentFiles (recent.json)', () => {
  it('add writes recent.json, newest first; a new store reads it back', async () => {
    const r = RecentFiles.forUserData(dir);
    r.load();
    const a = deckFile('a.html');
    const b = deckFile('b.html');
    await r.add(a);
    await r.add(b);
    await r.add(a);
    expect(r.list()).toEqual([a, b]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'recent.json'), 'utf8')) as { files: string[] };
    expect(onDisk.files).toEqual([a, b]);
    expect(RecentFiles.forUserData(dir).load()).toEqual([a, b]);
  });

  it('a missing or malformed recent.json is an empty list, rewritten on the next change', async () => {
    fs.writeFileSync(path.join(dir, 'recent.json'), '{not json');
    const logs: string[] = [];
    const r = RecentFiles.forUserData(dir, { log: (m) => logs.push(m) });
    expect(r.load()).toEqual([]);
    expect(logs.length).toBe(1);
    await r.add(deckFile('a.html'));
    expect(RecentFiles.forUserData(dir).load()).toHaveLength(1);
    expect(RecentFiles.forUserData(path.join(dir, 'nowhere')).load()).toEqual([]);
  });

  it('refresh drops missing files and merges two paths to one file (device and inode), and says so', async () => {
    const r = RecentFiles.forUserData(dir);
    r.load();
    const a = deckFile('a.html');
    const gone = deckFile('gone.html');
    const link = path.join(dir, 'link.html');
    fs.symlinkSync(a, link);
    const folder = path.join(dir, 'folder.html');
    fs.mkdirSync(folder);
    for (const p of [folder, a, gone, link]) await r.add(p);
    fs.unlinkSync(gone);
    let changes = 0;
    r.onChange(() => changes++);
    await r.refresh();
    expect(r.list()).toEqual([link]);
    expect(changes).toBe(1);
    await r.refresh();
    expect(changes).toBe(1);
    expect(RecentFiles.forUserData(dir).load()).toEqual([link]);
  });

  it('menuItems: a click opens the realpath; a file gone since the menu was built is dropped, not opened', async () => {
    const r = RecentFiles.forUserData(dir);
    r.load();
    const a = deckFile('a.html');
    const b = deckFile('b.html');
    await r.add(a);
    await r.add(b);
    const opened: string[] = [];
    const items = r.menuItems((p) => opened.push(p));
    expect(labels(items)).toEqual(['b.html', 'a.html', '—', 'Clear Menu']);
    fs.unlinkSync(a);
    (items[0].click as () => void)();
    (items[1].click as () => void)();
    await new Promise((res) => setTimeout(res, 50));
    await r.idle();
    expect(opened).toEqual([b]);
    expect(r.list()).toEqual([b]);
  });

  it('macOS and Windows: addRecentDocument for each open; Clear Menu clears both lists', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const { calls, app } = fakeApp();
      const r = new RecentFiles({ file: path.join(dir, `${platform}.json`), platform, app });
      r.load();
      const a = deckFile(`${platform}.html`);
      await r.add(a);
      const clear = r.menuItems(() => undefined).at(-1)!;
      (clear.click as () => void)();
      await r.idle();
      expect(calls).toEqual([`add ${a}`, 'clear']);
      expect(r.list()).toEqual([]);
    }
  });

  it('Linux keeps only recent.json (no system list)', async () => {
    const { calls, app } = fakeApp();
    const r = new RecentFiles({ file: path.join(dir, 'recent.json'), platform: 'linux', app });
    r.load();
    await r.add(deckFile('a.html'));
    await r.clear();
    expect(calls).toEqual([]);
  });

  it('refuses relative paths; onChange fires on add, remove and clear; a throwing listener is logged', async () => {
    const logs: string[] = [];
    const r = RecentFiles.forUserData(dir, { log: (m) => logs.push(m) });
    r.load();
    let n = 0;
    const off = r.onChange(() => n++);
    r.onChange(() => {
      throw new Error('menu');
    });
    await r.add('relative.html');
    expect(r.list()).toEqual([]);
    const a = deckFile('a.html');
    await r.add(a);
    await r.remove(a);
    await r.add(a);
    await r.clear();
    expect(n).toBe(4);
    off();
    await r.add(a);
    expect(n).toBe(4);
    expect(logs.some((l) => l.includes('menu'))).toBe(true);
  });

  it('the menu follows an add at once, before recent.json is written; adds during a write end in one more write with both', async () => {
    // File › Open Recent never waits for the file (the hardening round's full run once read recent.json before the
    // second open's write landed, while the menu already listed both).
    const writes: string[][] = [];
    const held: (() => void)[] = [];
    const r = new RecentFiles({
      file: path.join(dir, 'recent.json'),
      write: (_p, bytes) =>
        new Promise<void>((resolve) => {
          writes.push((JSON.parse(new TextDecoder().decode(bytes)) as { files: string[] }).files);
          held.push(resolve);
        }),
    });
    r.load();
    let changes = 0;
    r.onChange(() => changes++);
    const a = deckFile('a.html');
    const b = deckFile('b.html');
    const first = r.add(a);
    await new Promise((res) => setTimeout(res, 10));
    // The first write is held; the second open comes meanwhile.
    expect(writes).toEqual([[a]]);
    const second = r.add(b);
    expect(changes).toBe(2);
    expect(labels(r.menuItems(() => undefined))).toEqual(['b.html', 'a.html', '—', 'Clear Menu']);
    expect(r.busy).toBe(true);
    // Only the first write has started; the second waits for it and carries both.
    expect(writes).toEqual([[a]]);
    held.shift()!();
    await new Promise((res) => setTimeout(res, 10));
    expect(writes).toEqual([[a], [b, a]]);
    held.shift()!();
    await Promise.all([first, second]);
    expect(r.busy).toBe(false);
    expect(writes).toHaveLength(2);
  });

  it('a write error is logged, and the list stays in memory', async () => {
    const logs: string[] = [];
    const r = new RecentFiles({ file: path.join(dir, 'recent.json'), write: async () => Promise.reject(new Error('disk full')), log: (m) => logs.push(m) });
    r.load();
    await r.add(deckFile('a.html'));
    expect(r.list()).toHaveLength(1);
    expect(logs).toContain('recent.json not saved: disk full');
  });
});
