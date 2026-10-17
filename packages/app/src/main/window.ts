// One window per document (6.0 The window; 9.1 Windows and views). The BrowserWindow's own webContents is
// the shell (the app UI: sandboxed, context-isolated, its own `shell` session, loaded from app://shell/ and
// never navigating). The deck view is a WebContentsView inside a clipping container View over the shell's
// content area: sandboxed, context-isolated, no Node, webSecurity on, in the document's own partition (9.9
// Always), with the deck preload. Main owns the layout numbers (layout.ts: the bars; views.ts: the deck view's
// place and zoom) and sends them to the shell.
//
// Deck messages arrive through the IPC guard (channels.ts): the document is the one this view was
// registered for. Trust changes (Allow network, Enable editing) come only from the shell (9.1 Shell view).
//
// Phase 1 wiring (views): the deck and document views (Fit, 100%, Fill width, Reading Width; views.ts), Present
// (present.ts), the rail's thumbnails and outline and Find (render products: slide-index.ts, thumbnails.ts,
// find.ts), Save as PDF and Print (pdf.ts, print.ts), the watcher and the reload in place (watcher.ts,
// view-state.ts), trust memory (trust-store.ts) and the Trust settings in the deck policies (folders.ts).

import {
  BrowserWindow,
  Menu,
  View,
  WebContentsView,
  dialog,
  nativeTheme,
  screen,
  session,
  type Input,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from 'electron';
import * as path from 'node:path';
import {
  MainToDeck,
  MainToShell,
  ShellToMain,
  type AppMode,
  type AppModeUpdate,
  type Capabilities,
  type DeckInit,
  type NotesUpdate,
  type ShellLayout,
  type ShellMenu,
  type ShellState,
  type SlideState,
} from '@blueline/core/ipc';
import { MainToDeckFiles, RELOAD_DEFERRED_TEXT, fileGoneText, type DeckBusy, type DeckViewState } from '@blueline/core/ipc-files';
import { RenderShellChannels, type FindResponse, type ShellIndexReady, type ShellThumb, type SlideIndex } from '@blueline/core/ipc-render';
import { PROTECTED_VIEW_HELP, protectedViewHelpText } from '@blueline/core/ipc-trust';
import {
  MainToDeckViews,
  MainToShellViews,
  ViewsShellToMain,
  type DesignReport,
  type GotoRequest,
  type PanAxes,
  type ShellCommand,
  type ShellIndex,
  type ViewKind,
  type ZoomMode,
} from '@blueline/core/ipc-views';
import { DEFAULT_DESIGN } from '@blueline/core/slides';
import { toClientMap } from '@blueline/core/mapper';
import type { Person } from '@blueline/core/types';
import { revealLabel, type AppAction } from './actions';
import { attachDeckView, shellRouter } from './channels';
import { matchAppChord, SwallowedKeys } from './chords';
import type { BlDocument, DocumentRegistry } from './documents';
import { DROP_REFUSED_TEXT, RefusedDropNotice } from './drop';
import { findOnSlide, findResponse, highlightMatch, hitFor, validateFindArgs, validateFindShowArgs } from './find';
import { validateNoArgs, validateSetMode, type ArgsValidator, type ShellSender } from './ipc-guard';
import { LEFT_RAIL_WIDTH, computeLayout, deckBounds } from './layout';
import { DEFAULT_ALLOWLIST } from './network-policy';
import { NotesStore } from './notes';
import { defaultPdfPath, saveAsPdf } from './pdf';
import { Present } from './present';
import { printDocument } from './print';
import { DECK_SCHEME, MEDIA_SCHEME, deckUrl, installDeckProtocol, installShellProtocol, SHELL_ORIGIN } from './protocol';
import { MotionEmulation, readsMotionInScript, wantsReducedMotion } from './motion';
import {
  RenderCancelled,
  acceleratorKeyFor,
  disposeRenderer,
  noteDocumentWrite,
  renderTargetFor,
  type RenderTarget,
} from './render-service';
import { learnDeckNav, type SaveEvent, type SessionStore } from './session-store';
import { buildSlideIndex, cachedSlideIndex } from './slide-index';
import { cancelThumbnails, renderThumbnails } from './thumbnails';
import {
  installDeckSessionPolicy,
  installDeckWebContentsPolicy,
  installShellPolicy,
  openExternalConfirmed,
  type BlockReason,
  type DeckSessionHandle,
  type DeckSessionPolicy,
  type DeckWebContentsHandle,
  type DeckWebContentsOptions,
} from './trust-hooks';
import { ReloadCoordinator, ViewStateRequests } from './view-state';
import {
  acceptDesignReport,
  computeViewLayout,
  maxReplayPresses,
  navPlanFor,
  railThumbWidth,
  safeDesign,
  shellIndexOf,
  stepTarget,
  thumbUrl,
  validateScrollArgs,
  validateShellCommand,
  validateShowEntry,
  viewKindOf,
  type ViewLayout,
} from './views';
import { watchDeck, type DeckWatcher } from './watcher';

/** How long a motion reload waits for a card the mode change closed to send its text. */
const MOTION_RELOAD_DELAY_MS = 250;
/** A reloaded page that never completes its handshake is given up after this long (the reload still happened). */
const RELOAD_HANDSHAKE_MS = 15_000;
/** 6.7 Index replay: after each key, how long the slide may take to move. */
const REPLAY_WAIT_MS = 1000;
/** 6.7 Index replay: presses that move nothing before the replay gives up (F25 patience: build steps move nothing). */
const REPLAY_PATIENCE = 4;
/** After a goto, how long the slide watcher may take to report the new slide. */
const GOTO_WAIT_MS = 1500;
/**
 * A page step (PageUp or PageDown the deck did not use) is taken only this soon after main saw that key reach the
 * deck view from the user, and a wheel pan only this soon after a wheel: the deck view's messages are written by
 * the page (9.1), and neither may make main press keys into it or move it on its own.
 */
const PAGE_STEP_WINDOW_MS = 2500;
const WHEEL_WINDOW_MS = 1000;

export const SHELL_PARTITION = 'shell';
export const SHELL_URL = `${SHELL_ORIGIN}/index.html`;
export const BANNER_LEFT = 'This page tried to leave the document';
/** Notes in ShellState carry at most this much text: the panel shows a summary, the card the full note. */
const SHELL_NOTE_TEXT = 500;

export interface AppPaths {
  /** dist/preload-shell.cjs */
  preloadShell: string;
  /** dist/preload-deck.cjs */
  preloadDeck: string;
  /** dist/shell */
  shellDir: string;
}

export interface DocWindowDeps {
  doc: BlDocument;
  registry: DocumentRegistry;
  session: SessionStore;
  capabilities: Capabilities;
  paths: AppPaths;
  /** BLUELINE_TEST=1: deck views get --bl-test=1 (the security suite's forged-payload hook). */
  test: boolean;
  devTools: boolean;
  /** Closed loopback port for the Protected proxy (pickClosedLoopbackPort, once per launch). */
  blockPort: number;
  platform: NodeJS.Platform;
  person(): Person;
  runAction(action: AppAction, w: DocWindow): void;
  openLocalHtml(realpath: string, o: { protected: boolean }): void;
  openInBrowser(realpath: string): Promise<void>;
  reveal(realpath: string): void;
  closed(w: DocWindow): void;
  log(msg: string): void;
  /** Added by views: trust.json (6.10 Remembered: the trust bar's switches, per realpath and marker). */
  rememberTrust?(realpath: string, marker: string | null, change: { allowNetwork?: boolean; editing?: boolean }): Promise<void>;
  /** Added by views: Settings › Trust in the deck policies (9.9: the strict option, the user-edited allowlist). */
  trustSettings?: { strict(): boolean; allowlist(): readonly string[] };
  /** Added by views: View › Hide Slides, remembered for every window (config.json). */
  prefs?: { railHidden(): boolean; setRailHidden(hidden: boolean): void };
  /** Added by views: the window's view settings changed (the app menu's checks and enabled items follow). */
  onViewChange?(w: DocWindow): void;
  /** Added by views: a mode change (the first-run tour ticks its steps in the sample deck's window). */
  onModeChange?(w: DocWindow, mode: AppMode): void;
  /** Added by views: Settings › Trust from the trust bar's overflow. */
  openSettings?(pane: 'general' | 'trust'): void;
}

let shellProtocolInstalled = false;
let shellChannelsDeclared = false;
const windowsByKey = new Map<string, DocWindow>();

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** popupMenu(menu, x, y): a known menu and a point in the shell's CSS pixels. */
const validatePopupMenu: ArgsValidator<{ menu: ShellMenu; x: number; y: number }> = (args) => {
  if (args.length !== 3) return { ok: false, why: 'three arguments' };
  const [menu, x, y] = args;
  if (menu !== 'file' && menu !== 'share' && menu !== 'trust-overflow') return { ok: false, why: 'menu' };
  const okNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100_000;
  if (!okNum(x) || !okNum(y)) return { ok: false, why: 'point' };
  return { ok: true, value: { menu, x: Math.round(x as number), y: Math.round(y as number) } };
};

/** The AppAction a shell command runs (the toolbar's and Find bar's buttons are the menu's items). */
const COMMAND_ACTION: Readonly<Record<ShellCommand, AppAction>> = Object.freeze({
  present: 'present',
  'save-pdf': 'save-pdf',
  print: 'print',
  find: 'find',
  'zoom-fit': 'zoom-fit',
  'zoom-actual': 'zoom-actual',
  'zoom-fill': 'zoom-fill',
  'reading-width': 'reading-width',
  'toggle-rail': 'toggle-rail',
  'about-protected': 'about-protected',
});

/**
 * Declares the shell channels app-shell and views own, once. Each call is routed to the window whose shell sent
 * it (ShellIpc checks the sender: a registered shell webContents, its main frame, origin app://shell).
 */
function declareShellChannels(): void {
  if (shellChannelsDeclared) return;
  shellChannelsDeclared = true;
  const r = shellRouter();
  const win = (from: ShellSender): DocWindow => {
    const w = windowsByKey.get(from.windowKey);
    if (!w || w.win.webContents.id !== from.webContentsId) throw new Error('Refused');
    return w;
  };
  r.handle(ShellToMain.getState, validateNoArgs, (from) => win(from).state());
  r.handle(ShellToMain.setMode, validateSetMode, (from, mode) => {
    const w = win(from);
    w.setMode(mode);
    w.focusDeck();
  });
  r.handle(ShellToMain.allowNetwork, validateNoArgs, (from) => win(from).allowNetwork());
  r.handle(ShellToMain.enableEditing, validateNoArgs, (from) => {
    const w = win(from);
    w.enableEditing();
    w.focusDeck();
  });
  r.handle(ShellToMain.dismissTrustBar, validateNoArgs, (from) => {
    const w = win(from);
    w.dismissTrustBar();
    w.focusDeck();
  });
  r.handle(ShellToMain.openInBrowser, validateNoArgs, (from) => win(from).runAction('open-in-browser'));
  r.handle(ShellToMain.revealFile, validateNoArgs, (from) => win(from).runAction('reveal'));
  r.handle(ShellToMain.dismissBanner, validateNoArgs, (from) => {
    const w = win(from);
    w.dismissBanner();
    w.focusDeck();
  });
  r.handle(ShellToMain.popupMenu, validatePopupMenu, (from, p) => {
    win(from).popupMenu(p.menu, p.x, p.y);
  });
  // views (6.9): the toolbar's and Find bar's commands, the rail, the scroll bars, Find.
  r.handle(ViewsShellToMain.command, validateShellCommand, (from, cmd) => win(from).runAction(COMMAND_ACTION[cmd]));
  r.handle(ViewsShellToMain.show, validateShowEntry, (from, entry) => win(from).showEntry(entry, { focus: true }));
  r.handle(ViewsShellToMain.scroll, validateScrollArgs, (from, p) => win(from).scrollTo(p.x, p.y, false));
  r.handle(ViewsShellToMain.findClosed, validateNoArgs, (from) => win(from).closeFind());
  r.handle(RenderShellChannels.find, validateFindArgs, (from, query) => win(from).find(query));
  r.handle(RenderShellChannels.findShow, validateFindShowArgs, (from, p) => win(from).findShow(p.slide, p.matchIndex));
}

/** The window of a shell sender's key, for other modules (tests, the Diagnostics window, the thumbnails route). */
export function docWindowByKey(key: string): DocWindow | undefined {
  return windowsByKey.get(key);
}

// ------------------------------------------------------------------------------------------- partition policy

/**
 * What the deck partition's and the deck view's policy callbacks may reach (finding 21). Electron keeps a
 * partition's Session, and every handler and listener set on it, for the life of the process (and the trust
 * hooks keep a handle per Session), so a callback that reached the BlDocument or the DocWindow kept each closed
 * window's document (its bytes, served copies and map) in memory for good. The callbacks are built by
 * deckPolicies below, which closes over this object only; the window sets `live` to null when it closes, and
 * every getter then fails closed: Protected, network not allowed, nothing opened, shown or logged.
 */
interface DeckPolicyState {
  live: {
    doc: BlDocument;
    /** Settings › Trust (9.9): the strict option and the CDN allowlist, read live (folders.ts TrustSettings). */
    strict(): boolean;
    allowlist(): readonly string[];
    toast(text: string, kind: 'info' | 'warn' | 'error'): void;
    confirmExternal(url: string): void;
    openLocalHtml(realpath: string, o: { protected: boolean }): void;
    onBlocked(url: string, why: BlockReason): void;
    log(msg: string): void;
  } | null;
}

/** The session policy (9.9 Always, Network policy) and view policy of one document window, over `state` only. */
function deckPolicies(
  state: DeckPolicyState,
  o: { docId: string; folderReal: string; blockPort: number; test: boolean },
): { session: DeckSessionPolicy; view: DeckWebContentsOptions } {
  const { docId, folderReal, blockPort, test } = o;
  return {
    session: {
      trust: () => state.live?.doc.trust() ?? 'protected',
      networkAllowed: () => state.live?.doc.networkAllowed() ?? false,
      // 6.10 "Block all network in Protected view"; closed: strict (fail closed).
      strict: () => (state.live ? state.live.strict() : true),
      // 9.9: user-editable in Settings › Trust; closed: nothing allowed.
      allowlist: () => (state.live ? state.live.allowlist() : []),
      blockPort,
      sourcePath: () => state.live?.doc.realpath ?? null,
      onDownloadBlocked: () => state.live?.toast('Downloads are blocked in Protected view.', 'warn'),
      onRequest: test
        ? (d, dec) => {
            if (dec.cancel) state.live?.log(`request cancelled (${dec.reason}) ${d.resourceType} ${d.url.slice(0, 200)}`);
          }
        : undefined,
    },
    view: {
      docId,
      folderReal,
      isProtected: () => (state.live ? state.live.doc.trust() === 'protected' : true),
      networkOpen: () => (state.live ? state.live.doc.trust() === 'trusted' || state.live.doc.networkAllowed() : false),
      onUserLink: (url) => state.live?.confirmExternal(url),
      openLocalHtml: (realpath, opts) => state.live?.openLocalHtml(realpath, opts),
      onBlocked: (url, why) => state.live?.onBlocked(url, why),
      onSubframeBlocked: (url) => {
        if (test) state.live?.log(`subframe navigation blocked: ${url.slice(0, 200)}`);
      },
    },
  };
}

// Capture-free handlers for a closed Protected partition (finding 21): they hold nothing, and refuse everything.
// The request listener lets only Blueline's own deck schemes through: their handlers are removed with the
// partition, so nothing serves them there and nothing leaves; the security suite still loads its own probe
// page there to check that the storage was cleared (test/security/storage.spec.ts).
const RETIRED_PASS = [`${DECK_SCHEME}:`, `${MEDIA_SCHEME}:`];
const cancelEveryRequest = (d: { url: string }, callback: (r: { cancel: boolean }) => void): void =>
  callback({ cancel: !RETIRED_PASS.some((scheme) => d.url.startsWith(scheme)) });
const denyPermissionRequest = (_wc: unknown, _p: unknown, callback: (granted: boolean) => void): void => callback(false);
const denyCheck = (): boolean => false;
const refusePairing = (_d: unknown, callback: (r: { confirmed: boolean }) => void): void => callback({ confirmed: false });
const cancelEvent = (event: Electron.Event): void => event.preventDefault();
const cancelHid = (event: Electron.Event, _d: unknown, callback: (deviceId?: string | null) => void): void => {
  event.preventDefault();
  callback();
};
const cancelSerial = (event: Electron.Event, _ports: unknown, _wc: unknown, callback: (portId: string) => void): void => {
  event.preventDefault();
  callback('');
};
const cancelUsb = (event: Electron.Event, _d: unknown, callback: (deviceId?: string) => void): void => {
  event.preventDefault();
  callback();
};

/**
 * A closed Protected window's partition is never used again (a new open gets a new docId and partition, 9.1),
 * but Electron keeps its Session, and its handlers, until the app quits. Replace them with the capture-free
 * ones above, so they keep no closure of the window alive, and anything that still ran there is refused.
 */
function retireProtectedPartition(ses: Session): void {
  ses.webRequest.onBeforeRequest(cancelEveryRequest);
  ses.setPermissionRequestHandler(denyPermissionRequest);
  ses.setPermissionCheckHandler(denyCheck);
  ses.setDevicePermissionHandler(denyCheck);
  if (typeof ses.setBluetoothPairingHandler === 'function') {
    try {
      ses.setBluetoothPairingHandler(refusePairing);
    } catch {
      // not supported on this platform
    }
  }
  ses.on('will-download', cancelEvent);
  ses.on('select-hid-device', cancelHid);
  ses.on('select-serial-port', cancelSerial);
  ses.on('select-usb-device', cancelUsb);
}

/** Disposes policy handles once the deck view is gone (they guard it until then). Holds only its arguments. */
function disposeWhenGone(wc: WebContents | undefined, handles: ({ dispose(): void } | null)[]): void {
  const run = () => {
    for (const h of handles) {
      try {
        h?.dispose();
      } catch {
        // already gone
      }
    }
  };
  if (!wc || wc.isDestroyed()) run();
  else wc.once('destroyed', run);
}

/** One running build of the slide index, for one document version. */
interface IndexJob {
  version: string;
  controller: AbortController;
}

export class DocWindow {
  readonly win: BrowserWindow;
  /** The clipping container over the content area (views.ts); the deck view is its only child. */
  readonly slot: View;
  readonly deck: WebContentsView;
  readonly doc: BlDocument;
  readonly notes: NotesStore;
  private mode: AppMode = 'read';
  private trustBarDismissed = false;
  /** The page tried to leave the document (9.9); shown until dismissed. */
  private leftDocument = false;
  /** The read-only notice of a deck that is not UTF-8 (9.2 rule 1) was dismissed. */
  private readOnlyDismissed = false;
  private slides: SlideState | null = null;
  /** The deck preload reports a text field focused (6.2: Cmd+Z goes to native undo there). */
  private textField = false;
  private saveState = '';
  private layoutNow: ShellLayout;
  private readonly swallowed = new SwallowedKeys();
  private readonly deckSession: Session;
  /** What the partition's and view's policy callbacks reach; cleared when the window closes (finding 21). */
  private readonly policyState: DeckPolicyState;
  private readonly policies: { session: DeckSessionPolicy; view: DeckWebContentsOptions };
  private sessionPolicy: DeckSessionHandle | null = null;
  private webPolicy: DeckWebContentsHandle | null = null;
  /** Resolves when the window has closed and released its document (the controller waits for it on a reopen). */
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private linkDialogOpen = false;
  private closedOnce = false;
  private deckCloseRequested = false;
  /** How many times the deck preload completed the handshake (ready → init), for tests and logs. */
  private inits = 0;
  /** Waiters for the next handshake (a reload resolves when the new page has its init). */
  private initWaiters: (() => void)[] = [];

  // ----- views (6.9)
  private zoomMode: ZoomMode = 'fit';
  private readingWidth: boolean;
  /** The design size: from the slide index, else what the visible view measured at 1600×900 (views.ts). */
  private design: { w: number; h: number } | null = null;
  private designFromIndex = false;
  /** The scroll bars' position (DIP of the deck view), when it is larger than the window. */
  private scroll = { x: 0, y: 0 };
  private viewNow: ViewLayout | null = null;
  private zoomApplied = 0;
  private panNow = '';
  private findOpen = false;
  private findQuery = '';
  readonly present: Present;
  /** Waiters for the next SlideState (navigation waits for the slide it asked for). */
  private slideWaiters: ((s: SlideState) => void)[] = [];
  /** The navigation running now; a newer one stops it. */
  private navToken = 0;
  /** After a reload of an index deck: the slide to replay keys to once the new page reports its slides. */
  private restoreSlide: number | null = null;
  /** Replays running (replayKeys): while any is, the keys main presses are not the user's. */
  private replaying = 0;
  /** The user's last PageUp/PageDown into the deck view, and last wheel (see PAGE_STEP_WINDOW_MS). */
  private lastPageKey: { dir: 1 | -1; at: number } | null = null;
  private lastWheelAt = 0;

  // ----- render products (6.7, 6.9)
  private indexJob: IndexJob | null = null;
  private index: SlideIndex | null = null;
  private indexBuilding = false;
  /** Thumbnails of the current version: slide → its app://shell/thumbs/ message (replayed to a reloaded shell). */
  private thumbs = new Map<number, ShellThumb>();
  private task: string | null = null;

  // ----- watcher and reload (9.2 Watcher, 6.6)
  private watcher: DeckWatcher | null = null;
  private readonly viewRequests: ViewStateRequests;
  private readonly reload: ReloadCoordinator;
  private reloadDeferred = false;
  /** Reloads of the deck view run one at a time (a file change, Allow network, reduced motion). */
  private reloadChain: Promise<void> = Promise.resolve();
  private readonly refusedDrops = new RefusedDropNotice();
  /** What the render products' callbacks reach (renderTarget, startProducts); cleared when the window closes. */
  private readonly productsLive: { win: DocWindow | null } = { win: null };

  private constructor(private readonly deps: DocWindowDeps) {
    const doc = deps.doc;
    this.doc = doc;
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.readingWidth = deps.session.session.settings?.readingWidth === true;
    this.productsLive.win = this;
    this.policyState = {
      live: {
        doc,
        strict: () => deps.trustSettings?.strict() ?? false,
        allowlist: () => deps.trustSettings?.allowlist() ?? DEFAULT_ALLOWLIST,
        toast: (text, kind) => this.toast(text, kind),
        confirmExternal: (url) => this.confirmExternal(url),
        openLocalHtml: (realpath, o) => deps.openLocalHtml(realpath, o),
        onBlocked: (url, why) => this.onBlocked(url, why),
        log: (msg) => deps.log(msg),
      },
    };
    this.policies = deckPolicies(this.policyState, { docId: doc.docId, folderReal: doc.folderReal, blockPort: deps.blockPort, test: deps.test });
    this.notes = new NotesStore(deps.session.session, {
      me: () => deps.person(),
      now: () => new Date().toISOString(),
      version: () => doc.version,
      slides: () => this.slides,
    });

    const shellSession = session.fromPartition(SHELL_PARTITION);
    if (!shellProtocolInstalled) {
      if (!shellSession.protocol.isProtocolHandled('app')) installShellProtocol(shellSession, deps.paths.shellDir);
      shellProtocolInstalled = true;
    }
    declareShellChannels();

    this.win = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 640,
      minHeight: 420,
      show: false,
      title: doc.fileName,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f2024' : '#f5f6f8',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: SHELL_PARTITION,
        preload: deps.paths.preloadShell,
        spellcheck: false,
        devTools: deps.devTools,
        navigateOnDragDrop: false,
      },
    });
    const shellWc = this.win.webContents;
    installShellPolicy(shellSession, shellWc);
    shellRouter().registerShell(shellWc, { windowKey: doc.docId });
    windowsByKey.set(doc.docId, this);
    if (deps.platform === 'darwin') this.win.setRepresentedFilename(doc.realpath);
    // The window title is the file name, never the shell page's <title>.
    this.win.on('page-title-updated', (e) => e.preventDefault());
    this.win.once('ready-to-show', () => this.win.show());
    shellWc.on('did-finish-load', () => this.onShellLoaded());
    // 6.4: a click on the toolbar or the notes panel closes the open card. While presenting, the keyboard goes
    // back to the deck (6.9: every key goes to the deck; a click on the letterbox focuses the shell).
    shellWc.on('focus', () => {
      this.sendDeck(MainToDeck.closeCard);
      if (this.present.active) this.focusDeck();
    });
    // 6.9 Present: Esc ends it wherever the keyboard is (the shell has it after a click on the letterbox).
    shellWc.on('before-input-event', (event, input) => {
      if (this.present.active && this.present.onInput(input)) event.preventDefault();
    });

    // The deck view, in the document's own partition (9.1, 9.9 Always), inside the clipping container (views.ts).
    this.deckSession = session.fromPartition(doc.partition);
    installDeckProtocol(this.deckSession, deps.registry.lookupFor(doc.partition));
    this.slot = new View();
    this.deck = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: doc.partition,
        preload: deps.paths.preloadDeck,
        additionalArguments: ['--bl-mode=deck', ...(deps.test ? ['--bl-test=1'] : [])],
        devTools: deps.devTools,
        navigateOnDragDrop: false,
        safeDialogs: true,
        webviewTag: false,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        // 6.9 Fit: this view's zoom is its own. With Chromium's per-host default it reached the document's
        // offscreen render views, which share the partition and the host (Phase 1 finding).
        zoomMode: 'isolated',
      },
    });
    this.slot.addChildView(this.deck);
    this.win.contentView.addChildView(this.slot);
    const deckWc = this.deck.webContents;
    // Registered before anything loads (9.1: main accepts deck channels only from views it created).
    attachDeckView(deckWc, { docId: doc.docId, kind: 'deck' }, {
      ready: () => this.sendInit(),
      focus: (_f, p) => {
        this.textField = p.textField;
      },
      link: (_f, p) => this.webPolicy?.noteLinkClick(p.href),
      slides: (_f, p) => this.onSlides(p),
      mode: (_f, p) => {
        if (p.mode === 'read') this.setMode('read');
      },
      note: (_f, op) => this.onNoteOp(op),
      viewState: (_f, p) => this.viewRequests.onReply(p),
      busy: (_f, p) => this.onBusy(p),
      dropRefused: () => {
        if (this.refusedDrops.take()) this.toast(DROP_REFUSED_TEXT, 'info');
      },
      design: (_f, p) => this.onDesign(p),
      pageStep: (_f, p) => this.onPageStep(p.dir),
      wheel: (_f, p) => this.onWheel(p.dx, p.dy),
    });
    this.webPolicy = installDeckWebContentsPolicy(deckWc, this.policies.view);
    deckWc.on('before-input-event', (event, input) => this.onDeckInput(event, input));
    deckWc.on('input-event', (_e, ev) => {
      if (ev.type === 'mouseWheel') this.lastWheelAt = Date.now();
    });
    deckWc.on('render-process-gone', (_e, details) => {
      deps.log(`deck renderer gone (${details.reason}) for ${doc.fileName}`);
      // The page went away: it holds no edit and no card now, so a deferred reload may go ahead (6.6).
      this.reload.resetBusy();
      if (details.reason !== 'clean-exit') this.toast('The document stopped working. Close it and open it again.', 'error');
    });
    deckWc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.toast(`${doc.fileName} could not be shown (${desc}).`, 'error');
    });
    deckWc.on('did-navigate', () => this.applyZoom(true));
    deckWc.on('did-finish-load', () => {
      if (this.win.isFocused()) deckWc.focus();
      this.onDeckLoaded();
    });
    if (deps.test) {
      deckWc.on('console-message', (e) => deps.log(`deck console [${e.level}] ${String(e.message).slice(0, 500)}`));
    }

    this.viewRequests = new ViewStateRequests((q) => this.sendDeck(MainToDeckFiles.captureViewState, q));
    this.reload = new ReloadCoordinator(
      {
        capture: () => this.viewRequests.capture(),
        reload: (_version, state) => this.chainReload(() => this.reloadDeck(state?.hash ?? '')),
        apply: (state) => this.applyViewState(state),
        onDeferred: (on) => {
          this.reloadDeferred = on;
          this.pushState();
        },
        log: (m) => deps.log(m),
      },
      { version: doc.version },
    );

    this.present = new Present({
      isFullScreen: () => !this.win.isDestroyed() && this.win.isFullScreen(),
      setFullScreen: (on) => {
        if (!this.win.isDestroyed()) this.win.setFullScreen(on);
      },
      appMode: () => this.mode,
      setMode: (m) => this.setMode(m),
      relayout: () => this.relayout(true),
      focusDeck: () => this.focusDeck(),
      onChange: () => {
        this.pushState();
        this.viewChanged();
      },
    });
    this.win.on('enter-full-screen', () => this.present.onEnterFullScreen());
    this.win.on('leave-full-screen', () => this.present.onLeaveFullScreen());

    this.layoutNow = this.computeLayout();
    this.win.on('resize', () => this.relayout());
    // The content area also changes without a resize: on Linux and Windows the menu bar is attached after
    // the window is created, which shortens it (Phase 0 finding).
    this.win.contentView.on('bounds-changed', () => this.relayout());
    this.win.on('show', () => this.relayout());
    this.win.on('focus', () => deps.onViewChange?.(this));
    // The deck view closes with its window, in 'close' (see closeDeck); nothing may prevent 'close' after
    // this listener (a later "keep editing?" prompt must be registered before it and decide first).
    this.win.on('close', () => this.closeDeck());
    this.win.on('closed', () => this.onClosed());
  }

  /**
   * Creates the window, loads the shell, applies the partition's policy, and only then starts loading the
   * deck. Resolves once the deck load has started: a slow page must not hold up other opens.
   */
  static async create(deps: DocWindowDeps): Promise<DocWindow> {
    const w = new DocWindow(deps);
    w.relayout(true);
    void w.win.webContents.loadURL(SHELL_URL).catch((e) => deps.log(`shell failed to load: ${String(e)}`));
    await w.startDeck();
    return w;
  }

  private async startDeck(): Promise<void> {
    // The window closed before its policy was installed (a close during create): nothing to load.
    if (this.closing) return;
    // Callbacks built over policyState only (deckPolicies; finding 21).
    this.sessionPolicy = installDeckSessionPolicy(this.deckSession, this.policies.session);
    try {
      // 9.9: the Protected proxy must be in place and verified before the deck loads.
      await this.sessionPolicy.ready;
    } catch (e) {
      this.deps.log(`deck policy failed: ${errText(e)}`);
      this.toast('Protected view could not block the network, so the document was not loaded.', 'error');
      return;
    }
    // Closed while the proxy was set up: the deck view is gone (its webContents reads as undefined then).
    if (this.closing || !this.liveDeck()) return;
    void this.loadDeck();
  }

  /**
   * The deck view's webContents while it is alive, else null. Electron 44 types it as always present, but once
   * the view's webContents is destroyed (closeDeck, in the window's 'close') it reads as undefined.
   */
  private liveDeck(): WebContents | null {
    const wc = this.deck.webContents as WebContents | undefined;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  /**
   * The window is closing or closed: its deck view was closed in 'close' (closeDeck), or it is gone. The
   * controller lists and returns only windows that are not (finding 23).
   */
  get closing(): boolean {
    return this.deckCloseRequested || this.closedOnce || this.win.isDestroyed();
  }

  /** Open, and its deck view alive: what the controller lists (all(), focused(), the test hooks). */
  usable(): boolean {
    return !this.closing && this.liveDeck() !== null;
  }

  /** Reduced motion in Review and Edit (motion.ts). */
  private readonly motion = new MotionEmulation(
    () => this.liveDeck(),
    (m) => this.deps.log(m),
  );

  /**
   * Sets the deck view's motion for a mode and, when the deck reads the setting in a script, reloads it with
   * its view state (6.6). The wait lets a card the mode change closed send its text first (6.5: a reload never
   * loses a draft).
   */
  private async applyMotion(mode: AppMode): Promise<void> {
    const reduce = wantsReducedMotion(mode);
    if (reduce === this.motion.isReduced) return;
    if (!(await this.motion.set(reduce)) || this.closing) return;
    if (!readsMotionInScript(this.doc.decoded.src, this.doc.map)) return;
    await new Promise((r) => setTimeout(r, MOTION_RELOAD_DELAY_MS));
    if (this.closing || this.mode !== mode) return;
    await this.reloadInPlace('reduced motion');
  }

  private async loadDeck(hash = ''): Promise<void> {
    const wc = this.liveDeck();
    if (!wc) return;
    try {
      await wc.loadURL(deckUrl(this.doc.docId, this.doc.fileName) + hash);
    } catch (e) {
      // did-fail-load reports it; an aborted load (a reload replacing it) is not an error.
      this.deps.log(`deck load: ${errText(e)}`);
    }
  }

  get appMode(): AppMode {
    return this.mode;
  }

  // ------------------------------------------------------------------------------------------- deck → main

  private sendDeck(channel: string, payload?: unknown): void {
    this.liveDeck()?.send(channel, payload);
  }

  private sendShell(channel: string, payload?: unknown): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  private sendInit(): void {
    const doc = this.doc;
    const init: DeckInit = {
      mode: 'deck',
      appMode: this.mode,
      trust: doc.trust(),
      capabilities: { ...this.deps.capabilities },
      editingAllowed: doc.editable(),
      // MapUpdate: null for a deck that is not UTF-8 (every node is `none`, 9.2 rule 1).
      map: doc.utf8 ? toClientMap(doc.map) : null,
      notes: this.notes.notes.slice(),
      userName: this.deps.person().name,
    };
    this.sendDeck(MainToDeck.init, init);
    this.inits++;
    // A new page has its own pan state (100%, Fill width).
    this.panNow = '';
    this.applyPan();
    for (const w of this.initWaiters.splice(0)) w();
  }

  get handshakes(): number {
    return this.inits;
  }

  /** <userData>/files/<fileKey>/session.json of this document. */
  get sessionFile(): string {
    return this.deps.session.file;
  }

  private onSlides(p: SlideState): void {
    const before = this.slides;
    this.slides = p;
    // 6.7 Index replay: the keys that moved this deck, kept as Session.deckNav. The guard checked them
    // (ipc-guard DECK_NAV_KEYS); forward is stored as soon as it is known, back defaulting (learnDeckNav).
    const s = this.deps.session.session;
    const nav = learnDeckNav(s.deckNav, p.deckNav);
    if (nav) {
      s.deckNav = nav;
      this.save();
      // An index the default keys could not complete may reach every slide with the keys the deck uses.
      if (this.index && !this.index.complete && this.index.version === this.doc.version) this.startProducts(true);
    }
    if (!before || viewKindOf(before.kind) !== viewKindOf(p.kind)) {
      this.relayout(true);
      this.viewChanged();
    }
    this.pushState();
    for (const w of this.slideWaiters.splice(0)) w(p);
    // 6.6: after a reload of an index deck, main's keys bring it back to its slide.
    if (this.restoreSlide !== null && p.navKind === 'index' && p.count > this.restoreSlide) {
      const target = this.restoreSlide;
      this.restoreSlide = null;
      if (p.current !== target) void this.replayKeys(target, ++this.navToken);
    }
  }

  private onNoteOp(op: Parameters<NotesStore['apply']>[0]): void {
    const r = this.notes.apply(op);
    if (!r.ok && this.deps.test) this.deps.log(`note op refused: ${op.op} (${r.why})`);
    if (r.ok) this.save();
    // Refused or not, the view gets the notes as main holds them, so the overlay resyncs.
    const update: NotesUpdate = { notes: this.notes.notes.slice() };
    if (r.ok && r.created) update.created = [r.created];
    this.sendDeck(MainToDeck.notes, update);
    this.pushState();
  }

  private save(): void {
    this.saveState = 'Saving…';
    void this.deps.session.save();
  }

  /** SessionStore results (wired by the controller). */
  onSaved(e: SaveEvent): void {
    this.saveState = e.state === 'saved' ? `Saved · ${formatTime(e.at)}` : 'Not saved';
    if (e.state === 'error') {
      this.deps.log(`session.json not saved: ${e.error.message}`);
      this.toast(`Notes could not be saved: ${e.error.message}`, 'error');
    }
    this.pushState();
  }

  /**
   * 6.2: exactly an app chord → hidden from the page and the menu, and run here. While presenting (6.9), every
   * key but Esc goes to the deck: no chord is taken, and Esc ends Present.
   */
  private onDeckInput(event: Electron.Event, input: Input): void {
    if (this.swallowed.takeKeyUp(input)) {
      event.preventDefault();
      return;
    }
    if (input.type === 'keyDown' && this.replaying === 0 && !input.control && !input.meta && !input.alt && !input.shift && (input.key === 'PageDown' || input.key === 'PageUp')) {
      this.lastPageKey = { dir: input.key === 'PageDown' ? 1 : -1, at: Date.now() };
    }
    if (this.present.active) {
      if (this.present.onInput(input)) {
        event.preventDefault();
        this.swallowed.add(input.code);
      }
      return;
    }
    const action = matchAppChord(input, { textField: this.textField, platform: this.deps.platform });
    if (!action) return;
    event.preventDefault();
    this.swallowed.add(input.code);
    // A held chord is hidden from the page while it repeats, and runs once.
    if (input.isAutoRepeat) return;
    this.deps.runAction(action, this);
  }

  private onBlocked(url: string, why: BlockReason): void {
    if (this.deps.test) this.deps.log(`navigation blocked (${why}): ${url.slice(0, 200)}`);
    // 9.9: "a bar says 'This page tried to leave the document', with Open in Browser". The URL the page
    // tried is never offered; Open in Browser opens this document's own file.
    if (!this.leftDocument) {
      this.leftDocument = true;
      this.relayout();
    }
  }

  /** 9.9: a clicked http, https or mailto link opens outside after a dialog that shows the full URL. */
  private confirmExternal(url: string): void {
    if (this.linkDialogOpen || this.win.isDestroyed()) return;
    this.linkDialogOpen = true;
    void openExternalConfirmed(url, async (target) => {
      if (this.win.isDestroyed()) return false;
      const mail = target.toLowerCase().startsWith('mailto:');
      const r = await dialog.showMessageBox(this.win, {
        type: 'question',
        buttons: [mail ? 'Open in Mail' : 'Open in Browser', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: mail ? 'Open this email link in your mail app?' : 'Open this link in your browser?',
        detail: target,
      });
      return r.response === 0;
    })
      .catch((e) => this.deps.log(`openExternal: ${errText(e)}`))
      .finally(() => {
        this.linkDialogOpen = false;
      });
  }

  // ------------------------------------------------------------------------------------------- shell → main

  /** Runs an app action for this window (menu, chord or shell button). */
  runAction(action: AppAction): void {
    this.deps.runAction(action, this);
  }

  /**
   * Switches the app mode (6.2). Edit needs the Edit capability, a UTF-8 file (9.2 rule 1) and editing
   * allowed (6.10: in Protected view, Edit asks you to enable editing first). While presenting, the mode stays
   * Read (6.9: every key goes to the deck); Present itself switches it.
   */
  setMode(mode: AppMode): boolean {
    if (mode === 'edit') {
      if (!this.deps.capabilities.edit) {
        this.toast('Edit is not available in this version of Blueline.', 'warn');
        return false;
      }
      if (this.doc.readOnlyReason) {
        this.toast(this.doc.readOnlyReason, 'warn');
        return false;
      }
      if (this.doc.gone) {
        this.toast(fileGoneText(this.doc.fileName), 'warn');
        return false;
      }
      if (!this.doc.editingAllowed()) {
        this.trustBarDismissed = false;
        this.relayout();
        this.toast('This file is in Protected view. Click Enable editing to edit it.', 'warn');
        return false;
      }
    }
    if (mode === this.mode) return true;
    this.mode = mode;
    const update: AppModeUpdate = { appMode: mode, editingAllowed: this.doc.editable() };
    this.sendDeck(MainToDeck.appMode, update);
    this.relayout();
    this.pushState();
    this.viewChanged();
    void this.applyMotion(mode);
    try {
      this.deps.onModeChange?.(this, mode);
    } catch (e) {
      this.deps.log(`mode change hook: ${errText(e)}`);
    }
    return true;
  }

  /**
   * 6.10 Allow network: the Trusted network policy for this file, remembered in trust.json for this file and
   * marker. The deck reloads in place (its view state kept) so its headers change.
   */
  async allowNetwork(): Promise<void> {
    if (this.doc.trust() !== 'protected' || this.doc.networkAllowed()) return;
    this.doc.allowNetwork();
    this.remember({ allowNetwork: true });
    try {
      await this.sessionPolicy?.update();
    } catch (e) {
      this.deps.log(`proxy update failed: ${errText(e)}`);
    }
    this.pushState();
    // The served copy and its headers change (no connect-src 'none', resource hints kept): reload it.
    if (!this.closing) await this.reloadInPlace('allow network');
  }

  /** 6.10 Enable editing, remembered for this file and marker. Network keeps its current policy. */
  enableEditing(): void {
    if (this.doc.editingAllowed()) return;
    this.doc.enableEditing();
    this.remember({ editing: true });
    const update: AppModeUpdate = { appMode: this.mode, editingAllowed: this.doc.editable() };
    this.sendDeck(MainToDeck.appMode, update);
    this.pushState();
  }

  /**
   * 6.10 Remembered: "Trust is remembered in trust.json per realpath, together with the marker the decision was
   * made on." A file whose marker could not be read has nothing to remember a decision against: the switch
   * applies to this window only.
   */
  private remember(change: { allowNetwork?: boolean; editing?: boolean }): void {
    if (this.doc.markerUncertain || !this.deps.rememberTrust) return;
    void this.deps.rememberTrust(this.doc.realpath, this.doc.marker, change).catch((e) => this.deps.log(`trust.json not saved: ${errText(e)}`));
  }

  /** Settings › Trust changed (the strict option, the allowlist, folders): re-apply the partition's policy now. */
  async reapplyPolicy(): Promise<void> {
    try {
      await this.sessionPolicy?.update();
    } catch (e) {
      this.deps.log(`policy update failed: ${errText(e)}`);
    }
  }

  dismissTrustBar(): void {
    this.trustBarDismissed = true;
    this.relayout();
  }

  dismissBanner(): void {
    if (this.leftDocument) this.leftDocument = false;
    else if (!this.doc.gone) this.readOnlyDismissed = true;
    this.relayout();
  }

  /**
   * The bar under the toolbar: "This page tried to leave the document" (9.9) first, then a file that went away
   * (9.2 Watcher), else the banner of a deck that is not UTF-8 (9.2 rule 1: "a banner says 'deck.html is not
   * UTF-8; direct edits are off'"). Each offers Open in Browser.
   */
  private bannerText(): string | null {
    if (this.leftDocument) return BANNER_LEFT;
    if (this.doc.gone) return fileGoneText(this.doc.fileName);
    if (this.doc.readOnlyReason && !this.readOnlyDismissed) return this.doc.readOnlyReason;
    return null;
  }

  popupMenu(menu: ShellMenu, x: number, y: number): void {
    if (this.win.isDestroyed()) return;
    const items: MenuItemConstructorOptions[] = [];
    if (menu === 'file') {
      // 6.0 Toolbar: "The file name. Click it to see the path and Reveal in Finder."
      items.push({ label: this.doc.realpath, enabled: false });
      items.push({ label: this.doc.received ? 'Received file' : 'Your file', enabled: false });
      items.push({ type: 'separator' });
      items.push({ label: revealLabel(this.deps.platform), click: () => this.runAction('reveal') });
      items.push({ label: 'Open in Browser', click: () => this.runAction('open-in-browser') });
    } else if (menu === 'share') {
      // 6.0 Share: Save as PDF; Save a copy for review and Export clean copy are Phase 5.
      items.push({ label: 'Save as PDF…', click: () => this.runAction('save-pdf') });
      items.push({ label: 'Print…', click: () => this.runAction('print') });
      items.push({ type: 'separator' });
      items.push({ label: 'Save a copy for review', enabled: false, sublabel: 'Phase 5' });
      items.push({ label: 'Export clean copy', enabled: false, sublabel: 'Phase 5' });
    } else {
      // 6.1 Escape hatches: Open in Browser is always in the trust bar's overflow; 6.10's help and settings.
      items.push({ label: 'Open in Browser', click: () => this.runAction('open-in-browser') });
      items.push({ type: 'separator' });
      items.push({ label: 'About Protected View', click: () => this.runAction('about-protected') });
      if (this.deps.openSettings) items.push({ label: 'Trust Settings…', click: () => this.deps.openSettings?.('trust') });
    }
    Menu.buildFromTemplate(items).popup({ window: this.win, x, y });
  }

  /** 6.10: the Protected view help (core/ipc-trust.ts PROTECTED_VIEW_HELP), from the trust bar or Help. */
  aboutProtectedView(): void {
    const opts: Electron.MessageBoxOptions = {
      type: 'info',
      message: PROTECTED_VIEW_HELP.title,
      detail: protectedViewHelpText(),
      buttons: ['OK'],
      noLink: true,
    };
    const shown = this.win.isDestroyed() ? dialog.showMessageBox(opts) : dialog.showMessageBox(this.win, opts);
    void shown.catch(() => undefined);
  }

  // ------------------------------------------------------------------------------------------- views (6.9)

  /** The kind of view this document gets: what the visible view detected, else the index's, else unknown. */
  private viewKind(): ViewKind | null {
    return viewKindOf(this.slides?.kind) ?? (this.index && this.index.version === this.doc.version ? viewKindOf(this.index.kind) : null);
  }

  /** The current view settings, for the menu's checks and the test hooks. */
  viewInfo(): {
    kind: ViewKind | null;
    zoomMode: ZoomMode;
    zoom: number;
    readingWidth: boolean;
    railHidden: boolean;
    presenting: boolean;
    findOpen: boolean;
    design: { w: number; h: number };
    container: { x: number; y: number; width: number; height: number } | null;
    deck: { x: number; y: number; width: number; height: number } | null;
  } {
    const v = this.viewNow;
    return {
      kind: this.viewKind(),
      zoomMode: this.zoomMode,
      zoom: v?.zoom ?? 1,
      readingWidth: this.readingWidth,
      railHidden: this.railHidden(),
      presenting: this.present.active,
      findOpen: this.findOpen,
      design: safeDesign(this.design ?? DEFAULT_DESIGN),
      container: v ? { ...v.container } : null,
      deck: v ? { ...v.deck } : null,
    };
  }

  private railHidden(): boolean {
    return this.deps.prefs?.railHidden() ?? false;
  }

  private viewChanged(): void {
    try {
      this.deps.onViewChange?.(this);
    } catch (e) {
      this.deps.log(`view change hook: ${errText(e)}`);
    }
  }

  /** View › Fit, 100%, Fill width (decks only; 6.9). */
  setZoomMode(mode: ZoomMode): void {
    if (this.viewKind() === 'document') return;
    if (mode === this.zoomMode) return;
    this.zoomMode = mode;
    this.scroll = { x: 0, y: 0 };
    this.relayout(true);
    this.pushState();
    this.viewChanged();
  }

  /** View › Reading Width (documents; 6.9: off by default, remembered per file in session.json). */
  toggleReadingWidth(): void {
    if (this.viewKind() === 'deck') return;
    this.readingWidth = !this.readingWidth;
    const s = this.deps.session.session;
    s.settings = { ...(s.settings ?? {}), readingWidth: this.readingWidth };
    this.save();
    this.relayout(true);
    this.pushState();
    this.viewChanged();
  }

  /** The rail's visibility changed (View › Hide Slides, for every window). */
  railChanged(): void {
    this.relayout(true);
    this.pushState();
    this.viewChanged();
  }

  /** The design size the visible view measured (6.9; views.ts acceptDesignReport). The index's wins. */
  private onDesign(r: DesignReport): void {
    if (this.designFromIndex) return;
    const d = acceptDesignReport(r);
    if (!d || (this.design && this.design.w === d.w && this.design.h === d.h)) return;
    this.design = d;
    this.relayout(true);
    this.pushState();
  }

  private setIndexDesign(d: { w: number; h: number }): void {
    const s = safeDesign(d);
    this.designFromIndex = true;
    if (this.design && this.design.w === s.w && this.design.h === s.h) return;
    this.design = s;
    this.relayout(true);
    this.pushState();
  }

  /** The display's scale (views.ts snaps the deck view to whole device pixels). */
  private dpr(): number {
    try {
      return screen.getDisplayMatching(this.win.getBounds()).scaleFactor || 1;
    } catch {
      return 1;
    }
  }

  /** Applies the deck view's zoom factor (6.9 Fit; F5: setZoomFactor, never CSS zoom). */
  private applyZoom(force = false): void {
    const wc = this.liveDeck();
    const z = this.viewNow?.zoom ?? 1;
    if (!wc || (!force && z === this.zoomApplied)) return;
    try {
      wc.setZoomFactor(z);
      this.zoomApplied = z;
    } catch (e) {
      this.deps.log(`zoom: ${errText(e)}`);
    }
  }

  /** Tells the page whether an unused wheel pans its view (100%, Fill width). */
  private applyPan(): void {
    const v = this.viewNow;
    const p: PanAxes = { x: !!v?.scroll && v.scroll.width > v.container.width, y: !!v?.scroll && v.scroll.height > v.container.height };
    const key = `${p.x}:${p.y}`;
    if (key === this.panNow) return;
    this.panNow = key;
    this.sendDeck(MainToDeckViews.pan, p);
  }

  /** The shell's scroll bars moved (or main panned, `echo` to tell the shell): the deck view follows. */
  scrollTo(x: number, y: number, echo: boolean): void {
    this.scroll = { x: Math.max(0, x), y: Math.max(0, y) };
    this.placeDeck();
    const v = this.viewNow;
    if (echo && v?.scroll) this.sendShell(MainToShellViews.scrollTo, { x: v.scroll.x, y: v.scroll.y });
  }

  private onWheel(dx: number, dy: number): void {
    const v = this.viewNow;
    if (!v?.scroll || Date.now() - this.lastWheelAt > WHEEL_WINDOW_MS) return;
    // The page's CSS px are the view's DIP times the zoom.
    this.scrollTo(this.scroll.x + dx * v.zoom, this.scroll.y + dy * v.zoom, true);
  }

  private computeLayout(): ShellLayout {
    const [width, height] = this.win.isDestroyed() ? [0, 0] : this.win.getContentSize();
    return computeLayout({
      width,
      height,
      appMode: this.mode,
      trustBarVisible: this.trustBarVisible(),
      bannerVisible: this.bannerText() !== null,
      findBarVisible: this.findOpen,
      railHidden: this.railHidden(),
      presenting: this.present?.active === true,
    });
  }

  /** Places the container and the deck view, and sets the zoom (views.ts computeViewLayout). */
  private placeDeck(): void {
    if (this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    const area = deckBounds(this.layoutNow, { width, height });
    const v = computeViewLayout({
      area,
      kind: this.viewKind(),
      design: this.design ?? DEFAULT_DESIGN,
      zoomMode: this.zoomMode,
      readingWidth: this.readingWidth,
      presenting: this.present?.active === true,
      scroll: this.scroll,
      dpr: this.dpr(),
    });
    const prev = this.viewNow;
    this.viewNow = v;
    if (v.scroll) this.scroll = { x: v.scroll.x, y: v.scroll.y };
    this.slot.setBounds(v.container);
    this.deck.setBounds(v.deck);
    this.applyZoom();
    this.applyPan();
    const changed =
      !prev ||
      prev.zoom !== v.zoom ||
      JSON.stringify(prev.scroll && { w: prev.scroll.width, h: prev.scroll.height }) !== JSON.stringify(v.scroll && { w: v.scroll.width, h: v.scroll.height });
    if (changed) this.pushState();
  }

  private relayout(force = false): void {
    if (this.win.isDestroyed()) return;
    const layout = this.computeLayout();
    const changed = JSON.stringify(layout) !== JSON.stringify(this.layoutNow);
    this.layoutNow = layout;
    this.placeDeck();
    if (changed || force) this.pushState();
  }

  // ------------------------------------------------------------------------------------------- navigation (6.9)

  /**
   * Shows rail entry `entry` (6.9 Navigation): a deck slide through slide.nav, a document section's heading.
   * reveal.js, hash and scroll decks and documents navigate in the deck preload (views.ts navPlanFor); index
   * decks are replayed with the deck's own keys, as the render service replays them (6.7 Index replay).
   * Resolves true when the deck view shows the entry.
   */
  async showEntry(entry: number, o: { focus?: boolean } = {}): Promise<boolean> {
    const index = this.index && this.index.version === this.doc.version ? this.index : null;
    const plan = navPlanFor(entry, index, this.slides);
    if (!plan) return false;
    const token = ++this.navToken;
    if (o.focus) this.focusDeck();
    if ('keys' in plan) return await this.replayKeys(plan.keys, token);
    return await this.gotoAndWait(plan.goto, entry, token);
  }

  private async gotoAndWait(req: GotoRequest, entry: number, token: number): Promise<boolean> {
    this.sendDeck(MainToDeckViews.goto, req);
    // Documents: the heading is in view as soon as the preload scrolled; the slide model may not change.
    if (req.kind === 'heading' || req.kind === 'top' || this.viewKind() === 'document') return true;
    if (this.slides?.current === entry) return true;
    const end = Date.now() + GOTO_WAIT_MS;
    while (Date.now() < end && token === this.navToken) {
      const s = await this.nextSlides(end - Date.now());
      if (s && s.current === entry) return true;
    }
    return this.slides?.current === entry;
  }

  /** Resolves with the next SlideState report, or null after `ms`. */
  private nextSlides(ms: number): Promise<SlideState | null> {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => finish(null), Math.max(0, ms));
      const finish = (s: SlideState | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const i = this.slideWaiters.indexOf(waiter);
        if (i >= 0) this.slideWaiters.splice(i, 1);
        resolve(s);
      };
      const waiter = (s: SlideState) => finish(s);
      this.slideWaiters.push(waiter);
    });
  }

  /** One trusted key press on the deck view (keyDown, keyUp) with an Electron accelerator key name. */
  private press(domKey: string): boolean {
    const wc = this.liveDeck();
    const keyCode = acceleratorKeyFor(domKey);
    if (!wc || !keyCode) return false;
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
    return true;
  }

  /**
   * 6.7 Index replay on the visible view: presses the deck's forward or back key (Session.deckNav, else
   * ArrowRight and ArrowLeft) until it shows `target`, with patience for build steps (F25), and gives up after
   * REPLAY_PATIENCE presses that moved nothing. The key router treats the view as Read meanwhile (NavReplay).
   */
  private async replayKeys(target: number, token: number): Promise<boolean> {
    const start = this.slides?.current;
    if (start === undefined || start === null) return false;
    if (start === target) return true;
    const nav = this.deps.session.session.deckNav;
    const forward = nav?.forward ?? 'ArrowRight';
    const back = nav?.back ?? 'ArrowLeft';
    this.liveDeck()?.focus();
    this.replaying++;
    this.sendDeck(MainToDeckViews.navReplay, { active: true });
    try {
      let presses = 0;
      let idle = 0;
      const max = maxReplayPresses(target - start);
      while (token === this.navToken && !this.closing) {
        const cur = this.slides?.current ?? start;
        if (cur === target) return true;
        if (presses >= max || idle >= REPLAY_PATIENCE) return false;
        if (!this.press(cur < target ? forward : back)) return false;
        presses++;
        const s = await this.nextSlides(REPLAY_WAIT_MS);
        if (!s || s.current === cur) idle++;
        else idle = 0;
      }
      return this.slides?.current === target;
    } finally {
      // A newer replay (a second click) may still be pressing keys: the router stays in Read until the last ends.
      this.replaying--;
      if (this.replaying === 0) this.sendDeck(MainToDeckViews.navReplay, { active: false });
    }
  }

  /** PageUp / PageDown the deck did not use (6.9 Navigation): one slide back or forward. */
  private onPageStep(dir: 1 | -1): void {
    const k = this.lastPageKey;
    if (!k || k.dir !== dir || Date.now() - k.at > PAGE_STEP_WINDOW_MS) return;
    this.lastPageKey = null;
    const s = this.slides;
    if (!s || viewKindOf(s.kind) !== 'deck') return;
    const t = stepTarget(s.current, s.count, dir);
    if (t === null) return;
    void this.showEntry(t);
  }

  // ------------------------------------------------------------------------------------------- Find (6.9)

  /** Cmd+F: the Find bar opens (its results in the rail), with the caret in it. */
  openFind(): void {
    if (this.win.isDestroyed()) return;
    if (!this.findOpen) {
      this.findOpen = true;
      this.relayout(true);
      this.viewChanged();
    }
    // The index is built on the first Find (it usually is already: thumbnails and the outline need it).
    this.ensureIndex();
    this.win.webContents.focus();
    this.sendShell(MainToShellViews.findOpen);
  }

  /** The Find bar closed: the highlight goes, and the keyboard goes back to the deck. */
  closeFind(): void {
    if (!this.findOpen) return;
    this.findOpen = false;
    this.findQuery = '';
    try {
      this.liveDeck()?.stopFindInPage('keepSelection');
    } catch {
      // the view is gone
    }
    this.relayout(true);
    this.viewChanged();
    this.focusDeck();
  }

  /** RenderShellChannels.find: hits from the slide index of the current version; pending while it is built. */
  find(query: string): FindResponse {
    this.findQuery = query;
    const index = cachedSlideIndex(this.doc.fileKey, this.doc.version) ?? (this.index?.version === this.doc.version ? this.index : null);
    if (!index) this.ensureIndex();
    return findResponse(index, query);
  }

  /**
   * RenderShellChannels.findShow: "Choosing a result navigates to that slide, then highlights the match with
   * findInPage" (6.9 Find). The shell names the hit; main checks it against its own index and last query.
   */
  async findShow(slide: number, matchIndex: number): Promise<boolean> {
    const index = this.index && this.index.version === this.doc.version ? this.index : null;
    if (!index || !this.findQuery) return false;
    const hit = hitFor(index, this.findQuery, slide, matchIndex);
    if (!hit) return false;
    const target = findOnSlide(hit, index);
    if (!target.pageWide && !(await this.showEntry(slide))) return false;
    const wc = this.liveDeck();
    const v = this.viewNow;
    if (!wc || !v) return false;
    const r = await highlightMatch(wc, target, { width: v.deck.width, height: v.deck.height });
    return r.ok;
  }

  // ------------------------------------------------------------------------------------------- render products

  /**
   * The document as the render products need it (6.7: same partition, protocol and policy; reduced motion). Its
   * fields are copies, and its trust getters read `productsLive`, never the BlDocument: a render job can outlive the
   * window (a walk that disposeRenderer cut off may never settle), and whatever it holds then stays in memory
   * (finding 21: a closed document's decoded source and map are several times the file).
   */
  renderTarget(): RenderTarget {
    const d = this.doc;
    const live = this.productsLive;
    return renderTargetFor(
      {
        docId: d.docId,
        fileName: d.fileName,
        partition: d.partition,
        folderReal: d.folderReal,
        realpath: d.realpath,
        fileKey: d.fileKey,
        version: d.version,
        title: d.title,
        marker: d.marker,
        // Closed: Protected, no network (fail closed, as deckPolicies).
        trust: () => live.win?.doc.trust() ?? 'protected',
        networkAllowed: () => live.win?.doc.networkAllowed() ?? false,
      },
      { deckNav: this.deps.session.session.deckNav ?? null },
    );
  }

  /** Starts the slide index of the current version if nothing has built it yet. */
  private ensureIndex(): void {
    if (this.indexJob?.version === this.doc.version) return;
    if (this.index?.version === this.doc.version) return;
    this.startProducts(false);
  }

  /**
   * The slide index of the current version, then the rail's thumbnails (6.9 Navigation, 6.7). One job per
   * version; a newer version aborts the older one. `force` rebuilds an index the walk could not complete. The
   * callbacks reach the window through `productsLive` only (see renderTarget).
   */
  private startProducts(force: boolean): void {
    if (this.closing) return;
    const version = this.doc.version;
    if (!force && this.indexJob?.version === version) return;
    this.indexJob?.controller.abort();
    const controller = new AbortController();
    const job: IndexJob = { version, controller };
    this.indexJob = job;
    this.indexBuilding = true;
    if (this.index && this.index.version !== version) {
      this.index = null;
      this.thumbs.clear();
    }
    this.pushState();
    const target = this.renderTarget();
    const live = this.productsLive;
    void buildSlideIndex(target, { signal: controller.signal, force }).then(
      (index) => live.win?.onIndexBuilt(job, target, index),
      (e: unknown) => live.win?.onIndexFailed(job, e),
    );
  }

  private onIndexBuilt(job: IndexJob, target: RenderTarget, index: SlideIndex): void {
    if (this.indexJob !== job || this.closing || index.version !== this.doc.version) return;
    this.index = index;
    this.indexBuilding = false;
    const deck = index.kind === 'reveal' || index.kind === 'generic';
    if (deck) this.setIndexDesign(index.designSize);
    else this.relayout(true);
    const ready: ShellIndexReady = { version: index.version, kind: index.kind, count: index.slides.length, titles: index.slides.map((s) => s.title), designSize: { ...index.designSize } };
    this.sendShell(RenderShellChannels.indexReady, ready);
    this.pushState();
    this.viewChanged();
    if (deck) this.startThumbnails(target, index, job.controller.signal);
  }

  private onIndexFailed(job: IndexJob, e: unknown): void {
    if (this.indexJob === job) {
      this.indexBuilding = false;
      this.pushState();
    }
    if (!(e instanceof RenderCancelled) && !this.closing) this.deps.log(`slide index: ${errText(e)}`);
  }

  /** The rail's thumbnails at its width (2x PNGs), each sent to the shell as it is written or found cached. */
  private startThumbnails(target: RenderTarget, index: SlideIndex, signal: AbortSignal): void {
    const width = railThumbWidth(LEFT_RAIL_WIDTH);
    const live = this.productsLive;
    void renderThumbnails(target, index, width, (slide, _file, info) => live.win?.onThumbReady(slide, info.version, info.width, info.file), { signal }).catch((e: unknown) => {
      const w = live.win;
      if (w && !(e instanceof RenderCancelled) && !w.closing) w.deps.log(`thumbnails: ${errText(e)}`);
    });
  }

  private onThumbReady(slide: number, version: string, width: number, file: string): void {
    if (this.closing || version !== this.doc.version) return;
    const t: ShellThumb = { version, slide, width, src: thumbUrl(this.doc.docId, file) };
    this.thumbs.set(slide, t);
    this.sendShell(RenderShellChannels.thumb, t);
  }

  /** The shell (re)loaded: it gets the state, and the index and thumbnails it would have missed. */
  private onShellLoaded(): void {
    this.pushState();
    const index = this.index;
    if (index && index.version === this.doc.version) {
      const ready: ShellIndexReady = { version: index.version, kind: index.kind, count: index.slides.length, titles: index.slides.map((s) => s.title), designSize: { ...index.designSize } };
      this.sendShell(RenderShellChannels.indexReady, ready);
      for (const t of this.thumbs.values()) this.sendShell(RenderShellChannels.thumb, t);
    }
  }

  /** The deck page finished loading: the watcher starts with the first load, and the products for this version. */
  private onDeckLoaded(): void {
    this.applyZoom(true);
    if (!this.watcher && !this.closing) {
      this.watcher = watchDeck({
        realpath: this.doc.realpath,
        holder: this.doc,
        onExternalChange: (bytes, version) => this.onExternalChange(bytes, version),
        onGone: () => this.onFileGone(true),
        onBack: () => this.onFileGone(false),
        log: (m) => this.deps.log(m),
      });
    }
    this.startProducts(false);
  }

  private setTask(text: string | null): void {
    this.task = text;
    this.pushState();
  }

  /** Save as PDF (6.9, Cmd+Shift+E): the save dialog, then render-products' saveAsPdf. Works in Protected view. */
  async savePdf(): Promise<void> {
    if (this.win.isDestroyed()) return;
    if (this.task) {
      this.toast(`${this.task} Wait for it to finish.`, 'info');
      return;
    }
    const r = await dialog.showSaveDialog(this.win, {
      title: 'Save as PDF',
      defaultPath: defaultPdfPath(this.doc.path),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (r.canceled || !r.filePath) return;
    let out = r.filePath;
    if (!/\.pdf$/i.test(out)) out += '.pdf';
    this.setTask('Saving PDF…');
    try {
      const index = this.index?.version === this.doc.version ? this.index : undefined;
      const res = await saveAsPdf(this.renderTarget(), out, { index });
      const pages = `${res.pages} ${res.pages === 1 ? 'page' : 'pages'}`;
      if (res.missed.length > 0) {
        this.toast(`Saved ${path.basename(res.out)} (${pages}). Slides ${res.missed.map((i) => i + 1).join(', ')} could not be shown and are not in it.`, 'warn');
      } else this.toast(`Saved ${path.basename(res.out)} · ${pages}`, 'info');
      this.deps.log(`pdf: ${res.out} ${res.pages} pages (${res.mode})`);
    } catch (e) {
      this.deps.log(`pdf failed: ${errText(e)}`);
      this.toast(`The PDF was not saved: ${errText(e)}`, 'error');
    } finally {
      this.setTask(null);
    }
  }

  /** Print (6.9, Cmd+P): Save as PDF's pipeline, then the system print dialog. Works in Protected view. */
  async print(): Promise<void> {
    if (this.task) {
      this.toast(`${this.task} Wait for it to finish.`, 'info');
      return;
    }
    this.setTask('Preparing to print…');
    try {
      const index = this.index?.version === this.doc.version ? this.index : undefined;
      const r = await printDocument(this.renderTarget(), { index });
      // The user cancelled the dialog: nothing to say.
      if (!r.ok && r.why !== 'Print job canceled') this.toast(`Not printed: ${r.why}`, 'error');
      else if (r.ok && r.missed.length > 0) this.toast(`Printed. Slides ${r.missed.map((i) => i + 1).join(', ')} could not be shown.`, 'warn');
    } catch (e) {
      this.deps.log(`print failed: ${errText(e)}`);
      this.toast(`Not printed: ${errText(e)}`, 'error');
    } finally {
      this.setTask(null);
    }
  }

  // ------------------------------------------------------------------------------------------- reload (6.6, 9.2)

  /**
   * The watcher saw an external change (9.2 Watcher step 3): the document takes the new bytes (map, version,
   * served copies; knownHash), the deck gets the new map (Write protocol step 6), and the view reloads in place
   * through the ReloadCoordinator, at once or when the edit or card is done (6.6).
   */
  private onExternalChange(bytes: Uint8Array, version: string): void {
    if (this.closing) return;
    noteDocumentWrite(this.doc.fileKey);
    try {
      this.doc.replaceContent(bytes);
    } catch (e) {
      this.deps.log(`external change not taken: ${errText(e)}`);
      this.toast(`${this.doc.fileName} changed on disk, but the new version could not be read.`, 'error');
      return;
    }
    this.deps.log(`external change: ${this.doc.fileName} is now ${version.slice(0, 12)}`);
    this.sendDeck(MainToDeck.map, this.doc.utf8 ? toClientMap(this.doc.map) : null);
    this.designFromIndex = false;
    this.reload.requestReload(this.doc.version);
    // Thumbnails, the slide index and Find follow the new version (the shell asks Find again on indexReady).
    cancelThumbnails(this.doc.fileKey);
    this.startProducts(false);
    this.pushState();
  }

  /** 9.2 Watcher: the file went away (gone) or came back; the window keeps the last version, read-only. */
  private onFileGone(gone: boolean): void {
    if (this.closing || this.doc.gone === gone) return;
    this.doc.setGone(gone);
    this.deps.log(`${this.doc.fileName} ${gone ? 'is gone from its path' : 'is back'}`);
    if (gone && this.mode === 'edit') this.setMode('read');
    const update: AppModeUpdate = { appMode: this.mode, editingAllowed: this.doc.editable() };
    this.sendDeck(MainToDeck.appMode, update);
    this.relayout(true);
  }

  private onBusy(b: DeckBusy): void {
    this.reload.setBusy(b);
  }

  /** Runs reloads of the deck view one at a time. */
  private chainReload(fn: () => Promise<void>): Promise<void> {
    const run = this.reloadChain.then(fn, fn);
    this.reloadChain = run.catch(() => undefined);
    return run;
  }

  /** Loads the deck URL again (with `hash`) and resolves after the new page's handshake, or a timeout. */
  private async reloadDeck(hash: string): Promise<void> {
    const wc = this.liveDeck();
    if (!wc || this.closing) return;
    const handshake = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const i = this.initWaiters.indexOf(done);
        if (i >= 0) this.initWaiters.splice(i, 1);
        resolve();
      }, RELOAD_HANDSHAKE_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.initWaiters.push(done);
    });
    const safeHash = hash.startsWith('#') ? hash : '';
    const target = deckUrl(this.doc.docId, this.doc.fileName) + safeHash;
    try {
      // Loading the URL the view already shows, hash included, is a same-document fragment navigation and
      // reloads nothing. Then reload() is the reload; the page has not moved its URL to another path with
      // pushState (a path that would be redirected to -files, protocol.ts).
      if (wc.getURL() === target) wc.reload();
      else await wc.loadURL(target);
    } catch (e) {
      this.deps.log(`deck reload: ${errText(e)}`);
    }
    await handshake;
  }

  /** Sends the saved view state to the reloaded page; an index deck's slide comes back by main's keys. */
  private applyViewState(state: DeckViewState): void {
    this.sendDeck(MainToDeckFiles.applyViewState, state);
    if (state.slide !== null && this.slides?.navKind === 'index') this.restoreSlide = state.slide;
  }

  /**
   * Reloads the deck view now with its view state (6.6): Allow network (new headers) and reduced motion (a
   * deck that reads it in a script). Not deferred: the user asked for it, and the card a mode change closed
   * has sent its text.
   */
  private reloadInPlace(why: string): Promise<void> {
    return this.chainReload(async () => {
      if (this.closing) return;
      const state = await this.viewRequests.capture();
      if (this.closing) return;
      this.deps.log(`deck reload (${why})`);
      await this.reloadDeck(state?.hash ?? '');
      if (state && !this.closing) this.applyViewState(state);
    });
  }

  // ------------------------------------------------------------------------------------------- state

  toast(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    if (this.win.isDestroyed()) return;
    this.win.webContents.send(MainToShell.toast, { text, kind });
  }

  private trustBarVisible(): boolean {
    return this.doc.trust() === 'protected' && !this.trustBarDismissed;
  }

  private shellIndex(): ShellIndex | null {
    const index = this.index;
    if (index && index.version === this.doc.version) return shellIndexOf(index, this.indexBuilding);
    if (!this.indexBuilding) return null;
    return { version: this.doc.version, building: true, ready: false, kind: null, titles: [], outline: [] };
  }

  state(): ShellState {
    const doc = this.doc;
    const s = this.slides;
    const v = this.viewNow;
    return {
      docName: doc.fileName,
      docPath: doc.realpath,
      appMode: this.mode,
      trust: doc.trust(),
      trustReason: doc.trustReason,
      trustBarVisible: this.trustBarVisible(),
      networkAllowed: doc.networkAllowed(),
      editingAllowed: doc.editingAllowed(),
      capabilities: { ...this.deps.capabilities },
      readOnlyReason: doc.readOnlyReason,
      slide: s ? { current: s.current, count: s.count, kind: s.kind, titles: s.titles.slice(0, 2000) } : null,
      saveState: this.saveState,
      layout: { ...this.layoutNow },
      notes: this.notes.notes.map((n) => ({ id: n.id, status: n.status, kind: n.kind, text: n.text.slice(0, SHELL_NOTE_TEXT) })),
      banner: this.bannerText(),
      view: {
        kind: this.viewKind(),
        zoomMode: this.zoomMode,
        zoom: v?.zoom ?? 1,
        readingWidth: this.readingWidth,
        railHidden: this.railHidden(),
        presenting: this.present?.active === true,
        scroll: v?.scroll ? { ...v.scroll } : null,
      },
      index: this.shellIndex(),
      status: {
        task: this.task,
        reloadDeferred: this.reloadDeferred,
        fileGone: doc.gone,
      },
    };
  }

  /** 6.6: the deferred reload's status text (tests and logs). */
  get reloadStatus(): string | null {
    return this.reloadDeferred ? RELOAD_DEFERRED_TEXT : null;
  }

  /** Reloads done in place after external changes (tests). */
  get reloads(): number {
    return this.reload.reloads;
  }

  pushState(): void {
    if (this.win.isDestroyed()) return;
    this.win.webContents.send(MainToShell.state, this.state());
  }

  /** The deck preload reports a text field focused (for Undo/Redo menu clicks). */
  deckTextFieldFocused(): boolean {
    return this.textField;
  }

  isDestroyed(): boolean {
    return this.win.isDestroyed();
  }

  /**
   * Closes the deck view's webContents, once, when its window is closing. In Electron 44 a WebContentsView's
   * webContents outlives its window (a Protected page would keep running), and a quit waits for it, so it
   * must be closed explicitly. Phase 0 finding: closing it in the window's 'close' event never stalled a
   * quit; closing it in 'closed', in before-quit, or a moment later sometimes left the process hanging
   * with the deck renderer alive.
   */
  closeDeck(): void {
    if (this.deckCloseRequested) return;
    this.deckCloseRequested = true;
    this.liveDeck()?.close();
  }

  /** Gives the keyboard back to the deck view after a click in the shell (deck keys, Wispr Flow). */
  focusDeck(): void {
    if (this.win.isDestroyed()) return;
    this.liveDeck()?.focus();
  }

  focus(): void {
    if (this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  private onClosed(): void {
    if (this.closedOnce) return;
    this.closedOnce = true;
    const doc = this.doc;
    if (windowsByKey.get(doc.docId) === this) windowsByKey.delete(doc.docId);
    // Backstop for win.destroy(), which skips 'close'.
    this.closeDeck();
    // Nothing reloads, watches or renders for this window after this (9.2 Watcher; 6.7: the render windows
    // live in the deck's partition and hold its protocol, so they close before the partition is retired).
    this.watcher?.close();
    this.watcher = null;
    this.reload.dispose();
    this.viewRequests.dispose();
    this.navToken++;
    this.indexJob?.controller.abort();
    this.indexJob = null;
    // Render jobs that never settle (their views were disposed) must not keep this window or its document.
    this.productsLive.win = null;
    cancelThumbnails(doc.fileKey);
    disposeRenderer(doc.docId);
    this.deps.registry.remove(doc);
    // Finding 21: nothing the partition keeps for the rest of the process may reach this window or its
    // document. The policy callbacks read policyState only: clearing it makes them fail closed at once
    // (Protected, no network). The handles are disposed once the deck view is gone (they guard it until
    // then), which removes their session listeners and the handle the trust hooks keep per Session. The
    // permission handlers and the request listener stay, failing closed: a Protected partition's are replaced
    // below by capture-free ones; a Trusted persist: partition is never reset here, because a reopened window
    // of the same file uses it and installs its own policy over them.
    this.policyState.live = null;
    disposeWhenGone(this.liveDeck() ?? undefined, [this.sessionPolicy, this.webPolicy]);
    this.sessionPolicy = null;
    this.webPolicy = null;
    if (doc.trust() === 'protected') {
      // 6.10 Storage (Protected): cleared when the window closes. The partition is never used again (a new
      // open gets a new docId and partition), so its handlers are replaced with ones that hold nothing.
      const ses = this.deckSession;
      retireProtectedPartition(ses);
      void ses.clearStorageData().catch(() => undefined);
      void ses.clearCache().catch(() => undefined);
      for (const scheme of [DECK_SCHEME, MEDIA_SCHEME]) {
        try {
          if (ses.protocol.isProtocolHandled(scheme)) ses.protocol.unhandle(scheme);
        } catch {
          // already gone
        }
      }
    }
    // The bytes read at open and the served copies are not needed any more (finding 21).
    doc.release();
    this.deps.closed(this);
    this.resolveClosed();
  }
}
