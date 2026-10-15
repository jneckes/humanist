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
  | { type: 'scroll-blocks' }; // scrolling documents: the blocks to scrollIntoView

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

export interface WalkNode {
  /** Unique per page load; the walker counts each node once across slides by this key. */
  key: number;
  locator: NodeLocator;
  node: DomTextNode;
  rect: { x: number; y: number; w: number; h: number };
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
  slide: { current: number; count: number; kind: SlideState['kind'] } | null;
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
}

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
  diag: {
    getState(): Promise<DiagState>;
    onState(cb: (s: DiagState) => void): void;
    record(stepId: string, result: 'pass' | 'fail' | 'skip', detail?: string): Promise<void>;
    runAuto(): Promise<void>;
    save(): Promise<string>;
  };
}
