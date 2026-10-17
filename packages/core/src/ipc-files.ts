// IPC contract of the files lifecycle (Phase 1): files dropped on the shell (6.1 Ways in), the deck view's
// view state around a reload (6.6 Reload when the file changes on disk; 9.2 Watcher), and the first-run
// welcome window (6.0 First run). Types, channel names and strings only: environment-neutral, so the shell
// pages and the preloads import it by subpath (`@blueline/core/ipc-files`).
//
// Main validates every payload here as written by its sender (9.1): the deck view's messages as written by
// the page (packages/app/src/main/view-state.ts), the shells' calls through ShellIpc (drop.ts, first-run.ts).
// A deck view never gives main a path (9.1 Preload): a file dropped on the deck view is refused in the
// preload's capture phase and only a bare "refused" signal reaches main.

import type { AppMode } from './ipc';
import type { DefaultAppResult, DefaultAppStatus } from './ipc-trust';

// ----------------------------------------------------------------------------------------- drops (6.1)

/** Shell → main (`ipcRenderer.invoke`), from the shell preload's drop listener (preload/drop-guard.ts). */
export const FilesShellChannels = {
  /** (DroppedFiles) → DropResult. Files dropped on a shell area (toolbar, rails, status bar, welcome window). */
  openDropped: 'bl:files:open-dropped',
} as const;

/** Deck preload → main (`ipcRenderer.send`). */
export const FilesDeckToMain = {
  /**
   * No payload. A file was dragged over or dropped on the deck view and refused there (preload/drop-guard.ts):
   * main may say where to drop it instead. It never carries a path, a name or a count (9.1).
   */
  dropRefused: 'bl:files:drop-refused',
  /** ViewStateReply: the answer to MainToDeckFiles.captureViewState. */
  viewState: 'bl:files:view-state',
  /** DeckBusy: sent whenever it changes, and once after each init (6.6: reloads wait for edits and cards). */
  busy: 'bl:files:busy',
} as const;

/** Main → deck preload (`webContents.send`). */
export const MainToDeckFiles = {
  /** CaptureViewState: report the view state now (before a reload, 6.6). */
  captureViewState: 'bl:files:capture-view-state',
  /** DeckViewState: restore it (after the reloaded page's init, 6.6). */
  applyViewState: 'bl:files:apply-view-state',
} as const;

/** What the shell preload sends for one drop: the paths of at most DROP_LIMITS.files files, and how many were dropped. */
export interface DroppedFiles {
  paths: string[];
  /** The number of files in the drop (`paths` holds the first DROP_LIMITS.files of them). */
  total: number;
}

/** What main did with a drop. */
export interface DropResult {
  /** Files handed to File › Open's path (one window per file; an open file's window is focused). */
  opened: number;
  /** Files refused, by name (never the full path) and why. */
  refused: { name: string; reason: string }[];
  /** Files past DROP_LIMITS.files that were not looked at. */
  skipped: number;
}

export const DROP_LIMITS = Object.freeze({
  /** Files opened per drop (more are skipped, and the result says so). */
  files: 20,
  /** UTF-16 units of one path (Windows long paths reach 32,767). */
  path: 32 * 1024,
  /** The largest `total` main accepts. */
  total: 100_000,
});

// ----------------------------------------------------------------------------------------- view state (6.6)

/**
 * The deck view's state, saved before a reload and restored after (6.6: "scroll position, URL hash, current
 * slide index and the open card"). The preload reports it and applies it; main treats it as written by the
 * page (bounded numbers, a hash of at most 2 KB, a note id of the section 8 pattern, 64 KB of draft text).
 */
export interface DeckViewState {
  /** `document.scrollingElement` scrollLeft/scrollTop (CSS px; x is negative in a right-to-left page). */
  scroll: { x: number; y: number };
  /** `location.hash`: '' or '#…'. Hash decks show their slide from it (9.4). */
  hash: string;
  /** SlideState.current when the state was taken, or null when the deck has no slide model. */
  slide: number | null;
  /** The open note card: its note id and the text it shows (6.5: a reload never loses a draft). */
  card: { noteId: string; draft: string } | null;
}

/** MainToDeckFiles.captureViewState. */
export interface CaptureViewState {
  reqId: number;
}

/** FilesDeckToMain.viewState. */
export interface ViewStateReply {
  reqId: number;
  state: DeckViewState;
}

/**
 * FilesDeckToMain.busy: what holds a reload back (6.6: "reloads at once only if no edit is active and no card
 * has unsaved input"). `edit`: an in-place text edit is open (Phase 2). `card`: no card, a card open with
 * everything it shows already sent to main, or a card with input main has not seen yet.
 */
export interface DeckBusy {
  edit: boolean;
  card: 'none' | 'open' | 'dirty';
}

export const VIEW_STATE_LIMITS = Object.freeze({
  /** UTF-8 bytes of `hash`. */
  hash: 2 * 1024,
  /** UTF-8 bytes of the card's draft (9.1: 64 KB of note text). */
  draft: 64 * 1024,
  /** |scroll.x| and |scroll.y| (CSS px). */
  scroll: 10_000_000,
  /** Slide indexes (IPC_LIMITS.slides). */
  slides: 10_000,
});

/** 6.6: the status shown while a reload waits for an edit or a card. */
export const RELOAD_DEFERRED_TEXT = 'Deck changed · reloads when you finish';
/** 9.2 Watcher: the file is gone from its path (deleted, or renamed away). */
export function fileGoneText(fileName: string): string {
  return `${fileName} was moved or deleted. Blueline shows the last version it read, and edits are off until the file is back.`;
}

// ----------------------------------------------------------------------------------------- welcome (6.0)

/** Welcome shell → main (`ipcRenderer.invoke`). Main answers only the welcome window's own shell. */
export const WelcomeToMain = {
  /** () → WelcomeState. */
  getState: 'bl:welcome:get-state',
  /** () → WelcomeOpenResult. Main shows the Open dialog itself: the page never names a file. */
  openFile: 'bl:welcome:open-file',
  /** () → DefaultAppResult. macOS: the native helper (from macOS 26.4 the system asks); Windows: Default Apps. */
  makeDefaultApp: 'bl:welcome:make-default-app',
  /** () → WelcomeOpenResult. Copies the sample deck into app data on first use and opens the copy. */
  openSample: 'bl:welcome:open-sample',
  /** (name: string) → NameResult. The name on your notes (6.8), stored in config.json. */
  setName: 'bl:welcome:set-name',
  /** (on: boolean) → void. 9.9 Telemetry: crash reports are opt-in, asked once. */
  setCrashReports: 'bl:welcome:set-crash-reports',
  /** () → void. Closes the welcome window. */
  close: 'bl:welcome:close',
} as const;

/** Main → welcome shell (`webContents.send`). */
export const MainToWelcome = {
  /** WelcomeState, after every change. */
  state: 'bl:welcome:state',
} as const;

export interface WelcomeState {
  platform: 'darwin' | 'win32' | 'linux' | 'other';
  /** The name on your notes now (config.json; from git or the OS user until you change it, 6.8). */
  name: string;
  /** 9.9 Telemetry: null until answered. */
  crashReports: boolean | null;
  /** Whether Blueline is the default HTML app, once main has asked (null while it asks). */
  defaultApp: DefaultAppStatus | null;
  /** The sample deck was opened from this window, and the modes the tour saw it in (Read → Review → Edit). */
  sample: { opened: boolean; modesSeen: AppMode[] };
}

export interface WelcomeOpenResult {
  ok: boolean;
  /** The user closed the Open dialog. */
  canceled?: boolean;
  /** Why nothing opened. */
  reason?: string;
}

export interface NameResult {
  ok: boolean;
  /** The name as stored (trimmed). */
  name: string;
  reason?: string;
}

/** Limits main enforces on welcome calls (the page's inputs mirror them). */
export const WELCOME_LIMITS = Object.freeze({
  /** UTF-16 units of a name (config.ts MAX_NAME). */
  name: 200,
});

/** The API the welcome preload exposes as window.blueline (named, typed functions only; 9.1). */
export interface WelcomeApi {
  getState(): Promise<WelcomeState>;
  onState(cb: (s: WelcomeState) => void): void;
  openFile(): Promise<WelcomeOpenResult>;
  makeDefaultApp(): Promise<DefaultAppResult>;
  openSample(): Promise<WelcomeOpenResult>;
  setName(name: string): Promise<NameResult>;
  setCrashReports(on: boolean): Promise<void>;
  close(): Promise<void>;
}

/** One step of the sample deck's tour (6.0: "a short guided tour"). The user switches mode with the shortcut. */
export interface TourStep {
  mode: AppMode;
  title: string;
  /** What to do, with the shortcut in the platform's spelling. */
  text: string;
}

/** The tour: Read → Review → Edit, each step done by the user in the sample deck's window. */
export function tourSteps(platform: WelcomeState['platform']): TourStep[] {
  const mod = platform === 'darwin' ? 'Cmd' : 'Ctrl';
  return [
    {
      mode: 'read',
      title: 'Read',
      text: `The deck opens in Read. Page through it with the arrow keys. ${mod}+1 always brings you back here.`,
    },
    {
      mode: 'review',
      title: 'Review',
      text: `Press ${mod}+2 for Review. Circle something on a slide and type a note on the card that opens.`,
    },
    {
      mode: 'edit',
      title: 'Edit',
      text: `Press ${mod}+3 for Edit. Click a headline and retype it: the change is saved to the file at once.`,
    },
  ];
}
