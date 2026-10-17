// Recent files (6.1 Ways in: File › Open Recent; 9.7 <userData>/recent.json).
//
// - recent.json holds realpaths, newest first, at most 20, without duplicates. A file is added when its window
//   opens (the views item calls add(doc.realpath)). Paths are compared exactly, never case-folded, as window
//   keys are (window-key.ts); two spellings of one file (a symlink, another case on a case-insensitive volume)
//   are merged by device and inode when the list is refreshed.
// - Missing files are dropped when the menu is built: refresh() stats every entry (asynchronously, so a slow
//   or disconnected volume never blocks main), drops the ones that are gone, and the menu is rebuilt from the
//   refreshed list (onChange). A click on an entry that has gone since is dropped too, and opens nothing.
// - macOS and Windows also get app.addRecentDocument (the Dock menu; the taskbar's jump list), and Clear Menu
//   calls app.clearRecentDocuments. Linux has no system list.
// - The file is Blueline's own app data, written through the atomic writer one write at a time
//   (CoalescingWriter). A malformed file reads as an empty list and is rewritten on the next change.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import { CoalescingWriter, atomicWriteFile } from './atomic-write';

export const MAX_RECENT = 20;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PATH = 32 * 1024;
/** Menu labels longer than this are cut in the middle. */
const MAX_LABEL = 80;

/** The parts of Electron's `app` the list uses (macOS and Windows only). */
export interface RecentAppApi {
  addRecentDocument(p: string): void;
  clearRecentDocuments(): void;
}

export interface RecentStat {
  isFile(): boolean;
  dev: number | bigint;
  ino: number | bigint;
}

export interface RecentOptions {
  /** <userData>/recent.json */
  file: string;
  platform?: NodeJS.Platform;
  /** Electron's app; the system lists are kept only on macOS and Windows. */
  app?: RecentAppApi | null;
  /** fs.promises.stat (tests inject one). */
  stat?: (p: string) => Promise<RecentStat>;
  /** The atomic write (tests inject one). */
  write?: (p: string, bytes: Uint8Array) => Promise<void>;
  log?(msg: string): void;
}

/** The stored list: absolute paths without NUL or other control characters, no duplicates, at most MAX_RECENT. */
export function sanitizeRecent(raw: unknown, pathApi: path.PlatformPath = path): string[] {
  const files = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).files : undefined;
  if (!Array.isArray(files)) return [];
  const out: string[] = [];
  for (const f of files.slice(0, MAX_RECENT * 4)) {
    if (typeof f !== 'string' || f.length === 0 || f.length > MAX_PATH) continue;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(f) || !pathApi.isAbsolute(f)) continue;
    if (!out.includes(f)) out.push(f);
    if (out.length >= MAX_RECENT) break;
  }
  return out;
}

/** `list` with `p` first, deduplicated and capped. */
export function withRecent(list: readonly string[], p: string): string[] {
  return [p, ...list.filter((x) => x !== p)].slice(0, MAX_RECENT);
}

/** Electron reads `&` in a label as a mnemonic on Windows and Linux; a file name's `&` must show as itself. */
function menuText(s: string, platform: NodeJS.Platform): string {
  return platform === 'darwin' ? s : s.replace(/&/g, '&&');
}

function cut(s: string): string {
  if (s.length <= MAX_LABEL) return s;
  const half = Math.floor((MAX_LABEL - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

/** Menu labels: the file name, and its folder's name when two entries share a file name. */
export function recentLabels(list: readonly string[], pathApi: path.PlatformPath = path): string[] {
  const names = list.map((p) => pathApi.basename(p));
  return list.map((p, i) => {
    const shared = names.filter((n) => n === names[i]).length > 1;
    const folder = pathApi.basename(pathApi.dirname(p));
    return cut(shared && folder ? `${names[i]} — ${folder}` : names[i]);
  });
}

/** File › Open Recent's submenu for `list` (pure; RecentFiles.menuItems binds it to the stored list). */
export function recentMenuItems(
  list: readonly string[],
  h: { onOpen(realpath: string): void; onClear(): void; platform: NodeJS.Platform },
): MenuItemConstructorOptions[] {
  const pathApi = h.platform === 'win32' ? path.win32 : path.posix;
  const items: MenuItemConstructorOptions[] = [];
  if (list.length === 0) items.push({ label: 'No Recent Files', enabled: false });
  const labels = recentLabels(list, pathApi);
  list.forEach((p, i) => {
    items.push({ label: menuText(labels[i], h.platform), toolTip: p, click: () => h.onOpen(p) });
  });
  items.push({ type: 'separator' });
  items.push({ label: 'Clear Menu', enabled: list.length > 0, click: () => h.onClear() });
  return items;
}

function errCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
}

export class RecentFiles {
  private files: string[] = [];
  private readonly writer: CoalescingWriter;
  private readonly listeners = new Set<() => void>();
  private readonly platform: NodeJS.Platform;
  private readonly stat: (p: string) => Promise<RecentStat>;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly o: RecentOptions) {
    this.platform = o.platform ?? process.platform;
    this.stat = o.stat ?? ((p) => fs.promises.stat(p, { bigint: true }));
    this.writer = new CoalescingWriter(
      o.file,
      (e) => {
        if (e) o.log?.(`recent.json not saved: ${e.message}`);
      },
      o.write ?? ((p, b) => atomicWriteFile(p, b)),
    );
  }

  static forUserData(userData: string, o: Omit<RecentOptions, 'file'> = {}): RecentFiles {
    return new RecentFiles({ ...o, file: path.join(userData, 'recent.json') });
  }

  /** Reads recent.json (missing or malformed: an empty list). */
  load(): string[] {
    try {
      const st = fs.statSync(this.o.file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error('bad recent.json');
      this.files = sanitizeRecent(JSON.parse(fs.readFileSync(this.o.file, 'utf8')));
    } catch (e) {
      if (errCode(e) !== 'ENOENT') this.o.log?.(`recent.json ignored: ${e instanceof Error ? e.message : String(e)}`);
      this.files = [];
    }
    return this.list();
  }

  /** The list, newest first. */
  list(): string[] {
    return [...this.files];
  }

  /** Calls `cb` after every change of the list (rebuild the menu). Returns the unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** A document opened (its realpath): first in the list, and in the system's list on macOS and Windows. */
  add(realpath: string): Promise<void> {
    if (typeof realpath !== 'string' || !path.isAbsolute(realpath) || realpath.length > MAX_PATH) return Promise.resolve();
    if (this.systemList()) {
      try {
        this.o.app!.addRecentDocument(realpath);
      } catch (e) {
        this.o.log?.(`addRecentDocument: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const next = withRecent(this.files, realpath);
    if (next.length === this.files.length && next.every((p, i) => p === this.files[i])) return this.writer.idle();
    return this.commit(next);
  }

  remove(realpath: string): Promise<void> {
    if (!this.files.includes(realpath)) return this.writer.idle();
    return this.commit(this.files.filter((p) => p !== realpath));
  }

  /** File › Open Recent › Clear Menu. */
  clear(): Promise<void> {
    if (this.systemList()) {
      try {
        this.o.app!.clearRecentDocuments();
      } catch (e) {
        this.o.log?.(`clearRecentDocuments: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (this.files.length === 0) return this.writer.idle();
    return this.commit([]);
  }

  /**
   * Drops entries that are no longer regular files, and later entries that are the same file as an earlier one
   * (device and inode). Run it before the menu is built (at startup, when the app becomes active); it emits
   * onChange when the list changed.
   */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const snapshot = this.list();
      const keep: string[] = [];
      const seen = new Set<string>();
      const results = await Promise.all(
        snapshot.map(async (p) => {
          try {
            const st = await this.stat(p);
            return st.isFile() ? `${st.dev}:${st.ino}` : null;
          } catch {
            return null;
          }
        }),
      );
      snapshot.forEach((p, i) => {
        const key = results[i];
        if (key === null || seen.has(key)) return;
        seen.add(key);
        keep.push(p);
      });
      // Only entries this refresh looked at are dropped: one added meanwhile stays.
      const dropped = new Set(snapshot.filter((p) => !keep.includes(p)));
      if (dropped.size > 0) await this.commit(this.files.filter((p) => !dropped.has(p)));
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * The Open Recent submenu. `onOpen` gets the realpath (open it as File › Open does); an entry whose file is
   * gone by the time it is clicked is dropped instead.
   */
  menuItems(onOpen: (realpath: string) => void): MenuItemConstructorOptions[] {
    return recentMenuItems(this.files, {
      platform: this.platform,
      onOpen: (p) => void this.openIfThere(p, onOpen),
      onClear: () => void this.clear(),
    });
  }

  idle(): Promise<void> {
    return this.writer.idle();
  }

  get busy(): boolean {
    return this.writer.busy;
  }

  private async openIfThere(p: string, onOpen: (realpath: string) => void): Promise<void> {
    let ok = false;
    try {
      ok = (await this.stat(p)).isFile();
    } catch {
      ok = false;
    }
    if (ok) onOpen(p);
    else await this.remove(p);
  }

  private systemList(): boolean {
    return !!this.o.app && (this.platform === 'darwin' || this.platform === 'win32');
  }

  private commit(next: string[]): Promise<void> {
    this.files = next;
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (e) {
        this.o.log?.(`recent: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return this.writer.schedule(() => new TextEncoder().encode(JSON.stringify({ files: this.files }, null, 2) + '\n'));
  }
}
