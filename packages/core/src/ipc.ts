// IPC contract between the deck preload, the shell preload and main (9.1, "IPC replaces the earlier HTTP
// and WebSocket design"). Types only, plus channel names. Main validates every deck payload against a
// schema with size and rate limits (9.1, "Main treats every message from a deck view as written by the page").

import type { ClientMap, DomTextNode, Note, SlideNavKind } from './types';

export type AppMode = 'read' | 'review' | 'edit';
export type TrustState = 'protected' | 'trusted';
/** How the deck preload runs: the visible deck view, an offscreen render view (no UI), or the Diagnostics deck. */
export type PreloadMode = 'deck' | 'render' | 'diagnostics';

export interface Capabilities {
  edit: boolean;
  agent: boolean;
}

// ----------------------------------------------------------------- deck preload → main (ipcRenderer.send)
export const DeckToMain = {
  /** Preload booted. Main answers with MainToDeck.init. */
  ready: 'bl:deck:ready',
  /** Text-field focus changed (6.2: Cmd+Z routing). Payload: FocusState. */
  focus: 'bl:deck:focus',
  /** The user clicked a link (trusted click). Payload: LinkClick. Main still shows its own dialog. */
  link: 'bl:deck:link',
  /** Slide model changed (detected, or current slide moved). Payload: SlideState. */
  slides: 'bl:deck:slides',
  /** Esc pressed twice: return to Read (6.2). Payload: { mode: 'read' }. The only mode a deck may ask for. */
  mode: 'bl:deck:mode',
  /** Minimal note card operations (Phase 0). Payload: NoteOp. */
  note: 'bl:deck:note',
  /** Diagnostics events (diagnostics mode only). Payload: DiagEvent. */
  diag: 'bl:deck:diag',
  /** Render-mode reply to MainToDeck.renderRequest. Payload: RenderReply. */
  renderReply: 'bl:render:reply',
} as const;

// ----------------------------------------------------------------- main → deck preload (webContents.send)
export const MainToDeck = {
  init: 'bl:deck:init',
  appMode: 'bl:deck:app-mode',
  map: 'bl:deck:map',
  notes: 'bl:deck:notes',
  /** Hide or show overlay chrome for screenshots (6.7). Payload: { hidden: boolean }. */
  chrome: 'bl:deck:chrome',
  /** Added by preload: close the open card (6.4: a click on the toolbar or the notes panel). No payload. */
  closeCard: 'bl:deck:close-card',
  renderRequest: 'bl:render:request',
} as const;

export interface DeckInit {
  mode: PreloadMode;
  appMode: AppMode;
  trust: TrustState;
  capabilities: Capabilities;
  editingAllowed: boolean;
  map: ClientMap | null;
  notes: Note[];
  /** Display name of the user, for the note card's author chip. */
  userName: string;
}

export interface FocusState {
  textField: boolean;
}

export interface LinkClick {
  /** The link's resolved absolute URL (`a.href`). */
  href: string;
}

export interface SlideState {
  kind: 'reveal' | 'generic' | 'scroll' | 'single';
  count: number;
  current: number;
  titles: string[];
  navKind: SlideNavKind;
  /** Added by preload: per slide, the `location.hash` that shows it, when navKind is 'hash' (SlideRef.nav.value, 9.4). */
  hashes?: string[];
  /** Added by preload: per slide, reveal.js `[h, v]`, when kind is 'reveal' (SlideRef.nav.value, 9.4). */
  revealIndices?: [number, number][];
  /** Added by preload: per slide, the slide element's id, or null (SlideRef.id). */
  ids?: (string | null)[];
  /**
   * Added by preload (6.7 Index replay): the DOM `key` values the visible view saw move this deck forward and
   * back (trusted keys only). Main stores them as `Session.deckNav`.
   */
  deckNav?: { forward?: string; back?: string };
}

/** Phase 0 note card operations. Main assigns ids, authors and timestamps; the deck never sets status freely. */
export type NoteOp =
  | { op: 'create'; clientId: string; text: string; marks: NoteOpMark[]; slide: number | null }
  | { op: 'update'; id: string; text?: string; marks?: NoteOpMark[] }
  | { op: 'close'; id: string } // draft → open, or deleted when empty (6.4)
  | { op: 'delete'; id: string };

export interface NoteOpMark {
  tool: 'pen' | 'highlighter' | 'arrow' | 'pin' | 'box';
  shape?: 'ellipse' | 'freehand' | 'underline' | 'strike' | 'rect';
  /** SVG path in page coordinates. */
  path: string;
  /** Short descriptions of the targets the overlay hit (text trimmed). Full anchoring is Phase 3. */
  targets: { css: string; text: string; role: string; stamp: string | null }[];
}

export interface DiagEvent {
  event:
    | 'key-order' // { first: 'preload' | 'page', key }
    | 'stop-propagation' // { pageListenerRan: boolean, key }
    | 'beforeinput' // { inputType, data }
    | 'paste' // { length }
    | 'card-input' // { length, value }
    | 'heading-input' // { value }
    | 'mark-added' // { noteId?, n }
    | 'shortcut' // { key, action }
    | 'mode-change' // { from, to, cause }
    | 'deck-moved'; // { from, to }
  data: Record<string, unknown>;
}

// ----------------------------------------------------------------- render service (offscreen) protocol
export type RenderCmd =
  | { type: 'detect' }
  | { type: 'current' }
  | { type: 'goto'; index: number } // reveal / hash / scroll navigation inside the page (index nav uses main's sendInputEvent)
  | { type: 'settle' } // fonts.ready + 2 animation frames + pause animations
  | { type: 'collect' } // visible text nodes and blocks right now (section 10, Phase 0, step 4)
  | { type: 'find'; needle: string } // every text node containing needle, visible or not
  | { type: 'locate'; locator: NodeLocator } // the text node at a locator
  | { type: 'scroll-blocks' } // scrolling documents: the blocks to scrollIntoView
  // Added by preload: 6.7 Index replay fallback, a synthetic keydown + keyup on the focused element (a deck that
  // ignores untrusted keys does not move, and main reports navOk: false).
  | { type: 'key'; key: 'ArrowRight' | 'ArrowLeft' | 'PageDown' | 'PageUp' | ' ' }
  // Added by map-walk-probe (review finding 33): the keydowns the page's window has seen since this load, from a
  // capture listener the render agent registers at preload start, before any page script (KeydownsResult).
  | { type: 'keydowns' }
  // Added by map-walk-probe (review finding 34): window.scrollTo(0, y), so a scrolling or single-page walk can
  // step through the whole document and the probe can replay a stop at the same offset (ScrollToResult).
  | { type: 'scroll-to'; y: number };

export interface RenderRequest {
  reqId: number;
  cmd: RenderCmd;
}

export interface RenderReply {
  reqId: number;
  ok: boolean;
  error?: string;
  result?: unknown;
}

export interface DetectResult {
  kind: SlideState['kind'];
  count: number;
  current: number;
  titles: string[];
  navKind: SlideNavKind;
  /** reveal.js width/height, or the slide element's box, or 1600×900 (6.9). */
  designSize: { w: number; h: number };
  revealIndices?: [number, number][];
  /** Added by preload: per slide, the hash that shows it (navKind 'hash'), as in SlideState.hashes. */
  hashes?: string[];
  /** Added by preload: per slide, the slide element's id, or null. */
  ids?: (string | null)[];
}

// Added by preload: the results of the other RenderCmds (RenderReply.result).

/** `current`: where the page is now. */
export interface CurrentResult {
  current: number;
  count: number;
  /** `location.hash` now. */
  hash: string;
  scrollY: number;
  /** reveal.js `[h, v]` of the current slide, else null. */
  reveal: [number, number] | null;
}

/**
 * `goto`: navigated inside the page (reveal: `Reveal.slide(h, v)` in the main world; hash: `location.hash`;
 * scroll: `scrollIntoView`). For navKind 'index' the agent does not navigate (main sends keys with
 * sendInputEvent, 6.7); it answers `navigated: false, reason: 'index'` with the current slide.
 */
export interface GotoResult {
  navigated: boolean;
  /** The current slide after waiting up to 1 s for it to change (6.7). */
  current: number;
  navKind: SlideNavKind;
  reason?: string;
}

/** `settle`: fonts.ready, two animation frames, animations paused (6.7 step 3). */
export interface SettleResult {
  fontsReady: boolean;
  /** Animations paused with Animation.pause(). */
  paused: number;
  /** The `*{animation-play-state:paused!important}` sheet is in document.adoptedStyleSheets. */
  sheetAdopted: boolean;
}

/** `find`: every text node whose data contains the needle, visible or not (6.9 Find). */
export interface FindResult {
  matches: {
    key: number;
    locator: NodeLocator;
    node: DomTextNode;
    visible: boolean;
    slide: number | null;
    /**
     * Added by map-walk-probe (review finding 31): the node sits inside an absolutely or fixed positioned
     * element clipped to a zero area (the walk's skipClipped rule; reveal.js's `.aria-status`, F17).
     */
    clipped?: boolean;
    /** Added by map-walk-probe (review finding 32): where the node lives; absent means 'document'. */
    tree?: WalkTree;
  }[];
  /** More than the reply limit matched; the list is cut. */
  truncated: boolean;
}

/** `locate`: the text node at a locator, or `found: false`. */
export interface LocateResult {
  found: boolean;
  node: WalkNode | null;
  /** Passes the section 10 step 4 visibility test right now. */
  visible: boolean;
  slide: number | null;
}

/** `scroll-blocks`: the blocks of a scrolling document (9.4 step 3), in document order; `goto` index i scrolls to block i. */
export interface ScrollBlocksResult {
  blocks: { index: number; cssPath: string; title: string; top: number; height: number }[];
}

/** `key`: the synthetic-key fallback of 6.7 Index replay (used only if sendInputEvent cannot reach an offscreen deck). */
export interface KeyResult {
  dispatched: boolean;
  /** The current slide after waiting up to 1 s for it to change. */
  current: number;
}

/** Added by map-walk-probe. `keydowns`: keydown events the page's window saw since this load (6.7 Index replay). */
export interface KeydownsResult {
  /** Trusted keydowns (sendInputEvent reached the page). */
  trusted: number;
  all: number;
}

/** Added by map-walk-probe. `scroll-to`: where the document is after window.scrollTo(0, y) (CSS px). */
export interface ScrollToResult {
  scrollY: number;
  innerHeight: number;
  /** The document's scroll height: the walk is done when scrollY + innerHeight reaches it. */
  scrollHeight: number;
}

// Added by preload: payloads of the MainToDeck channels other than init and renderRequest.

/** MainToDeck.appMode. A bare AppMode string is also accepted by the preload. */
export interface AppModeUpdate {
  appMode: AppMode;
  editingAllowed?: boolean;
}

/**
 * MainToDeck.notes: every note of the document. `created` maps the `clientId` of this view's NoteOp `create`
 * to the id main gave the note, so the open card can send `update` and `close`. A bare Note[] is also accepted.
 */
export interface NotesUpdate {
  notes: Note[];
  created?: { clientId: string; id: string }[];
}

/** MainToDeck.map: the client map for the current version, or null (not UTF-8, or no map yet). */
export type MapUpdate = ClientMap | null;

/** MainToDeck.chrome (6.7 Note screenshots): hide cards and outlines; the ink stays. */
export interface ChromeUpdate {
  hidden: boolean;
}

/** Finds a text node again after a reload of the same (or a probe-edited) file. */
export interface NodeLocator {
  /** data-bl-e of the parent element, if any. */
  stamp: string | null;
  /** CSS path of the parent element (nearest id ancestor, then :nth-of-type steps). */
  cssPath: string;
  /** Index of the node among ALL the parent's child text nodes (including whitespace-only ones). */
  childIndex: number;
}

/**
 * Added by map-walk-probe (review finding 32): the tree a text node lives in. `shadow`: an open shadow root;
 * `frame`: a same-origin frame's document. Such text is counted but never written (section 7: text in iframes
 * is pin only), and its locator's cssPath joins the host or frame path with ` >>> ` or ` >>frame>> `.
 */
export type WalkTree = 'document' | 'shadow' | 'frame';

export interface WalkNode {
  /** Unique per page load; the walker counts each node once across slides by this key. */
  key: number;
  locator: NodeLocator;
  node: DomTextNode;
  /** In the top document's viewport (CSS px); a frame's own position is added. */
  rect: { x: number; y: number; w: number; h: number };
  /** Added by map-walk-probe: absent means 'document'. */
  tree?: WalkTree;
  /**
   * Added by map-walk-probe (review finding 35): the slide or block that contains the node (9.4 slideIndexOf),
   * null when none does; absent when the agent has no slide model.
   */
  slide?: number | null;
}

export interface WalkBlock {
  key: number;
  /** The block has inline element children (b, strong, i, em, a, code, span, br). */
  hasInline: boolean;
  /** Keys of the WalkNodes that are the block's text runs. */
  nodeKeys: number[];
}

export interface CollectResult {
  nodes: WalkNode[];
  blocks: WalkBlock[];
  /**
   * Added by map-walk-probe (review finding 32): keys of visible frames whose document the page cannot read
   * (cross-origin: data:, `-files`, the network), so their text is not counted. Closed shadow roots cannot be
   * seen from the page at all.
   */
  crossOriginFrames?: number[];
}

// ----------------------------------------------------------------- shell (contextBridge window.blueline)
export const ShellToMain = {
  getState: 'bl:shell:get-state',
  setMode: 'bl:shell:set-mode',
  allowNetwork: 'bl:shell:allow-network',
  enableEditing: 'bl:shell:enable-editing',
  dismissTrustBar: 'bl:shell:dismiss-trust-bar',
  openInBrowser: 'bl:shell:open-in-browser',
  revealFile: 'bl:shell:reveal-file',
  diagState: 'bl:shell:diag-state',
  diagRecord: 'bl:shell:diag-record',
  diagRunAuto: 'bl:shell:diag-run-auto',
  diagSave: 'bl:shell:diag-save',
  /** Added by app-shell: hide the "This page tried to leave the document" bar (9.9). */
  dismissBanner: 'bl:shell:dismiss-banner',
  /**
   * Added by app-shell: show a native popup menu (the file name's path + Reveal, Share, the trust bar's
   * overflow). Native menus draw above the deck view, which covers the shell's content area.
   */
  popupMenu: 'bl:shell:popup-menu',
} as const;

export const MainToShell = {
  state: 'bl:shell:state',
  toast: 'bl:shell:toast',
  diag: 'bl:shell:diag',
} as const;

export interface ShellLayout {
  toolbar: number;
  trustBar: number;
  statusBar: number;
  leftRail: number;
  rightPanel: number;
  /** Added by app-shell: height of the "This page tried to leave the document" bar (0 when hidden). */
  banner: number;
}

export interface ShellState {
  docName: string;
  docPath: string;
  appMode: AppMode;
  trust: TrustState;
  trustReason: string | null;
  trustBarVisible: boolean;
  networkAllowed: boolean;
  editingAllowed: boolean;
  capabilities: Capabilities;
  readOnlyReason: string | null; // e.g. "deck.html is not UTF-8; direct edits are off"
  /** `titles` added by app-shell: the left rail's slide titles (SlideState.titles). */
  slide: { current: number; count: number; kind: SlideState['kind']; titles: string[] } | null;
  saveState: string;
  layout: ShellLayout;
  notes: Pick<Note, 'id' | 'status' | 'text' | 'kind'>[];
  banner: string | null; // e.g. "This page tried to leave the document"
}

export interface DiagStep {
  id: string;
  title: string;
  instructions: string;
  auto: boolean;
  result: 'pending' | 'pass' | 'fail' | 'skip';
  detail?: string;
}

export interface DiagState {
  steps: DiagStep[];
  log: { at: string; event: string; data: Record<string, unknown> }[];
  savedTo: string | null;
  /** Added by app-render: the Diagnostics deck's app mode (Cmd+1/2/3 switch it), shown in its shell. */
  appMode?: AppMode;
  /** Added by app-render: the automatic checks are running. */
  running?: boolean;
}

/** Added by app-shell: the native popup menus the shell can ask for (ShellApi.popupMenu). */
export type ShellMenu = 'file' | 'share' | 'trust-overflow';

/** The API the shell preload exposes as window.blueline (named, typed functions only; 9.1). */
export interface ShellApi {
  getState(): Promise<ShellState>;
  onState(cb: (s: ShellState) => void): void;
  onToast(cb: (t: { text: string; kind: 'info' | 'warn' | 'error' }) => void): void;
  setMode(mode: AppMode): Promise<void>;
  allowNetwork(): Promise<void>;
  enableEditing(): Promise<void>;
  dismissTrustBar(): Promise<void>;
  openInBrowser(): Promise<void>;
  revealFile(): Promise<void>;
  /** Added by app-shell (ShellToMain.dismissBanner). */
  dismissBanner(): Promise<void>;
  /** Added by app-shell (ShellToMain.popupMenu): `x`, `y` in the shell's CSS pixels. */
  popupMenu(menu: ShellMenu, x: number, y: number): Promise<void>;
  diag: {
    getState(): Promise<DiagState>;
    onState(cb: (s: DiagState) => void): void;
    record(stepId: string, result: 'pass' | 'fail' | 'skip', detail?: string): Promise<void>;
    runAuto(): Promise<void>;
    save(): Promise<string>;
  };
}

// ----------------------------------------------------------------- app commands (added by app-shell)
// The `blueline` command launches the app with `--bl-cmd=<AppCommand>`, `--bl-args=<base64url JSON>` and,
// for map and check, `--bl-out=<file>` (6.1; docs/ARCHITECTURE.md, Commands).

export type AppCommand = 'open' | 'map' | 'check';

/** `--bl-args` of `open`: absolute paths (the CLI resolves them against its own working directory). */
export interface OpenArgs {
  files: string[];
  protected: boolean;
}

/** `--bl-args` of `map` (section 10, Phase 0: `blueline map deck.html --report [--json] [--min-coverage 0.95]`). */
export interface MapArgs {
  /** Absolute path of the deck. */
  deck: string;
  report: boolean;
  json: boolean;
  /** 0..1, or null when not given. */
  minCoverage: number | null;
}

/** `--bl-args` of `check` (section 10, Diagnostics window). */
export interface CheckArgs {
  /** Run only the automatic checks and exit (no guided steps). */
  auto: boolean;
}

/**
 * What a `map` or `check` run writes to `--bl-out` (JSON). The CLI prints `text`, or `json` with `--json`,
 * and exits with the app's exit code.
 */
export interface CommandResult {
  command: 'map' | 'check';
  exitCode: number;
  text: string;
  json: unknown;
}
