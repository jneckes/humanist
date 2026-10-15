// One window per document (6.0 The window; 9.1 Windows and views). The BrowserWindow's own webContents is
// the shell (the app UI: sandboxed, context-isolated, its own `shell` session, loaded from app://shell/ and
// never navigating). The deck view is a WebContentsView added to win.contentView over the shell's content
// area: sandboxed, context-isolated, no Node, webSecurity on, in the document's own partition (9.9 Always),
// with the deck preload. Main owns the layout numbers (layout.ts) and sends them to the shell.
//
// Deck messages arrive through the IPC guard (channels.ts): the document is the one this view was
// registered for. Trust changes (Allow network, Enable editing) come only from the shell (9.1 Shell view).

import {
  BrowserWindow,
  Menu,
  WebContentsView,
  dialog,
  nativeTheme,
  session,
  type Input,
  type MenuItemConstructorOptions,
  type Session,
} from 'electron';
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
import { toClientMap } from '@blueline/core/mapper';
import type { Person } from '@blueline/core/types';
import { PHASE_STUBS, revealLabel, type AppAction } from './actions';
import { attachDeckView, shellRouter } from './channels';
import { matchAppChord, SwallowedKeys } from './chords';
import type { BlDocument, DocumentRegistry } from './documents';
import { validateNoArgs, validateSetMode, type ArgsValidator, type ShellSender } from './ipc-guard';
import { computeLayout, deckBounds } from './layout';
import { DEFAULT_ALLOWLIST } from './network-policy';
import { NotesStore } from './notes';
import { deckUrl, installDeckProtocol, installShellProtocol, SHELL_ORIGIN } from './protocol';
import type { SaveEvent, SessionStore } from './session-store';
import {
  installDeckSessionPolicy,
  installDeckWebContentsPolicy,
  installShellPolicy,
  openExternalConfirmed,
  type BlockReason,
  type DeckSessionHandle,
  type DeckWebContentsHandle,
} from './trust-hooks';

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
  /** Closed loopback port for the Protected PAC (pickClosedLoopbackPort, once per launch). */
  blockPort: number;
  platform: NodeJS.Platform;
  person(): Person;
  runAction(action: AppAction, w: DocWindow): void;
  openLocalHtml(realpath: string, o: { protected: boolean }): void;
  openInBrowser(realpath: string): Promise<void>;
  reveal(realpath: string): void;
  closed(w: DocWindow): void;
  log(msg: string): void;
}

let shellProtocolInstalled = false;
let shellChannelsDeclared = false;
const windowsByKey = new Map<string, DocWindow>();

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

/**
 * Declares the shell channels app-shell owns, once. Each call is routed to the window whose shell sent it
 * (ShellIpc checks the sender: a registered shell webContents, its main frame, origin app://shell).
 */
function declareShellChannels(): void {
  if (shellChannelsDeclared) return;
  shellChannelsDeclared = true;
  const r = shellRouter();
  const win = (from: ShellSender): DocWindow => {
    const w = windowsByKey.get(from.windowKey);
    if (!w) throw new Error('Refused');
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
}

/** The window of a shell sender's key, for other modules (tests, the Diagnostics window). */
export function docWindowByKey(key: string): DocWindow | undefined {
  return windowsByKey.get(key);
}

export class DocWindow {
  readonly win: BrowserWindow;
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
  private sessionPolicy: DeckSessionHandle | null = null;
  private webPolicy: DeckWebContentsHandle | null = null;
  private linkDialogOpen = false;
  private closedOnce = false;
  private deckCloseRequested = false;
  /** How many times the deck preload completed the handshake (ready → init), for tests and logs. */
  private inits = 0;

  private constructor(private readonly deps: DocWindowDeps) {
    const doc = deps.doc;
    this.doc = doc;
    this.notes = new NotesStore(deps.session.session, {
      me: () => deps.person(),
      now: () => new Date().toISOString(),
      version: () => doc.version,
      slides: () => this.slides,
    });

    const shellSession = session.fromPartition(SHELL_PARTITION);
    if (!shellProtocolInstalled) {
      installShellProtocol(shellSession, deps.paths.shellDir);
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
    shellWc.on('did-finish-load', () => this.pushState());
    // 6.4: a click on the toolbar or the notes panel closes the open card.
    shellWc.on('focus', () => this.sendDeck(MainToDeck.closeCard));

    // The deck view, in the document's own partition (9.1, 9.9 Always).
    this.deckSession = session.fromPartition(doc.partition);
    installDeckProtocol(this.deckSession, deps.registry.lookupFor(doc.partition));
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
      },
    });
    this.win.contentView.addChildView(this.deck);
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
    });
    this.webPolicy = installDeckWebContentsPolicy(deckWc, {
      docId: doc.docId,
      folderReal: doc.folderReal,
      isProtected: () => doc.trust() === 'protected',
      networkOpen: () => doc.trust() === 'trusted' || doc.networkAllowed(),
      onUserLink: (url) => this.confirmExternal(url),
      openLocalHtml: (realpath, o) => deps.openLocalHtml(realpath, o),
      onBlocked: (url, why) => this.onBlocked(url, why),
      onSubframeBlocked: (url) => {
        if (deps.test) deps.log(`subframe navigation blocked: ${url.slice(0, 200)}`);
      },
    });
    deckWc.on('before-input-event', (event, input) => this.onDeckInput(event, input));
    deckWc.on('render-process-gone', (_e, details) => {
      deps.log(`deck renderer gone (${details.reason}) for ${doc.fileName}`);
      if (details.reason !== 'clean-exit') this.toast('The document stopped working. Close it and open it again.', 'error');
    });
    deckWc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.toast(`${doc.fileName} could not be shown (${desc}).`, 'error');
    });
    deckWc.on('did-finish-load', () => {
      if (this.win.isFocused()) deckWc.focus();
    });
    if (deps.test) {
      deckWc.on('console-message', (e) => deps.log(`deck console [${e.level}] ${String(e.message).slice(0, 500)}`));
    }

    this.layoutNow = this.computeLayout();
    this.win.on('resize', () => this.relayout());
    // The content area also changes without a resize: on Linux and Windows the menu bar is attached after
    // the window is created, which shortens it (Phase 0 finding).
    this.win.contentView.on('bounds-changed', () => this.relayout());
    this.win.on('show', () => this.relayout());
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
    w.relayout();
    void w.win.webContents.loadURL(SHELL_URL).catch((e) => deps.log(`shell failed to load: ${String(e)}`));
    await w.startDeck();
    return w;
  }

  private async startDeck(): Promise<void> {
    const doc = this.doc;
    this.sessionPolicy = installDeckSessionPolicy(this.deckSession, {
      trust: () => doc.trust(),
      networkAllowed: () => doc.networkAllowed(),
      strict: () => false, // Phase 1: Settings › Trust "Block all network in Protected view"
      allowlist: () => DEFAULT_ALLOWLIST, // Phase 1: user-editable in Settings › Trust
      blockPort: this.deps.blockPort,
      sourcePath: () => doc.realpath,
      onDownloadBlocked: () => this.toast('Downloads are blocked in Protected view.', 'warn'),
      onRequest: this.deps.test
        ? (d, dec) => {
            if (dec.cancel) this.deps.log(`request cancelled (${dec.reason}) ${d.resourceType} ${d.url.slice(0, 200)}`);
          }
        : undefined,
    });
    try {
      // 9.9: the Protected proxy must be in place and verified before the deck loads.
      await this.sessionPolicy.ready;
    } catch (e) {
      this.deps.log(`deck policy failed: ${e instanceof Error ? e.message : String(e)}`);
      this.toast('Protected view could not block the network, so the document was not loaded.', 'error');
      return;
    }
    if (this.deck.webContents.isDestroyed()) return;
    void this.loadDeck();
  }

  private async loadDeck(): Promise<void> {
    try {
      await this.deck.webContents.loadURL(deckUrl(this.doc.docId, this.doc.fileName));
    } catch (e) {
      // did-fail-load reports it; an aborted load (a reload replacing it) is not an error.
      this.deps.log(`deck load: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  get appMode(): AppMode {
    return this.mode;
  }

  // ------------------------------------------------------------------------------------------- deck → main

  private sendDeck(channel: string, payload?: unknown): void {
    const wc = this.deck.webContents;
    if (!wc.isDestroyed()) wc.send(channel, payload);
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
  }

  get handshakes(): number {
    return this.inits;
  }

  /** <userData>/files/<fileKey>/session.json of this document. */
  get sessionFile(): string {
    return this.deps.session.file;
  }

  private onSlides(p: SlideState): void {
    this.slides = p;
    // 6.7 Index replay: the keys that moved this deck, kept as Session.deckNav (when the guard passes them).
    const nav = p.deckNav;
    if (nav && typeof nav.forward === 'string' && typeof nav.back === 'string' && nav.forward.length <= 32 && nav.back.length <= 32) {
      const s = this.deps.session.session;
      if (!s.deckNav || s.deckNav.forward !== nav.forward || s.deckNav.back !== nav.back) {
        s.deckNav = { forward: nav.forward, back: nav.back };
        this.save();
      }
    }
    this.pushState();
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

  /** 6.2: exactly an app chord → hidden from the page and the menu, and run here. */
  private onDeckInput(event: Electron.Event, input: Input): void {
    if (this.swallowed.takeKeyUp(input)) {
      event.preventDefault();
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
      .catch((e) => this.deps.log(`openExternal: ${e instanceof Error ? e.message : String(e)}`))
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
   * allowed (6.10: in Protected view, Edit asks you to enable editing first).
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
    return true;
  }

  /** 6.10 Allow network: the Trusted network policy for this file. The deck reloads so its headers change. */
  async allowNetwork(): Promise<void> {
    if (this.doc.trust() !== 'protected' || this.doc.networkAllowed()) return;
    this.doc.allowNetwork();
    try {
      await this.sessionPolicy?.update();
    } catch (e) {
      this.deps.log(`proxy update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.pushState();
    // The served copy and its headers change (no connect-src 'none', resource hints kept): reload it.
    if (!this.deck.webContents.isDestroyed()) void this.loadDeck();
  }

  /** 6.10 Enable editing. Network keeps its current policy. */
  enableEditing(): void {
    if (this.doc.editingAllowed()) return;
    this.doc.enableEditing();
    const update: AppModeUpdate = { appMode: this.mode, editingAllowed: this.doc.editable() };
    this.sendDeck(MainToDeck.appMode, update);
    this.pushState();
  }

  dismissTrustBar(): void {
    this.trustBarDismissed = true;
    this.relayout();
  }

  dismissBanner(): void {
    if (this.leftDocument) this.leftDocument = false;
    else this.readOnlyDismissed = true;
    this.relayout();
  }

  /**
   * The bar under the toolbar: "This page tried to leave the document" (9.9) first, else the banner of a
   * deck that is not UTF-8 (9.2 rule 1: "a banner says 'deck.html is not UTF-8; direct edits are off'").
   * Both offer Open in Browser.
   */
  private bannerText(): string | null {
    if (this.leftDocument) return BANNER_LEFT;
    if (this.doc.readOnlyReason && !this.readOnlyDismissed) return this.doc.readOnlyReason;
    return null;
  }

  popupMenu(menu: ShellMenu, x: number, y: number): void {
    if (this.win.isDestroyed()) return;
    const items: MenuItemConstructorOptions[] = [];
    if (menu === 'file') {
      items.push({ label: this.doc.realpath, enabled: false });
      items.push({ label: this.doc.received ? 'Received file' : 'Your file', enabled: false });
      items.push({ type: 'separator' });
      items.push({ label: revealLabel(this.deps.platform), click: () => this.runAction('reveal') });
      items.push({ label: 'Open in Browser', click: () => this.runAction('open-in-browser') });
    } else if (menu === 'share') {
      // 6.0 Share: Save as PDF (Phase 1), Save a copy for review and Export clean copy (Phase 5).
      items.push({ label: 'Save as PDF', enabled: false, sublabel: 'Phase 1' });
      items.push({ label: 'Save a copy for review', enabled: false, sublabel: 'Phase 5' });
      items.push({ label: 'Export clean copy', enabled: false, sublabel: 'Phase 5' });
    } else {
      items.push({ label: 'Open in Browser', click: () => this.runAction('open-in-browser') });
    }
    Menu.buildFromTemplate(items).popup({ window: this.win, x, y });
  }

  // ------------------------------------------------------------------------------------------- state

  toast(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    if (this.win.isDestroyed()) return;
    this.win.webContents.send(MainToShell.toast, { text, kind });
  }

  private trustBarVisible(): boolean {
    return this.doc.trust() === 'protected' && !this.trustBarDismissed;
  }

  private computeLayout(): ShellLayout {
    const [width, height] = this.win.isDestroyed() ? [0, 0] : this.win.getContentSize();
    return computeLayout({ width, height, appMode: this.mode, trustBarVisible: this.trustBarVisible(), bannerVisible: this.bannerText() !== null });
  }

  private relayout(): void {
    if (this.win.isDestroyed()) return;
    const layout = this.computeLayout();
    const [width, height] = this.win.getContentSize();
    this.deck.setBounds(deckBounds(layout, { width, height }));
    const changed = JSON.stringify(layout) !== JSON.stringify(this.layoutNow);
    this.layoutNow = layout;
    if (changed) this.pushState();
  }

  state(): ShellState {
    const doc = this.doc;
    const s = this.slides;
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
    };
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
    const wc = this.deck.webContents;
    if (!wc.isDestroyed()) wc.close();
  }

  /** Gives the keyboard back to the deck view after a click in the shell (deck keys, Wispr Flow). */
  focusDeck(): void {
    const wc = this.deck.webContents;
    if (!this.win.isDestroyed() && !wc.isDestroyed()) wc.focus();
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
    // The trust hooks stay installed until the view is destroyed (they clean up on 'destroyed'): disposing
    // them first would leave the closing view unguarded for a moment. A Trusted partition's session policy is
    // replaced when the file opens again.
    // Backstop for win.destroy(), which skips 'close'.
    this.closeDeck();
    this.deps.registry.remove(doc);
    if (doc.trust() === 'protected') {
      // 6.10 Storage (Protected): cleared when the window closes. The partition is never used again (a new
      // open gets a new docId and partition).
      const ses = this.deckSession;
      void ses.clearStorageData().catch(() => undefined);
      void ses.clearCache().catch(() => undefined);
      try {
        if (ses.protocol.isProtocolHandled('blueline')) ses.protocol.unhandle('blueline');
      } catch {
        // already gone
      }
    }
    this.deps.closed(this);
  }
}
