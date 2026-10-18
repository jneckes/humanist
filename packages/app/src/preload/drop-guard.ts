// File drops in the renderers (6.1 Ways in: "Drag a file onto … a window"; 9.1 Preload: a deck view never
// gives main a path). Two installers, both registered on `window` in the capture phase at preload start, before
// any page script, through listen() so they survive document.open() (listeners.ts):
//
// - guardDeckFileDrops (the deck preload): a drag that carries files never reaches the page. dragenter,
//   dragover, dragleave and drop are stopped at window capture (stopImmediatePropagation: no page listener in
//   either world sees them, so the page can neither read a dropped file nor learn that one was dragged), and
//   cancelled (preventDefault) with dropEffect 'none', so the cursor says the deck takes no files, no drop
//   happens, and Chromium never navigates to the file (the views also set navigateOnDragDrop: false). Every
//   frame of the deck view gets the same guard (see "frames" below). Drags of
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

// ------------------------------------------------------------------------------------------- frames
//
// A drag over an <iframe> goes to that frame's own document (Blink hands it to the child frame's event handler),
// so the guard above, on the top window, never sees it (review finding 2). Every frame of a deck view gets the
// same guard (9.1: a deck view never sees a dropped file, in either trust state):
//
// - Frames the deck preload runs in: the deck views set nodeIntegrationInSubFrames (window.ts), so the preload
//   runs in every subframe (srcdoc, data:, blob:, same-origin and cross-origin documents), before the frame's
//   scripts; there it installs guardFrameDrops and nothing else (deck.ts).
// - Frames it does not run in time for (PHASE0-FINDINGS F11): the initial about:blank document of a frame a
//   script makes. The parent's isolated world reaches it while it is same-origin: inserting such a frame fires
//   its load event synchronously, so a capture listener on the parent document guards the child window before
//   the parent's script runs its next statement. The guard covers the frames already there too, and nested
//   frames the same way.
// - document.open() erases a window's listeners (listeners.ts), the guard's included. A MutationObserver on the
//   frame's document sees the root element go and installs the guard again. That runs after the scripts the
//   page wrote in, so a listener those scripts put on the frame's window, capture phase, runs before the guard
//   until then (the same ordering limit as listeners.ts states for the top window).

type FrameOwner = { tagName?: unknown; contentWindow?: Window | null };

/** The listeners installed on each window, kept so they can be added again after document.open(). */
const installed = new WeakMap<Window, { type: DragType; fn: (e: DragEvent) => void }[]>();
/** Documents watched for document.open() (their root element replaced) and for frames loading in them. */
const watchedDocs = new WeakSet<Document>();

/** The child window of a frame owner element (iframe, frame, object, embed), or null. */
function childWindowOf(t: EventTarget | null): Window | null {
  const o = t as FrameOwner | null;
  if (!o || typeof o.tagName !== 'string') return null;
  const tag = o.tagName.toUpperCase();
  if (tag !== 'IFRAME' && tag !== 'FRAME' && tag !== 'OBJECT' && tag !== 'EMBED') return null;
  try {
    return o.contentWindow ?? null;
  } catch {
    return null;
  }
}

/** The window's document when this world can reach it (same origin), else null (that frame's own preload guards it). */
function reachableDocument(w: Window): Document | null {
  try {
    const d = w.document;
    return d ?? null;
  } catch {
    return null;
  }
}

/** Adds (or adds again) the refusing drag listeners on one window, capture phase. */
function installOn(w: Window, onRefused: (() => void) | undefined): void {
  let list = installed.get(w);
  if (!list) {
    list = [];
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop'] as DragType[]) {
      list.push({
        type,
        fn: (e: DragEvent) => {
          if (!e.isTrusted || !carriesFiles(e)) return;
          e.stopImmediatePropagation();
          e.preventDefault();
          if (e.dataTransfer && type !== 'dragleave') e.dataTransfer.dropEffect = 'none';
          if (type === 'dragenter' || type === 'drop') {
            try {
              onRefused?.();
            } catch {
              // A failing notice never lets the drag through.
            }
          }
        },
      });
    }
    installed.set(w, list);
  }
  // addEventListener ignores a (type, callback, capture) triple that is already registered.
  for (const l of list) {
    try {
      w.addEventListener(l.type, l.fn as EventListener, true);
    } catch {
      // the window went away
    }
  }
}

/**
 * Guards the same-origin frames inside `w` (not `w` itself): the frames there now, every frame that loads later
 * (the load event, capture phase, on w's document), and their frames in turn. Re-installs after document.open().
 */
function watchFrames(w: Window, onRefused: (() => void) | undefined, guardSelf: boolean): void {
  const doc = reachableDocument(w);
  if (!doc) return;
  if (guardSelf) installOn(w, onRefused);
  if (!watchedDocs.has(doc)) {
    watchedDocs.add(doc);
    const onLoad = (e: Event) => {
      const child = childWindowOf(e.target);
      if (child) watchFrames(child, onRefused, true);
    };
    const addLoad = () => {
      try {
        doc.addEventListener('load', onLoad, true);
      } catch {
        // the document went away
      }
    };
    addLoad();
    try {
      // document.open() replaces the root element and erases every listener: add them again.
      const MO = (w as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver ?? MutationObserver;
      new MO(() => {
        if (guardSelf) installOn(w, onRefused);
        addLoad();
        scanFrames(w, onRefused);
      }).observe(doc, { childList: true });
    } catch {
      // no observer in this document: the load listener and the scan still apply
    }
  }
  scanFrames(w, onRefused);
}

function scanFrames(w: Window, onRefused: (() => void) | undefined): void {
  let n = 0;
  try {
    n = w.frames.length;
  } catch {
    return;
  }
  for (let i = 0; i < n; i++) {
    let child: Window | null = null;
    try {
      child = w.frames[i] ?? null;
    } catch {
      child = null;
    }
    if (child) watchFrames(child, onRefused, true);
  }
}

/**
 * The deck preload in the top frame: guard every same-origin frame below it (the top window itself is guarded
 * by guardDeckFileDrops). A refused drag there tells main the same bare "refused" (onRefused).
 */
export function guardChildFrames(win: Window, o: { onRefused?: () => void; quietMs?: number; now?: () => number } = {}): void {
  const now = o.now ?? (() => Date.now());
  const quiet = o.quietMs ?? 2000;
  let lastNotice = -Infinity;
  const notice = () => {
    const t = now();
    if (t - lastNotice < quiet) return;
    lastNotice = t;
    o.onRefused?.();
  };
  watchFrames(win, notice, false);
}

/**
 * The deck preload in a subframe (nodeIntegrationInSubFrames): refuse file drags on this frame and on the
 * same-origin frames inside it. Nothing else runs in a subframe: no overlay, no IPC, no API (deck.ts).
 */
export function guardFrameDrops(win: Window): void {
  watchFrames(win, undefined, true);
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
