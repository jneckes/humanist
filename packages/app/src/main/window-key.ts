// One window per file (6.1): the identity of the file a path names, for the controller's window map. No
// Electron here, so it is unit-tested on real files (test/unit/app/controller.test.ts).
//
// A file is known by two keys, and two paths name the same file when either key matches:
//   - `ino:<dev>:<ino>`: its device and inode (fs.stat with bigint: NTFS file ids do not fit a double). Two
//     spellings on a case-insensitive volume, a symlink and its target, and hard links share it; two files whose
//     names differ only in case on a case-sensitive volume (case-sensitive APFS, a case-sensitive NTFS folder)
//     do not. Finding 26: the realpath used to be lowercased on macOS and Windows, which made such two files
//     share one window.
//   - `path:<realpath>`: the realpath as returned, never case-folded. It is the fallback when stat fails or
//     gives no inode number, and it still finds a window after its file was replaced by an atomic write (a temp
//     file renamed over it has a new inode: an editor's save, Blueline's own writes, 9.2 Atomic write step 4).
// Inode numbers are reused once a file is deleted, so an open window's inode key is read again from its
// realpath before each lookup (FileKeyMap.rekey), never kept from the time the window opened.

import * as fs from 'node:fs';

export interface FileStat {
  dev: bigint;
  ino: bigint;
}
export type StatFn = (p: string) => Promise<FileStat>;

const defaultStat: StatFn = (p) => fs.promises.stat(p, { bigint: true });

export interface FileKeys {
  /** `ino:<dev>:<ino>`, or null when the file could not be stat'ed or has no inode number. */
  inode: string | null;
  /** `path:<realpath as given>`, never case-folded. */
  path: string;
}

/** The keys of the file at `realpath` (following symlinks). */
export async function fileKeys(realpath: string, stat: StatFn = defaultStat): Promise<FileKeys> {
  let inode: string | null = null;
  try {
    const st = await stat(realpath);
    if (typeof st.ino === 'bigint' && st.ino !== 0n) inode = `ino:${st.dev}:${st.ino}`;
  } catch {
    // no inode key: the realpath alone identifies it
  }
  return { inode, path: `path:${realpath}` };
}

/** The window key of a file: its device and inode, else its realpath as returned (never case-folded). */
export async function windowKey(realpath: string, stat: StatFn = defaultStat): Promise<string> {
  const k = await fileKeys(realpath, stat);
  return k.inode ?? k.path;
}

function keyList(k: FileKeys): string[] {
  return k.inode ? [k.inode, k.path] : [k.path];
}

/** Values (open windows, or opens in flight) found by either key of their file. */
export class FileKeyMap<T> {
  private readonly byKey = new Map<string, T>();
  private readonly keysOf = new Map<T, string[]>();

  /**
   * Adds `v` under the file's keys, replacing what `v` was known by before. A value already present keeps its
   * place in values() (the controller's "most recent window" is the last one).
   */
  set(keys: FileKeys, v: T): void {
    for (const k of this.keysOf.get(v) ?? []) if (this.byKey.get(k) === v) this.byKey.delete(k);
    const list = keyList(keys);
    for (const k of list) this.byKey.set(k, v);
    this.keysOf.set(v, list);
  }

  /** The value whose file has either of these keys (the inode key first). */
  get(keys: FileKeys): T | undefined {
    for (const k of keyList(keys)) {
      const v = this.byKey.get(k);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  has(v: T): boolean {
    return this.keysOf.has(v);
  }

  delete(v: T): void {
    const list = this.keysOf.get(v);
    if (!list) return;
    this.keysOf.delete(v);
    for (const k of list) if (this.byKey.get(k) === v) this.byKey.delete(k);
  }

  values(): T[] {
    return [...this.keysOf.keys()];
  }

  /**
   * Reads every value's inode key again from its realpath (an atomic write gives the file a new inode, and a
   * deleted file's inode number can be reused by another file). A value removed meanwhile stays removed.
   */
  async rekey(realpathOf: (v: T) => string, stat: StatFn = defaultStat): Promise<void> {
    await Promise.all(
      this.values().map(async (v) => {
        const keys = await fileKeys(realpathOf(v), stat);
        if (this.keysOf.has(v)) this.set(keys, v);
      }),
    );
  }
}
