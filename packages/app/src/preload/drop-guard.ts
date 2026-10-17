// File drops in the renderers (6.1 Ways in: "Drag a file onto … a window"; 9.1 Preload: a deck view never
// gives main a path). Two installers, both registered on `window` in the capture phase at preload start, before
// any page script, through listen() so they survive document.open() (listeners.ts):
//
// - guardDeckFileDrops (the deck preload): a drag that carries files never reaches the page. dragenter,
//   dragover, dragleave and drop are stopped at window capture (stopImmediatePropagation: no page listener in
//   either world sees them, so the page can neither read a dropped file nor learn that one was dragged), and
//   cancelled (preventDefault) with dropEffect 'none', so the cursor says the deck takes no files, no drop
//   happens, and Chromium never navigates to the file (the views also set navigateOnDragDrop: false). Drags of
//   text or elements inside the page are left alone, and so are the page's own synthetic events. A refused
//   drag calls onRefused (the deck preload sends FilesDeckToMain.dropRefused, with no payload). Audio dropped
//   on a slide arrives in Phase 5, as bytes within the media limit, never as a path.
// - installShellFileDrop (the document shell's and the welcome window's preloads): a drag that carries files is
//   accepted (dropEffect 'copy'), and on drop the preload, in its isolated world, reads each file's path with
//   webUtils.getPathForFile and sends at most 20 of them to main (FilesShellChannels.openDropped), which
//   checks and opens them (main/drop.ts). The shell page never sees a path, and a synthetic drop from the page
//   is ignored (and could name no path: getPathForFile gives '' for a File made in memory).

import { DROP_LIMITS, type DroppedFiles } from '@blueline/core/ipc-files';
import { listen } from './listeners';

type DragType = 'dragenter' | 'dragover' | 'dragleave' | 'drop';
/** listen() from listeners.ts, or a stand-in in tests. */
export type ListenFn = (win: Window, type: DragType, fn: (e: DragEvent) => void, capture: true) => void;

const defaultListen: ListenFn = (win, type, fn, capture) => listen(win, type, fn, capture);

/** A drag of files from outside the page (the `Files` type is present for every file drag, from dragenter on). */
export function carriesFiles(e: { dataTransfer: { types: ArrayLike<string> } | null }): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
  return false;
}

export interface DeckDropGuardOptions {
  /** A file drag was refused on the deck view (sent to main without any detail). At most once per `quietMs`. */
  onRefused?: () => void;
  quietMs?: number;
  now?: () => number;
  listen?: ListenFn;
}

/** The deck preload: refuse every file drag before the page sees it. Call at preload start (deck and diagnostics modes). */
export function guardDeckFileDrops(win: Window, o: DeckDropGuardOptions = {}): void {
  const add = o.listen ?? defaultListen;
  const now = o.now ?? (() => Date.now());
  const quiet = o.quietMs ?? 2000;
  let lastNotice = -Infinity;
  const notice = () => {
    const t = now();
    if (t - lastNotice < quiet) return;
    lastNotice = t;
    try {
      o.onRefused?.();
    } catch {
      // A failing notice never lets the drag through.
    }
  };
  const types: DragType[] = ['dragenter', 'dragover', 'dragleave', 'drop'];
  for (const type of types) {
    add(
      win,
      type,
      (e: DragEvent) => {
        if (!e.isTrusted || !carriesFiles(e)) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        if (e.dataTransfer && type !== 'dragleave') e.dataTransfer.dropEffect = 'none';
        if (type === 'dragenter' || type === 'drop') notice();
      },
      true,
    );
  }
}

export interface ShellDropOptions {
  /** webUtils.getPathForFile (the preload's; '' for a file that is not on disk). */
  getPathForFile(file: File): string;
  /** Sends the drop to main (ipcRenderer.invoke(FilesShellChannels.openDropped, d)). */
  open(d: DroppedFiles): unknown;
  listen?: ListenFn;
}

/** The shell's preloads: files dropped anywhere on the shell page open in Blueline (main checks them again). */
export function installShellFileDrop(win: Window, o: ShellDropOptions): void {
  const add = o.listen ?? defaultListen;
  const accept = (e: DragEvent) => {
    if (!e.isTrusted || !carriesFiles(e)) return;
    // Cancelling dragenter and dragover is what makes this a drop target.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  add(win, 'dragenter', accept, true);
  add(win, 'dragover', accept, true);
  add(
    win,
    'drop',
    (e: DragEvent) => {
      if (!e.isTrusted || !carriesFiles(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const files = e.dataTransfer?.files;
      const total = files ? files.length : 0;
      if (!files || total === 0) return;
      const paths: string[] = [];
      for (let i = 0; i < Math.min(total, DROP_LIMITS.files); i++) {
        const f = files[i];
        let p = '';
        try {
          p = f ? o.getPathForFile(f) : '';
        } catch {
          p = '';
        }
        if (typeof p === 'string' && p.length > 0 && p.length <= DROP_LIMITS.path) paths.push(p);
      }
      try {
        const r = o.open({ paths, total: Math.min(total, DROP_LIMITS.total) });
        if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => undefined);
      } catch {
        // main refused (it says why in the window)
      }
    },
    true,
  );
}
