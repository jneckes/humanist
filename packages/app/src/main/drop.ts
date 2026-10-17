// Files dropped on a window (6.1 Ways in: "Drag a file onto the Dock icon or a window").
//
// - On the shell's areas (toolbar, rails, status bar, the welcome window): the shell preload reads each dropped
//   file's path with webUtils.getPathForFile, in its isolated world (preload/drop-guard.ts
//   installShellFileDrop), and sends at most 20 of them on FilesShellChannels.openDropped. Main checks each one
//   again (an absolute path to an existing regular file whose name ends in .html or .htm, as File › Open's
//   filter) and opens it through File › Open's path (AppController.open: one window per file, the file's own
//   trust state). The shell page itself never handles a path.
// - On the deck view: the deck preload refuses every file drag in the capture phase (guardDeckFileDrops), so
//   the page never sees the files and Chromium never navigates to one. 9.1: a deck view never gives main a
//   path; at most it says that a drop was refused (FilesDeckToMain.dropRefused, no payload), and main says
//   where to drop instead. Audio dropped on a slide (bytes, not a path) is Phase 5.
// - On the Dock icon (macOS): open-file, handled by open-file.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DROP_LIMITS, FilesShellChannels, type DropResult, type DroppedFiles } from '@blueline/core/ipc-files';
import { shellRouter } from './channels';
import { OPENABLE_EXTENSIONS, isDocumentId } from './documents';
import type { ArgsValidator, ShellIpc, ShellSender, Validated, Validator } from './ipc-guard';

/** The welcome window's ShellIpc key (first-run.ts); document windows are keyed by their docId. */
export const WELCOME_WINDOW_KEY = 'welcome';

/** Said when a file is dropped on the deck view (main shows it in that window, at most every few seconds). */
export const DROP_REFUSED_TEXT = 'To open a file, drop it on the toolbar or the slide rail.';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** openDropped(files): one plain object with the paths (at most 20 absolute paths) and the drop's file count. */
export const validateDroppedFiles: ArgsValidator<DroppedFiles> = (args): Validated<DroppedFiles> => {
  if (args.length !== 1) return { ok: false, why: 'one argument' };
  const v = args[0];
  if (v === null || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return { ok: false, why: 'not a plain object' };
  const own = (k: string): unknown => {
    const d = Object.getOwnPropertyDescriptor(v, k);
    return d && 'value' in d ? d.value : undefined;
  };
  const paths = own('paths');
  const total = own('total');
  if (!Array.isArray(paths) || Object.getPrototypeOf(paths) !== Array.prototype) return { ok: false, why: 'paths' };
  if (paths.length > DROP_LIMITS.files) return { ok: false, why: `more than ${DROP_LIMITS.files} paths` };
  if (typeof total !== 'number' || !Number.isInteger(total) || total < paths.length || total > DROP_LIMITS.total) return { ok: false, why: 'total' };
  const out: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const d = Object.getOwnPropertyDescriptor(paths, i);
    const p = d && 'value' in d ? d.value : undefined;
    if (typeof p !== 'string' || p.length === 0 || p.length > DROP_LIMITS.path) return { ok: false, why: `paths[${i}]` };
    if (CONTROL.test(p) || LONE_SURROGATE.test(p)) return { ok: false, why: `paths[${i}]: control character` };
    out.push(p);
  }
  return { ok: true, value: { paths: out, total } };
};

/** FilesDeckToMain.dropRefused carries nothing (9.1: never a path, a name or a count). */
export const validateDropRefused: Validator<null> = (p) => (p === undefined || p === null ? { ok: true, value: null } : { ok: false, why: 'unexpected payload' });

/** At most one "drop it on the toolbar" notice per window this often, whatever the page sends. */
export class RefusedDropNotice {
  private last = -Infinity;
  constructor(private readonly intervalMs = 3000) {}
  take(now = Date.now()): boolean {
    if (now - this.last < this.intervalMs) return false;
    this.last = now;
    return true;
  }
}

export interface DropFs {
  stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  realpath(p: string): Promise<string>;
}

const nodeDropFs: DropFs = {
  stat: (p) => fs.promises.stat(p),
  realpath: (p) => fs.promises.realpath(p),
};

function extensionOf(name: string): string {
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
}

/** One dropped path, checked as File › Open would see it: an existing regular .html or .htm file. */
export async function vetDroppedPath(
  p: string,
  o: { fs?: DropFs; pathApi?: path.PlatformPath } = {},
): Promise<{ ok: true; path: string } | { ok: false; name: string; reason: string }> {
  const pathApi = o.pathApi ?? path;
  const io = o.fs ?? nodeDropFs;
  const name = pathApi.basename(p) || p;
  if (!pathApi.isAbsolute(p)) return { ok: false, name, reason: 'not a file path' };
  let st: { isFile(): boolean; isDirectory(): boolean };
  let real: string;
  try {
    st = await io.stat(p);
    real = await io.realpath(p);
  } catch {
    return { ok: false, name, reason: 'not found' };
  }
  if (st.isDirectory()) return { ok: false, name, reason: 'a folder' };
  if (!st.isFile()) return { ok: false, name, reason: 'not a regular file' };
  // The name dropped and the file it leads to (a symlink): both must be HTML, as loadDocument checks the realpath.
  if (!OPENABLE_EXTENSIONS.has(extensionOf(name)) || !OPENABLE_EXTENSIONS.has(extensionOf(pathApi.basename(real)))) {
    return { ok: false, name, reason: 'not an HTML file' };
  }
  return { ok: true, path: p };
}

/** Checks a drop's paths and opens the good ones, one after another, through File › Open's path. */
export async function openDroppedFiles(d: DroppedFiles, deps: { open(p: string): Promise<unknown>; fs?: DropFs; pathApi?: path.PlatformPath }): Promise<DropResult> {
  const looked = Math.min(d.total, DROP_LIMITS.files);
  const result: DropResult = { opened: 0, refused: [], skipped: Math.max(0, d.total - DROP_LIMITS.files) };
  // Items with no file on this computer behind them (dragged from a browser) have no path at all.
  const noPath = Math.max(0, looked - d.paths.length);
  for (let i = 0; i < noPath; i++) result.refused.push({ name: 'an item', reason: 'not a file on this computer' });
  for (const p of d.paths.slice(0, DROP_LIMITS.files)) {
    const v = await vetDroppedPath(p, { fs: deps.fs, pathApi: deps.pathApi });
    if (!v.ok) {
      result.refused.push({ name: v.name, reason: v.reason });
      continue;
    }
    await deps.open(v.path);
    result.opened++;
  }
  return result;
}

/** What to tell the user about a drop, or null when everything opened. */
export function dropResultText(r: DropResult): string | null {
  const parts: string[] = [];
  if (r.refused.length === 1) {
    const x = r.refused[0];
    parts.push(x.reason === 'not an HTML file' ? `${x.name} is not an HTML file. Blueline opens .html and .htm files.` : `${x.name} was not opened (${x.reason}).`);
  } else if (r.refused.length > 1) {
    const shown = r.refused.slice(0, 5).map((x) => `${x.name} (${x.reason})`);
    const more = r.refused.length > 5 ? `, and ${r.refused.length - 5} more` : '';
    parts.push(`${r.refused.length} files were not opened: ${shown.join(', ')}${more}.`);
  }
  if (r.skipped > 0) parts.push(`A drop opens at most ${DROP_LIMITS.files} files; ${r.skipped} more were not opened.`);
  return parts.length > 0 ? parts.join(' ') : null;
}

export interface DropHandlerDeps {
  /** File › Open's path: AppController.open(p, { protected: false }). */
  open(p: string): Promise<unknown>;
  /** Tell the user what did not open (dropResultText), in the window the drop came from. */
  report?(from: ShellSender, r: DropResult): void;
  log?(msg: string): void;
  /** The shell router (default shellRouter(); tests pass their own). */
  router?: ShellIpc;
}

const declared = new WeakSet<ShellIpc>();

/**
 * Declares FilesShellChannels.openDropped once, through the shell router: ShellIpc accepts it only from a
 * registered shell's main frame with origin app://shell, and this handler only from a document window's shell
 * or the welcome window (Settings and Diagnostics never take drops). Call once at startup.
 */
export function installDropHandler(deps: DropHandlerDeps): void {
  const router = deps.router ?? shellRouter();
  if (declared.has(router)) return;
  declared.add(router);
  router.handle(FilesShellChannels.openDropped, validateDroppedFiles, async (from, d) => {
    if (from.windowKey !== WELCOME_WINDOW_KEY && !isDocumentId(from.windowKey)) throw new Error('Refused');
    const r = await openDroppedFiles(d, { open: deps.open });
    if (r.refused.length || r.skipped) deps.log?.(`drop: ${r.opened} opened, ${r.refused.length} refused, ${r.skipped} skipped`);
    try {
      deps.report?.(from, r);
    } catch (e) {
      deps.log?.(`drop report: ${e instanceof Error ? e.message : String(e)}`);
    }
    return r;
  });
}
