// IPC contract of the window's views (Phase 1; 6.0 The window, 6.9 Reading): the deck and document views, their
// zoom (Fit, 100%, Fill width), Reading Width, the rail, Present, Find and navigation. Types, channel names and
// limits only: environment-neutral, so the shell, the preloads and main import it by subpath
// (`@blueline/core/ipc-views`).
//
// Main validates every payload as written by its sender (9.1): the deck view's messages as written by the page
// (packages/app/src/main/views.ts validators), the shell's calls through ShellIpc. A deck view's messages can
// only move its own view (a step, a pan) or report what it measured; none of them changes trust, opens
// anything or names a path.

// ----------------------------------------------------------------------------------------- views (6.9)

/** 6.9 Deck view options: Fit (the default), 100% (the design size), Fill width. */
export type ZoomMode = 'fit' | 'actual' | 'fill';

/** Which view the document gets (6.9): a deck (9.4 reveal or generic) or a document (scroll or single). */
export type ViewKind = 'deck' | 'document';

/** 6.9: View › Reading Width narrows the document view to this many CSS px, centred. */
export const READING_WIDTH = 960;

/** The deck view's zoom factor is kept within what Chromium can show (Electron clamps to 0.25..5). */
export const ZOOM_LIMITS = Object.freeze({ min: 0.25, max: 5 });

/** Scroll bars of the shell drawn beside a deck view larger than the window (100%, Fill width), in CSS px. */
export const SCROLLBAR_SIZE = 12;

/** Status bar label of a zoom mode (6.0: "Fit · 85%"). */
export function zoomLabel(mode: ZoomMode): string {
  return mode === 'fit' ? 'Fit' : mode === 'fill' ? 'Fill width' : '100%';
}

/** The zoom factor as a whole percentage for the status bar. */
export function zoomPercent(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? Math.round(zoom * 100) : 100;
}

// ----------------------------------------------------------------------------------------- deck preload ↔ main

/** Deck preload → main (`ipcRenderer.send`). */
export const ViewsDeckToMain = {
  /**
   * DesignReport: the design size the visible view measured (6.9: reveal.js width and height, else the slide
   * element's box at a 1600×900 viewport) and the viewport it measured at. Main uses a box only when it was
   * measured at 1600×900, so a deck sized in viewport units cannot shrink its own view in a loop.
   */
  design: 'bl:views:design',
  /** PageStep: PageUp or PageDown the deck did not use (6.9 Navigation); main moves the deck one slide. */
  pageStep: 'bl:views:page-step',
  /** WheelPan: a wheel the page did not use, while the deck view is larger than the window (100%, Fill width). */
  wheel: 'bl:views:wheel',
} as const;

/** Main → deck preload (`webContents.send`). */
export const MainToDeckViews = {
  /** GotoRequest: show a slide or a document heading (the rail, the outline, Find, PageUp and PageDown). */
  goto: 'bl:views:goto',
  /** NavReplay: main presses the deck's own keys (an index deck, 6.7 Index replay); the key router lets them in. */
  navReplay: 'bl:views:nav-replay',
  /** PanAxes: the deck view is larger than the window on these axes (100%, Fill width): an unused wheel pans it. */
  pan: 'bl:views:pan',
} as const;

export interface PanAxes {
  x: boolean;
  y: boolean;
}

export interface DesignReport {
  /** The slide engine the visible view detected (9.4). */
  kind: 'reveal' | 'generic';
  w: number;
  h: number;
  /** innerWidth and innerHeight when it was measured (CSS px). */
  viewportW: number;
  viewportH: number;
}

export interface PageStep {
  dir: 1 | -1;
}

export interface WheelPan {
  /** CSS px of the page; main converts with the zoom factor. */
  dx: number;
  dy: number;
}

/**
 * How the preload shows a slide or heading. reveal: Reveal.slide(h, v) in the page's world (integers only);
 * hash: `location.hash`; scroll: the n-th 9.4 scroll block into view; heading: the n-th of `h1, h2, h3`
 * (SlideIndexEntry.heading) into view; top: the top of the page (a document's text before its first heading).
 * Index decks are moved by main's own keys (NavReplay). `replace` on a hash puts the URL hash back with
 * history.replaceState (no hashchange): after a hash goto the deck did not follow (it writes its hash but never
 * reads it, review finding 17), the URL names the slide the deck shows again before main falls back to keys.
 */
export type GotoRequest =
  | { kind: 'top' }
  | { kind: 'reveal'; h: number; v: number }
  | { kind: 'hash'; hash: string; replace?: boolean }
  | { kind: 'scroll'; index: number }
  | { kind: 'heading'; index: number };

export interface NavReplay {
  active: boolean;
}

export const VIEWS_LIMITS = Object.freeze({
  /** Design sizes outside this range are not slide sizes (render-service validViewport caps 16384). */
  designMin: 16,
  designMax: 16_384,
  /** |dx| and |dy| of one wheel pan (CSS px). */
  wheel: 10_000,
  /** UTF-8 bytes of a goto hash. */
  hash: 2 * 1024,
  /** Slides and headings (IPC_LIMITS.slides). */
  index: 10_000,
});

// ----------------------------------------------------------------------------------------- shell ↔ main

/**
 * Shell commands (ViewsShellToMain.command): the toolbar's and the Find bar's buttons. Each runs the menu item of
 * the same name in main (actions.ts); nothing else can be named.
 */
export type ShellCommand =
  | 'present'
  | 'save-pdf'
  | 'print'
  | 'find'
  | 'zoom-fit'
  | 'zoom-actual'
  | 'zoom-fill'
  | 'reading-width'
  | 'toggle-rail'
  | 'about-protected';

export const SHELL_COMMANDS: readonly ShellCommand[] = Object.freeze([
  'present',
  'save-pdf',
  'print',
  'find',
  'zoom-fit',
  'zoom-actual',
  'zoom-fill',
  'reading-width',
  'toggle-rail',
  'about-protected',
]);

/** Shell → main (`ipcRenderer.invoke`). */
export const ViewsShellToMain = {
  /** (command: ShellCommand) → void. */
  command: 'bl:views:command',
  /** (entry: number) → boolean. The rail or the outline: show slide (deck) or section heading (document) `entry`. */
  show: 'bl:views:show',
  /** (x: number, y: number) → void. The shell's scroll bars moved: the deck view follows (100%, Fill width). */
  scroll: 'bl:views:scroll',
  /** () → void. The Find bar closed: the deck view's highlight goes (stopFindInPage). */
  findClosed: 'bl:views:find-closed',
} as const;

/** Main → shell (`webContents.send`). */
export const MainToShellViews = {
  /** No payload. Cmd+F: show the Find bar and put the caret in it. */
  findOpen: 'bl:views:find-open',
  /** { x, y }: main panned the deck view (a wheel over the page); the shell's scroll bars follow. */
  scrollTo: 'bl:views:scroll-to',
} as const;

/** What the shell shows of the views (ShellState.view). */
export interface ShellView {
  /** null until the document's kind is known (the deck view lays out as a deck until then). */
  kind: ViewKind | null;
  zoomMode: ZoomMode;
  /** The deck view's zoom factor (documents: 1). */
  zoom: number;
  /** The document view is narrowed to READING_WIDTH (View › Reading Width; remembered per file). */
  readingWidth: boolean;
  /** View › Hide Slides (remembered). */
  railHidden: boolean;
  /** Present (6.9): the shell shows no chrome, only the letterbox. */
  presenting: boolean;
  /**
   * The deck view is larger than the window (100%, Fill width): the size of what scrolls (the deck view, CSS px)
   * and where it is scrolled to. null when everything is shown.
   */
  scroll: { width: number; height: number; x: number; y: number } | null;
}

/** The slide index as the rail and the outline use it (ShellState.index). */
export interface ShellIndex {
  version: string;
  /** The walk is running for the current version. */
  building: boolean;
  /** The index of the current version is ready (titles, outline and Find work). */
  ready: boolean;
  kind: 'reveal' | 'generic' | 'scroll' | 'single' | null;
  /** Deck slide titles, or document section titles, in index order. */
  titles: string[];
  /** Documents: the outline entries (index entries that start at a heading), with their level. */
  outline: { entry: number; level: 1 | 2 | 3; title: string }[];
}

/** The status bar's extra fields (ShellState.status). */
export interface ShellStatus {
  /** A long task: "Saving PDF…", "Printing…". */
  task: string | null;
  /** 6.6: "Deck changed · reloads when you finish". */
  reloadDeferred: boolean;
  /** 9.2 Watcher: the file is gone from its path; the window keeps the last version, read-only. */
  fileGone: boolean;
}
