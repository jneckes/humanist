// The Diagnostics window (Help › Run Diagnostics; `blueline check`; section 10, Phase 0) and its automatic
// checks (`blueline check --auto`, used in CI).
//
// The window: the diagnostics shell page (app://shell/diagnostics.html: guided steps with Pass and Fail
// buttons, the event log, Save) and a deck view on the bundled reveal.js fixture
// (dist/assets/diagnostics-deck/index.html), with the deck preload in `--bl-mode=diagnostics`: the real key
// router, mode switching (Cmd+1/2/3, taken in before-input-event as in a document window), the note card,
// the ink layer and the editable heading that logs every beforeinput.inputType. Notes stay in memory.
//
// Automatic checks (each also runs from the window's "Run automatic checks"):
//   key-order         the preload's capture listener runs before the deck's own (6.2)
//   stop-propagation  stopImmediatePropagation() from the isolated world stops the deck's listeners (6.2)
//   app-chords        app chords still work on a page that preventDefault()s every keydown (6.2)
//   offscreen-keys    sendInputEvent reaches an offscreen deck while the visible window keeps focus (6.7)
//   capture-size      a 1600×900 capture at 2x is 3200×1800 (6.7)
//   fit-zoom          CSS zoom vs webContents.setZoomFactor for Fit, compared with the layout at the design
//                     size; records which matches (6.9)
// Results go to <userData>/check.json: {app, electron, chrome, os, at, steps[], log[]}.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, BrowserWindow, nativeTheme, session, WebContentsView, type Input, type WebContents } from 'electron';
import {
  MainToDeck,
  MainToShell,
  ShellToMain,
  type AppMode,
  type AppModeUpdate,
  type Capabilities,
  type CommandResult,
  type DeckInit,
  type DiagEvent,
  type DiagState,
  type DiagStep,
  type NotesUpdate,
  type SlideState,
} from '@blueline/core/ipc';
import { buildMap, toClientMap } from '@blueline/core/mapper';
import { buildServedCopy } from '@blueline/core/served';
import { decodeDeck, encodeDeck, encodeLatin1 } from '@blueline/core/text';
import type { DeckMap, Person } from '@blueline/core/types';
import { servedDirs, type ServedDirs } from './app-paths';
import { atomicWriteFile, readRegularFile, sha256Hex } from './atomic-write';
import { attachDeckView, shellRouter } from './channels';
import { matchAppChord, SwallowedKeys } from './chords';
import { newDocumentId } from './documents';
import { loadEditorDetailed } from './editor-loader';
import { validateDiagRecord, validateNoArgs, type ShellSender } from './ipc-guard';
import { DEFAULT_ALLOWLIST, pickClosedLoopbackPort } from './network-policy';
import { NotesStore } from './notes';
import { deckUrl, installDeckProtocol, installShellProtocol, SHELL_ORIGIN, type ServedDoc } from './protocol';
import { DEFAULT_VIEWPORT, RENDER_WORLD_ID, RenderView, type Viewport } from './render-service';
import { emptySession } from './session-store';
import { installDeckSessionPolicy, installDeckWebContentsPolicy, installShellPolicy, type DeckSessionHandle } from './trust-hooks';

// ------------------------------------------------------------------------------------------- layout and steps

/** The shell's header height and right panel width (diagnostics.css uses the same numbers). */
export const DIAG_HEADER = 48;
export const DIAG_PANEL = 420;
const SHELL_PARTITION = 'shell';
const SHELL_KEY = 'diagnostics';
const LOG_LIMIT = 2000;
const CHECK_TIMEOUT_MS = 45_000;
/** A Fit method "matches" when at most this share of pixels differs from the design-size render. */
export const FIT_MATCH_SHARE = 0.01;
/** A pixel differs when any channel differs by more than this. */
const PIXEL_TOLERANCE = 48;

type StepDef = Omit<DiagStep, 'result' | 'detail'>;

export const DIAG_STEPS: readonly StepDef[] = Object.freeze([
  {
    id: 'key-order',
    auto: true,
    title: "The preload's capture listener runs before the deck's own",
    instructions: "Automatic. A trusted key goes to a Diagnostics deck in Read; the deck's own capture listeners must not have seen it yet when the preload's router runs (6.2).",
  },
  {
    id: 'stop-propagation',
    auto: true,
    title: "stopImmediatePropagation() from the isolated world stops the deck's listeners",
    instructions: "Automatic. In Review, the router consumes V (a shortcut); the deck's own keydown listeners must never see it (6.2).",
  },
  {
    id: 'app-chords',
    auto: true,
    title: 'App chords work on a page that calls preventDefault() on every keydown',
    instructions: 'Automatic. On such a page, the Review chord switches the mode and never reaches the page; ArrowRight still reaches it (6.2).',
  },
  {
    id: 'offscreen-keys',
    auto: true,
    title: 'Keys reach an offscreen deck while the visible window keeps focus',
    instructions: 'Automatic. The render service presses ArrowRight with sendInputEvent in an offscreen render window; the deck must move, and the visible window must keep focus (6.7 Index replay).',
  },
  {
    id: 'capture-size',
    auto: true,
    title: 'A 1600×900 capture at 2x is 3200×1800',
    instructions: 'Automatic. capturePage of a hidden offscreen render window, 1600×900 at deviceScaleFactor 2 (6.7).',
  },
  {
    id: 'fit-zoom',
    auto: true,
    title: 'Fit: CSS zoom or setZoomFactor, whichever matches the layout at the design size',
    instructions: 'Automatic. A 1600×900 page is rendered at half size with CSS zoom on its root and with webContents.setZoomFactor, and each is compared pixel by pixel with the page at its design size (6.9).',
  },
  {
    id: 'wispr-card',
    auto: false,
    title: 'Wispr Flow text lands in the note card',
    instructions: 'Press Cmd+2 (Review). Point at the slide and press N to open a note card. Dictate a sentence with Wispr Flow. Pass if the words appear in the card (the log shows a paste: Wispr pastes through the clipboard).',
  },
  {
    id: 'wispr-heading',
    auto: false,
    title: 'Wispr Flow text lands in the heading',
    instructions: 'Press Cmd+1 (Read) and go to the first slide. Click the heading "Strategy offsite, day one" so it becomes editable, and dictate a few words. Pass if they land in the heading (expect beforeinput insertFromPaste and a paste in the log). Esc puts the heading back.',
  },
  {
    id: 'dictate-body-read',
    auto: false,
    title: 'Dictating on the page body in Read changes nothing',
    instructions: 'Press Cmd+1 (Read). Click an empty part of the slide so no text field has focus, and dictate a sentence. Pass if the mode stays Read, no shortcut fires and the deck does not move.',
  },
  {
    id: 'dictate-body-review',
    auto: false,
    title: 'Dictating on the page body in Review changes nothing',
    instructions: 'Press Cmd+2 (Review), and V if a drawing tool is on. Click an empty part of the slide so no text field has focus, and dictate a sentence. Pass if the mode stays Review, no shortcut fires and the deck does not move.',
  },
  {
    id: 'dictate-body-edit',
    auto: false,
    title: 'Dictating on the page body in Edit changes nothing',
    instructions: 'Press Cmd+3 (Edit). Click an empty part of the slide so no text field has focus, and dictate a sentence. Pass if the mode stays Edit, no shortcut fires and the deck does not move.',
  },
  {
    id: 'dictate-strokes',
    auto: false,
    title: 'Dictation with two strokes while speaking lands on one note',
    instructions: 'Press Cmd+2 (Review), then 1 (Pen). Point at the slide, press N to open a card and click into it. Start dictating; while you speak, draw two strokes on the slide; then stop. Pass if the text is in the card and the card shows marks ① and ② on the same note.',
  },
]);

// ------------------------------------------------------------------------------------------- served pages

/**
 * A page Blueline itself ships or writes (the Diagnostics deck, the generated check pages), served like a
 * document: its stamped copy at blueline://<docId>/<file name>, sibling files from the `-files` host.
 * Trusted (it is Blueline's own file), in a non-persistent partition of its own.
 */
class AssetDoc implements ServedDoc {
  readonly docId = newDocumentId();
  readonly fileName: string;
  readonly folderReal: string;
  readonly partition: string;
  private loaded: { body: Uint8Array; utf8: boolean; map: DeckMap; version: string } | null = null;

  constructor(readonly realpath: string) {
    this.fileName = path.basename(realpath);
    this.folderReal = path.dirname(realpath);
    this.partition = `deck-${this.docId}`;
  }

  trust(): 'trusted' {
    return 'trusted';
  }

  networkAllowed(): boolean {
    return false;
  }

  async load(): Promise<{ map: DeckMap; version: string }> {
    if (!this.loaded) {
      const bytes = await readRegularFile(this.realpath);
      const d = decodeDeck(bytes);
      const version = sha256Hex(bytes);
      const map = buildMap(d.src, { version, utf8: d.utf8 });
      const served = buildServedCopy(d.src, map, { protected: false });
      this.loaded = { body: d.utf8 ? encodeDeck(served) : encodeLatin1(served), utf8: d.utf8, map, version };
    }
    return { map: this.loaded.map, version: this.loaded.version };
  }

  async documentBody(): Promise<{ body: Uint8Array; utf8: boolean }> {
    await this.load();
    return { body: this.loaded!.body.slice(), utf8: this.loaded!.utf8 };
  }
}

/** Installs the blueline:// handler and the session policy on a page's own partition. */
async function servePartition(doc: AssetDoc, blockPort: number): Promise<DeckSessionHandle> {
  const ses = session.fromPartition(doc.partition);
  installDeckProtocol(ses, (id) => (id === doc.docId ? doc : undefined));
  const h = installDeckSessionPolicy(ses, {
    trust: () => 'trusted',
    networkAllowed: () => false,
    strict: () => false,
    allowlist: () => DEFAULT_ALLOWLIST,
    blockPort,
  });
  await h.ready;
  return h;
}

/** A page with a capture listener that preventDefault()s every keydown and records what reached it (6.2). */
const CHORD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Blueline check: a page that swallows keys</title>
<style>html,body{margin:0;height:100%;font:24px/1.4 system-ui,sans-serif}main{padding:48px}</style></head>
<body><main><h1>This page calls preventDefault() on every keydown</h1><p>App chords must still work.</p></main>
<script>
(function(){var root=document.documentElement,seen=[];
function chord(e){return (e.metaKey?'Meta+':'')+(e.ctrlKey?'Control+':'')+(e.altKey?'Alt+':'')+(e.shiftKey?'Shift+':'')+e.key;}
window.addEventListener('keydown',function(e){e.preventDefault();seen.push(chord(e));if(seen.length>50)seen.shift();
root.dataset.pageKeys=seen.join(' ');root.dataset.pageKeyCount=String(Number(root.dataset.pageKeyCount||0)+1);},true);})();
</script></body></html>
`;

/**
 * A 1600×900 design whose layout depends on the viewport (vw and vh units, a width media query) as well as on
 * fixed px and percentages, so CSS zoom and setZoomFactor give different layouts unless the viewport the
 * page sees is the design size (6.9 Fit).
 */
const FIT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Blueline check: Fit</title>
<style>
html,body{margin:0;background:#ffffff;overflow:hidden}
div{position:absolute}
.vw{left:0;top:0;width:50vw;height:120px;background:#c0392b}
.px{left:100px;top:200px;width:400px;height:200px;background:#2471a3}
.pct{left:10%;top:450px;width:30%;height:100px;background:#229954}
.mq{right:100px;top:200px;width:300px;height:300px;background:#7d3c98}
@media (max-width:1000px){.mq{width:100px;background:#f1c40f}}
.vh{left:700px;bottom:5vh;width:200px;height:20vh;background:#e67e22}
</style></head>
<body><div class="vw"></div><div class="px"></div><div class="pct"></div><div class="mq"></div><div class="vh"></div></body></html>
`;

// ------------------------------------------------------------------------------------------- recorder

interface LogEntry {
  at: string;
  event: string;
  data: Record<string, unknown>;
}

/** The check.json written to app data (section 10, Diagnostics window). */
export interface CheckJson {
  app: string;
  electron: string;
  chrome: string;
  os: string;
  at: string;
  steps: DiagStep[];
  log: LogEntry[];
}

/** Steps, results and the log of one Diagnostics session. */
export class DiagRecorder {
  readonly steps: DiagStep[];
  readonly log: LogEntry[] = [];
  savedTo: string | null = null;
  appMode: AppMode = 'read';
  running = false;
  /** When the user last recorded a guided step: its evidence is the log since then. */
  private sinceMs = Date.now();
  onChange: () => void = () => undefined;

  constructor(opts: { autoOnly: boolean }) {
    this.steps = DIAG_STEPS.filter((s) => !opts.autoOnly || s.auto).map((s) => ({ ...s, result: 'pending' as const }));
  }

  logEvent(event: string, data: Record<string, unknown>): void {
    this.log.push({ at: new Date().toISOString(), event, data });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    this.onChange();
  }

  setResult(id: string, result: DiagStep['result'], detail?: string): void {
    const s = this.steps.find((x) => x.id === id);
    if (!s) return;
    s.result = result;
    if (detail !== undefined) s.detail = detail.slice(0, 4000);
    this.logEvent('step', { id, result, detail: (detail ?? '').slice(0, 1000) });
  }

  /** The log entries since the last guided record (the evidence of the step the user is recording now). */
  recent(): LogEntry[] {
    const since = this.sinceMs;
    return this.log.filter((e) => Date.parse(e.at) >= since);
  }

  markRecorded(): void {
    this.sinceMs = Date.now();
  }

  state(): DiagState {
    return {
      steps: this.steps.map((s) => ({ ...s })),
      log: this.log.slice(-300),
      savedTo: this.savedTo,
      appMode: this.appMode,
      running: this.running,
    };
  }

  checkJson(): CheckJson {
    return {
      app: `${app.getName()} ${app.getVersion()}`,
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      os: `${process.platform} ${os.release()} (${process.arch})${typeof os.version === 'function' ? ` ${os.version()}` : ''}`,
      at: new Date().toISOString(),
      steps: this.steps.map((s) => ({ ...s })),
      log: this.log.slice(),
    };
  }

  /** Writes check.json to app data (atomically, private) and returns its path. */
  async save(): Promise<string> {
    const file = path.join(app.getPath('userData'), 'check.json');
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await atomicWriteFile(file, new TextEncoder().encode(JSON.stringify(this.checkJson(), null, 2) + '\n'), { newFileMode: 0o600 });
    this.savedTo = file;
    this.onChange();
    return file;
  }
}

/** Evidence from the log for a guided step, appended to what the user records. */
export function evidenceFor(stepId: string, recent: readonly LogEntry[], extra: { mode: AppMode; lastNote: { text: number; marks: number } | null }): string {
  const count = (ev: string, pred: (d: Record<string, unknown>) => boolean = () => true) => recent.filter((e) => e.event === ev && pred(e.data)).length;
  const inputTypes = [...new Set(recent.filter((e) => e.event === 'beforeinput').map((e) => String(e.data.inputType)))];
  switch (stepId) {
    case 'wispr-card':
      return `${count('paste')} paste, ${count('card-input')} card-input event(s)`;
    case 'wispr-heading':
      return `beforeinput: ${inputTypes.join(', ') || 'none'}; ${count('paste')} paste, ${count('heading-input')} heading-input event(s)`;
    case 'dictate-body-read':
    case 'dictate-body-review':
    case 'dictate-body-edit': {
      // Only what happened after the user's own setup keys (the mode chord, a tool key) can be the
      // dictation's doing: a dictation in each mode changes no mode, fires no shortcut, does not move the deck.
      // A switch main makes for Esc-Esc on the page is not a setup key.
      let from = 0;
      recent.forEach((e, i) => {
        if (e.event === 'app-chord' || (e.event === 'app-mode' && e.data.cause !== 'esc') || (e.event === 'shortcut' && String(e.data.action).startsWith('tool-'))) from = i + 1;
      });
      const after = recent.slice(from);
      const n = (ev: string) => after.filter((e) => e.event === ev).length;
      // The preload's own report of a switch main made (cause 'main', or 'init' on the handshake) arrives
      // over IPC after main's app-mode entry for that switch: it is the setup chord's echo, not a new change.
      const modeChanges = after.filter((e) => e.event === 'mode-change' && e.data.cause !== 'main' && e.data.cause !== 'init').length;
      const want = stepId.slice('dictate-body-'.length);
      const modeNote = extra.mode === want ? `mode ${extra.mode}` : `mode ${extra.mode}, NOT ${want}`;
      return `${modeNote}; after the setup keys: ${modeChanges} mode change(s), ${n('shortcut')} shortcut(s), ${n('deck-moved')} deck move(s), ${n('paste')} paste`;
    }
    case 'dictate-strokes':
      return extra.lastNote
        ? `newest note: ${extra.lastNote.text} characters, ${extra.lastNote.marks} mark(s); ${count('mark-added')} mark-added event(s), ${count('paste')} paste`
        : `no note yet; ${count('mark-added')} mark-added event(s)`;
    default:
      return '';
  }
}

// ------------------------------------------------------------------------------------------- deck views

const ME: Person = { id: 'diagnostics-0000', name: 'Diagnostics', color: '#2563eb' };

/** Runs JavaScript in main's own isolated world of a deck view (reads only: the page cannot see it). */
async function isolated<T>(wc: WebContents, code: string, fallback: T, ms = 2000): Promise<T> {
  if (wc.isDestroyed()) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      wc.executeJavaScriptInIsolatedWorld(RENDER_WORLD_ID, [{ code }]),
      new Promise<T>((r) => {
        timer = setTimeout(() => r(fallback), ms);
      }),
    ])) as T;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

interface DiagDeckDeps {
  capabilities: Capabilities;
  rec: DiagRecorder;
  /** Log events into the recorder (the window's deck); a check deck keeps its events to itself. */
  logToRecorder: boolean;
  platform: NodeJS.Platform;
}

/**
 * One deck view in `--bl-mode=diagnostics`: the handshake, the slide reports, the note card's NoteOps (in
 * memory), the Esc-Esc return to Read, DiagEvents, and the app chords in before-input-event with the same
 * matcher as a document window (6.2).
 */
class DiagDeck {
  mode: AppMode = 'read';
  private textField = false;
  private slides: SlideState | null = null;
  private readonly swallowed = new SwallowedKeys();
  readonly notes: NotesStore;
  private readonly waiters = new Set<{ pred: (e: DiagEvent) => boolean; done: (e: DiagEvent | null) => void }>();
  private version = '';
  private inits = 0;
  readonly events: DiagEvent[] = [];
  onMode: (m: AppMode) => void = () => undefined;

  constructor(
    readonly wc: WebContents,
    readonly doc: AssetDoc,
    private readonly deps: DiagDeckDeps,
  ) {
    const s = emptySession({ path: doc.realpath, realpath: doc.realpath, fileKey: '0000000000000000', sha256: '', title: 'Diagnostics' });
    this.notes = new NotesStore(s, {
      me: () => ME,
      now: () => new Date().toISOString(),
      version: () => this.version,
      slides: () => this.slides,
    });
    attachDeckView(wc, { docId: doc.docId, kind: 'diagnostics' }, {
      ready: () => void this.sendInit(),
      focus: (_f, p) => {
        this.textField = p.textField;
      },
      slides: (_f, p) => {
        this.slides = p;
      },
      mode: (_f, p) => {
        if (p.mode === 'read') this.setMode('read', 'esc');
      },
      note: (_f, op) => this.onNoteOp(op),
      diag: (_f, e) => this.onDiag(e),
    });
    installDeckWebContentsPolicy(wc, {
      docId: doc.docId,
      folderReal: doc.folderReal,
      isProtected: () => false,
      networkOpen: () => false,
      onUserLink: () => undefined,
      openLocalHtml: () => undefined,
      onBlocked: (url, why) => this.log('blocked', { url: url.slice(0, 200), why }),
    });
    wc.on('before-input-event', (event, input) => this.onInput(event, input));
  }

  get handshakes(): number {
    return this.inits;
  }

  private log(event: string, data: Record<string, unknown>): void {
    if (this.deps.logToRecorder) this.deps.rec.logEvent(event, data);
  }

  async load(): Promise<void> {
    const { version } = await this.doc.load();
    this.version = version;
    await this.wc.loadURL(deckUrl(this.doc.docId, this.doc.fileName));
  }

  private async sendInit(): Promise<void> {
    const { map } = await this.doc.load();
    const init: DeckInit = {
      mode: 'diagnostics',
      appMode: this.mode,
      trust: 'trusted',
      capabilities: { ...this.deps.capabilities },
      // Diagnostics writes nothing: the heading edit is a probe of input events only.
      editingAllowed: true,
      map: map.utf8 ? toClientMap(map) : null,
      notes: this.notes.notes.slice(),
      userName: ME.name,
    };
    if (!this.wc.isDestroyed()) this.wc.send(MainToDeck.init, init);
    this.inits++;
  }

  /** Switches the app mode, as a document window does for Cmd+1/2/3 (6.2). Diagnostics allows all three. */
  setMode(mode: AppMode, cause: string): void {
    if (mode === this.mode) return;
    const from = this.mode;
    this.mode = mode;
    const update: AppModeUpdate = { appMode: mode, editingAllowed: true };
    if (!this.wc.isDestroyed()) this.wc.send(MainToDeck.appMode, update);
    this.log('app-mode', { from, to: mode, cause });
    this.onMode(mode);
  }

  private onInput(event: Electron.Event, input: Input): void {
    if (this.swallowed.takeKeyUp(input)) {
      event.preventDefault();
      return;
    }
    const action = matchAppChord(input, { textField: this.textField, platform: this.deps.platform });
    if (!action) return;
    event.preventDefault();
    this.swallowed.add(input.code);
    if (input.isAutoRepeat) return;
    // Every app chord is taken from the page and logged (6.2); the mode chords also switch the mode. The
    // others (Present, Find, Save, undo outside a text field…) have nothing to act on in Diagnostics.
    this.log('app-chord', { action, key: input.key, code: input.code });
    if (action === 'mode-read') this.setMode('read', 'chord');
    else if (action === 'mode-review') this.setMode('review', 'chord');
    else if (action === 'mode-edit') this.setMode('edit', 'chord');
  }

  private onNoteOp(op: Parameters<NotesStore['apply']>[0]): void {
    const r = this.notes.apply(op);
    const id = op.op === 'create' ? (r.ok ? r.created?.id ?? null : null) : op.id;
    const note = id ? this.notes.find(id) : undefined;
    this.log('note', { op: op.op, ok: r.ok, id, why: r.ok ? null : r.why, marks: note ? note.marks.length : null, text: note ? note.text.length : null });
    const update: NotesUpdate = { notes: this.notes.notes.slice() };
    if (r.ok && r.created) update.created = [r.created];
    if (!this.wc.isDestroyed()) this.wc.send(MainToDeck.notes, update);
  }

  private onDiag(e: DiagEvent): void {
    this.events.push(e);
    if (this.events.length > 500) this.events.shift();
    this.log(e.event, e.data);
    for (const w of [...this.waiters]) {
      if (w.pred(e)) {
        this.waiters.delete(w);
        w.done(e);
      }
    }
  }

  /** The next DiagEvent matching `pred`, or null after `ms`. */
  waitFor(pred: (e: DiagEvent) => boolean, ms: number): Promise<DiagEvent | null> {
    return new Promise((resolve) => {
      const w = {
        pred,
        done: (e: DiagEvent | null) => {
          clearTimeout(timer);
          resolve(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(w);
        resolve(null);
      }, ms);
      this.waiters.add(w);
    });
  }

  /** A trusted key press (keyDown, keyUp) with Electron Accelerator names. */
  press(keyCode: string, modifiers: ('control' | 'meta' | 'shift' | 'alt')[] = []): void {
    if (this.wc.isDestroyed()) return;
    this.wc.focus();
    this.wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    this.wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }

  /** Waits until the preload has done its handshake (ready → init). */
  async handshake(ms = 5000): Promise<boolean> {
    const end = Date.now() + ms;
    while (this.inits === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    // The init is applied asynchronously in the preload; give it a moment before keys arrive.
    await new Promise((r) => setTimeout(r, 150));
    return this.inits > 0;
  }

  lastNote(): { text: number; marks: number } | null {
    const n = this.notes.notes[this.notes.notes.length - 1];
    return n ? { text: n.text.length, marks: n.marks.length } : null;
  }
}

// ------------------------------------------------------------------------------------------- automatic checks

interface CheckEnv {
  rec: DiagRecorder;
  deckFile: string;
  preload: string;
  capabilities: Capabilities;
  blockPort: number;
  /** The visible window that must keep focus (the Diagnostics window, or a small one in --auto). */
  visible: BrowserWindow;
  tmpDir: string;
  platform: NodeJS.Platform;
  log(msg: string): void;
}

type CheckOutcome = { result: 'pass' | 'fail'; detail: string; data?: Record<string, unknown> };

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** An offscreen BrowserWindow holding a deck view in diagnostics mode, for checks that must not disturb the user's view. */
function offscreenDeckWindow(partition: string, preload: string, vp: Viewport): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: vp.w,
    height: vp.h,
    useContentSize: true,
    enableLargerThanScreen: true,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      offscreen: { deviceScaleFactor: vp.dpr },
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition,
      preload,
      additionalArguments: ['--bl-mode=diagnostics'],
      backgroundThrottling: false,
      navigateOnDragDrop: false,
      // Hidden: a dialog could never be answered (see render-service.ts).
      disableDialogs: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
}

/** key-order and stop-propagation (6.2), on an offscreen Diagnostics deck with the real key router. */
async function checkKeyRouting(env: CheckEnv): Promise<{ order: CheckOutcome; stop: CheckOutcome }> {
  const doc = new AssetDoc(env.deckFile);
  const policy = await servePartition(doc, env.blockPort);
  const win = offscreenDeckWindow(doc.partition, env.preload, { w: 1280, h: 720, dpr: 1 });
  try {
    const deck = new DiagDeck(win.webContents, doc, { capabilities: env.capabilities, rec: env.rec, logToRecorder: false, platform: env.platform });
    await deck.load();
    if (!(await deck.handshake())) {
      const f: CheckOutcome = { result: 'fail', detail: 'the Diagnostics deck preload never completed its handshake' };
      return { order: f, stop: f };
    }
    await delay(300);
    // A key the reveal.js deck does nothing with (Shift), in Read: the router lets it through to the deck.
    let wait = deck.waitFor((e) => e.event === 'key-order' && e.data.key === 'Shift', 3000);
    deck.press('Shift');
    const ko = await wait;
    const order: CheckOutcome = !ko
      ? { result: 'fail', detail: 'no key-order event: the key did not reach the preload' }
      : ko.data.first === 'preload'
        ? { result: 'pass', detail: "the preload's capture listener ran first; the deck's own listeners saw the key after it", data: { ...ko.data } }
        : { result: 'fail', detail: `first: ${String(ko.data.first)} (the deck's listeners ran before the preload, or the deck has no key log)`, data: { ...ko.data } };
    // V in Review: a shortcut the router consumes with stopImmediatePropagation() and preventDefault().
    deck.setMode('review', 'check');
    await delay(200);
    wait = deck.waitFor((e) => e.event === 'stop-propagation' && e.data.code === 'KeyV', 3000);
    deck.press('V');
    const sp = await wait;
    const stop: CheckOutcome = !sp
      ? { result: 'fail', detail: 'no stop-propagation event: V was not consumed by the router in Review' }
      : sp.data.pageListenerRan === false
        ? { result: 'pass', detail: "the deck's own keydown listeners never saw the consumed key", data: { ...sp.data } }
        : { result: 'fail', detail: `pageListenerRan: ${String(sp.data.pageListenerRan)}`, data: { ...sp.data } };
    return { order, stop };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    policy.dispose();
  }
}

/** app-chords (6.2): main takes app chords in before-input-event, so a page that swallows every key cannot block them. */
async function checkAppChords(env: CheckEnv): Promise<CheckOutcome> {
  const file = path.join(env.tmpDir, 'chords.html');
  await fs.promises.writeFile(file, CHORD_PAGE, { mode: 0o600 });
  const doc = new AssetDoc(fs.realpathSync.native(file));
  const policy = await servePartition(doc, env.blockPort);
  const win = offscreenDeckWindow(doc.partition, env.preload, { w: 1280, h: 720, dpr: 1 });
  try {
    const wc = win.webContents;
    const deck = new DiagDeck(wc, doc, { capabilities: env.capabilities, rec: env.rec, logToRecorder: false, platform: env.platform });
    await deck.load();
    if (!(await deck.handshake())) return { result: 'fail', detail: 'the deck preload never completed its handshake' };
    const cmd = env.platform === 'darwin' ? 'meta' : 'control';
    const chordName = env.platform === 'darwin' ? 'Cmd+2' : 'Ctrl+2';
    deck.press('2', [cmd]);
    await delay(300);
    const mode = deck.mode;
    deck.press('Right');
    await delay(300);
    const keys = (await isolated<unknown>(wc, '(function(){var v=document.documentElement.dataset.pageKeys;return typeof v==="string"?v:"";})()', '')) as string;
    const seen = typeof keys === 'string' ? keys.split(' ').filter(Boolean) : [];
    const leaked = seen.some((k) => /^(Meta|Control)\+/.test(k) && k.endsWith('+2'));
    const arrow = seen.includes('ArrowRight');
    deck.press('1', [cmd]);
    await delay(200);
    const data = { modeAfterChord: mode, pageKeys: seen.join(' '), modeAfterRead: deck.mode };
    if (mode === 'review' && !leaked && arrow && deck.mode === 'read') {
      return { result: 'pass', detail: `${chordName} switched to Review and never reached the page; ArrowRight did`, data };
    }
    const why: string[] = [];
    if (mode !== 'review') why.push(`${chordName} did not switch to Review (mode ${mode})`);
    if (leaked) why.push(`the page saw the chord (${seen.join(' ')})`);
    if (!arrow) why.push('ArrowRight did not reach the page');
    if (deck.mode !== 'read') why.push('the Read chord did not switch back');
    return { result: 'fail', detail: why.join('; '), data };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    policy.dispose();
  }
}

/** offscreen-keys and capture-size (6.7), with the render service itself. */
async function checkRenderService(env: CheckEnv): Promise<{ keys: CheckOutcome; capture: CheckOutcome }> {
  const doc = new AssetDoc(env.deckFile);
  const policy = await servePartition(doc, env.blockPort);
  const view = RenderView.create({
    partition: doc.partition,
    preload: env.preload,
    viewport: { ...DEFAULT_VIEWPORT },
    folderReal: doc.folderReal,
    isProtected: () => false,
    networkOpen: () => false,
    log: env.log,
  });
  try {
    await view.load({ docId: doc.docId, fileName: doc.fileName });
    await view.waitStable();
    const det = await view.detect();
    const visible = env.visible;
    if (!visible.isDestroyed()) {
      visible.focus();
      for (let i = 0; i < 20 && !visible.isFocused(); i++) await delay(50);
    }
    const focusedBefore = !visible.isDestroyed() && visible.isFocused();
    const press = await view.pressKey('ArrowRight');
    const focusedAfter = !visible.isDestroyed() && visible.isFocused();
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const keyData = {
      kind: det.kind,
      from: press.from,
      to: press.to,
      via: press.via,
      delivered: press.delivered,
      focusedBefore,
      focusedAfter,
      focusedIsVisible: focusedWindow === visible,
    };
    let keys: CheckOutcome;
    if (press.via === 'input' && press.delivered === true && press.moved && focusedBefore && focusedAfter) {
      keys = { result: 'pass', detail: `ArrowRight (sendInputEvent "Right") moved the offscreen deck from slide ${press.from + 1} to ${press.to + 1}; the visible window kept focus`, data: keyData };
    } else {
      const why: string[] = [];
      if (press.via !== 'input' || press.delivered !== true) why.push('trusted keys did not reach the offscreen deck (the synthetic fallback is in use)');
      if (!press.moved) why.push('the deck did not move');
      if (!focusedBefore) why.push('the visible window never had focus, so the check could not hold it');
      else if (!focusedAfter) why.push('the visible window lost focus');
      keys = { result: 'fail', detail: why.join('; '), data: keyData };
    }
    await view.settle();
    const cap = await view.capture();
    const capData = { width: cap.width, height: cap.height, expected: `${cap.expected.width}x${cap.expected.height}`, empty: cap.empty };
    const capture: CheckOutcome =
      cap.sizeOk && !cap.empty
        ? { result: 'pass', detail: `${cap.width}×${cap.height}`, data: capData }
        : { result: 'fail', detail: `${cap.width}×${cap.height}${cap.empty ? ' (empty)' : ''}, expected ${cap.expected.width}×${cap.expected.height}`, data: capData };
    return { keys, capture };
  } finally {
    view.close();
    policy.dispose();
  }
}

/** Share of pixels (BGRA bitmaps of equal size) that differ by more than PIXEL_TOLERANCE in any channel. */
export function differingShare(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let diff = 0;
  const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > PIXEL_TOLERANCE || Math.abs(a[i + 1] - b[i + 1]) > PIXEL_TOLERANCE || Math.abs(a[i + 2] - b[i + 2]) > PIXEL_TOLERANCE) diff++;
  }
  return diff / n;
}

/** fit-zoom (6.9): which of CSS zoom and setZoomFactor reproduces the layout at the design size. */
async function checkFitZoom(env: CheckEnv): Promise<CheckOutcome> {
  const file = path.join(env.tmpDir, 'fit.html');
  await fs.promises.writeFile(file, FIT_PAGE, { mode: 0o600 });
  const real = fs.realpathSync.native(file);
  const design = { w: 1600, h: 900 };
  const scale = 0.5;
  const shot = async (vp: Viewport, how: 'reference' | 'setZoomFactor' | 'css-zoom'): Promise<{ bitmap: Uint8Array; w: number; h: number; inner: string }> => {
    const doc = new AssetDoc(real);
    const policy = await servePartition(doc, env.blockPort);
    const view = RenderView.create({ partition: doc.partition, preload: env.preload, viewport: vp, folderReal: doc.folderReal, isProtected: () => false, networkOpen: () => false, log: env.log });
    try {
      await view.load({ docId: doc.docId, fileName: doc.fileName });
      if (how === 'setZoomFactor') view.wc.setZoomFactor(scale);
      else if (how === 'css-zoom') await view.setRootZoom(scale);
      await view.waitStable();
      view.wc.invalidate();
      await view.waitStable();
      const inner = await isolated<string>(view.wc, '(function(){return innerWidth+"x"+innerHeight})()', '?');
      const cap = await view.capture();
      let img = cap.image;
      const target = { width: design.w, height: design.h };
      if (cap.width !== target.width || cap.height !== target.height) img = img.resize(target);
      return { bitmap: new Uint8Array(img.toBitmap()), w: target.width, h: target.height, inner };
    } finally {
      view.close();
      policy.dispose();
    }
  };
  const ref = await shot({ w: design.w, h: design.h, dpr: 1 }, 'reference');
  const small = { w: design.w * scale, h: design.h * scale, dpr: 1 / scale };
  const zf = await shot(small, 'setZoomFactor');
  const cz = await shot(small, 'css-zoom');
  const zfShare = differingShare(ref.bitmap, zf.bitmap);
  const czShare = differingShare(ref.bitmap, cz.bitmap);
  const zfOk = zfShare <= FIT_MATCH_SHARE;
  const czOk = czShare <= FIT_MATCH_SHARE;
  const matches = zfOk && czOk ? 'both' : zfOk ? 'setZoomFactor' : czOk ? 'css-zoom' : 'neither';
  const pctOf = (x: number) => `${(x * 100).toFixed(2)}%`;
  const data = {
    matches,
    setZoomFactorDiffering: Math.round(zfShare * 10000) / 10000,
    cssZoomDiffering: Math.round(czShare * 10000) / 10000,
    viewportSeenWithSetZoomFactor: zf.inner,
    viewportSeenWithCssZoom: cz.inner,
  };
  const detail =
    `pixels differing from the design-size render: setZoomFactor ${pctOf(zfShare)} (page viewport ${zf.inner}), ` +
    `CSS zoom ${pctOf(czShare)} (page viewport ${cz.inner}); matches: ${matches}`;
  return { result: matches === 'neither' ? 'fail' : 'pass', detail, data };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_r, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    }),
  ]);
}

/** Runs every automatic check and records each result. Never throws: a check that throws fails. */
export async function runAutoChecks(env: CheckEnv): Promise<void> {
  const rec = env.rec;
  rec.running = true;
  for (const s of rec.steps) if (s.auto) rec.setResult(s.id, 'pending', '');
  const record = (id: string, o: CheckOutcome) => {
    rec.setResult(id, o.result, o.detail);
    if (o.data) rec.logEvent(`check:${id}`, o.data);
  };
  const failAll = (ids: string[], e: unknown) => {
    for (const id of ids) rec.setResult(id, 'fail', `the check failed to run: ${e instanceof Error ? e.message : String(e)}`);
  };
  try {
    try {
      const r = await withTimeout(checkKeyRouting(env), CHECK_TIMEOUT_MS, 'key routing');
      record('key-order', r.order);
      record('stop-propagation', r.stop);
    } catch (e) {
      failAll(['key-order', 'stop-propagation'], e);
    }
    try {
      record('app-chords', await withTimeout(checkAppChords(env), CHECK_TIMEOUT_MS, 'app chords'));
    } catch (e) {
      failAll(['app-chords'], e);
    }
    try {
      const r = await withTimeout(checkRenderService(env), CHECK_TIMEOUT_MS, 'render service');
      record('offscreen-keys', r.keys);
      record('capture-size', r.capture);
    } catch (e) {
      failAll(['offscreen-keys', 'capture-size'], e);
    }
    try {
      record('fit-zoom', await withTimeout(checkFitZoom(env), CHECK_TIMEOUT_MS * 2, 'fit'));
    } catch (e) {
      failAll(['fit-zoom'], e);
    }
  } finally {
    rec.running = false;
    rec.onChange();
  }
}

// ------------------------------------------------------------------------------------------- the window

interface Shared {
  dist: string;
  /** dist/shell, and the bundled deck: app.asar.unpacked in a packaged build (app-paths.ts, 9.10). */
  served: ServedDirs;
  capabilities: Capabilities;
  blockPort: number;
}

let shared: Shared | null = null;

async function sharedEnv(): Promise<Shared> {
  if (shared) return shared;
  const dist = __dirname;
  const editor = loadEditorDetailed(dist);
  shared = { dist, served: servedDirs(dist, app.isPackaged), capabilities: editor.capabilities, blockPort: await pickClosedLoopbackPort() };
  return shared;
}

function deckFileOf(env: Shared): string {
  return fs.realpathSync.native(env.served.diagnosticsDeck);
}

function log(msg: string): void {
  console.error(`[blueline check] ${msg}`);
}

let current: DiagWindow | null = null;
/** Set once `blueline check` is interrupted: the interrupt writes the CommandResult, not the closing window. */
let interrupted = false;
let channelsDeclared = false;

function declareShellChannels(): void {
  if (channelsDeclared) return;
  channelsDeclared = true;
  const r = shellRouter();
  const win = (from: ShellSender): DiagWindow => {
    if (from.windowKey !== SHELL_KEY || !current) throw new Error('Refused');
    return current;
  };
  r.handle(ShellToMain.diagState, validateNoArgs, (from) => win(from).rec.state());
  r.handle(ShellToMain.diagRecord, validateDiagRecord, (from, p) => win(from).record(p.stepId, p.result, p.detail));
  r.handle(ShellToMain.diagRunAuto, validateNoArgs, (from) => win(from).runAuto());
  r.handle(ShellToMain.diagSave, validateNoArgs, (from) => win(from).rec.save());
}

/** The interactive Diagnostics window. */
class DiagWindow {
  readonly win: BrowserWindow;
  readonly view: WebContentsView;
  readonly rec = new DiagRecorder({ autoOnly: false });
  readonly deck: DiagDeck;
  readonly closed: Promise<void>;
  private policy: DeckSessionHandle | null = null;
  private readonly tmpDir: string;

  private constructor(
    private readonly env: Shared,
    private readonly doc: AssetDoc,
  ) {
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueline-check-'));
    const shellSes = session.fromPartition(SHELL_PARTITION);
    if (!shellSes.protocol.isProtocolHandled('app')) installShellProtocol(shellSes, env.served.shellDir);
    declareShellChannels();
    this.win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 560,
      show: false,
      title: 'Blueline Diagnostics',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f2024' : '#f5f6f8',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: SHELL_PARTITION,
        preload: path.join(env.dist, 'preload-shell.cjs'),
        spellcheck: false,
        devTools: !app.isPackaged,
        navigateOnDragDrop: false,
      },
    });
    const shellWc = this.win.webContents;
    installShellPolicy(shellSes, shellWc);
    shellRouter().registerShell(shellWc, { windowKey: SHELL_KEY });
    this.win.on('page-title-updated', (e) => e.preventDefault());
    this.win.once('ready-to-show', () => this.win.show());
    shellWc.on('did-finish-load', () => this.push());

    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: doc.partition,
        preload: path.join(env.dist, 'preload-deck.cjs'),
        // The deck preload runs in every frame and installs only the file-drop guard in a subframe (drop-guard.ts,
        // review finding 2), as on the document windows' deck views (window.ts).
        nodeIntegrationInSubFrames: true,
        additionalArguments: ['--bl-mode=diagnostics'],
        devTools: !app.isPackaged,
        navigateOnDragDrop: false,
        safeDialogs: true,
        webviewTag: false,
        spellcheck: false,
      },
    });
    this.win.contentView.addChildView(this.view);
    this.deck = new DiagDeck(this.view.webContents, doc, { capabilities: env.capabilities, rec: this.rec, logToRecorder: true, platform: process.platform });
    this.deck.onMode = (m) => {
      this.rec.appMode = m;
      this.push();
    };
    this.rec.onChange = () => this.push();
    // App chords pressed while the shell has focus switch the deck's mode too (the menu is not wired here).
    shellWc.on('before-input-event', (event, input) => {
      const a = matchAppChord(input, { textField: false, platform: process.platform });
      if (a === 'mode-read' || a === 'mode-review' || a === 'mode-edit') {
        event.preventDefault();
        this.deck.setMode(a === 'mode-read' ? 'read' : a === 'mode-review' ? 'review' : 'edit', 'chord');
      }
    });
    this.relayout();
    this.win.on('resize', () => this.relayout());
    this.win.contentView.on('bounds-changed', () => this.relayout());
    let resolveClosed!: () => void;
    this.closed = new Promise((r) => (resolveClosed = r));
    // The deck view's webContents outlives its window in Electron 44: close it with the window (window.ts).
    this.win.on('close', () => {
      const wc = this.view.webContents;
      if (!wc.isDestroyed()) wc.close();
    });
    this.win.on('closed', () => {
      this.policy?.dispose();
      void session
        .fromPartition(doc.partition)
        .clearStorageData()
        .catch(() => undefined);
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
      resolveClosed();
    });
  }

  static async create(env: Shared): Promise<DiagWindow> {
    const doc = new AssetDoc(deckFileOf(env));
    const w = new DiagWindow(env, doc);
    w.policy = await servePartition(doc, env.blockPort);
    void w.win.webContents.loadURL(`${SHELL_ORIGIN}/diagnostics.html`).catch((e) => log(`shell failed to load: ${String(e)}`));
    void w.deck.load().catch((e) => log(`deck failed to load: ${String(e)}`));
    w.rec.logEvent('open', { electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '', platform: process.platform });
    return w;
  }

  private relayout(): void {
    if (this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize();
    this.view.setBounds({ x: 0, y: DIAG_HEADER, width: Math.max(0, w - DIAG_PANEL), height: Math.max(0, h - DIAG_HEADER) });
  }

  push(): void {
    if (this.win.isDestroyed()) return;
    this.win.webContents.send(MainToShell.diag, this.rec.state());
  }

  focus(): void {
    if (this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  record(stepId: string, result: 'pass' | 'fail' | 'skip', detail?: string): void {
    const step = this.rec.steps.find((s) => s.id === stepId);
    if (!step || step.auto) throw new Error('Refused');
    const ev = evidenceFor(stepId, this.rec.recent(), { mode: this.deck.mode, lastNote: this.deck.lastNote() });
    this.rec.setResult(stepId, result, [detail, ev ? `evidence: ${ev}` : ''].filter(Boolean).join(' · '));
    this.rec.markRecorded();
    // Back to the deck, so the next step's keys and dictation go there.
    const wc = this.view.webContents;
    if (!wc.isDestroyed()) wc.focus();
  }

  async runAuto(): Promise<void> {
    if (this.rec.running) return;
    await runAutoChecks({
      rec: this.rec,
      deckFile: this.doc.realpath,
      preload: path.join(this.env.dist, 'preload-deck.cjs'),
      capabilities: this.env.capabilities,
      blockPort: this.env.blockPort,
      visible: this.win,
      tmpDir: this.tmpDir,
      platform: process.platform,
      log,
    });
  }
}

function summaryText(rec: DiagRecorder, savedTo: string | null): string {
  const lines = ['blueline check'];
  for (const s of rec.steps) lines.push(`  ${s.result.toUpperCase().padEnd(7)} ${s.id}: ${s.title}${s.detail ? `\n          ${s.detail}` : ''}`);
  if (savedTo) lines.push(`check.json: ${savedTo}`);
  return lines.join('\n');
}

/**
 * Opens the Diagnostics window. With `auto`, runs only the automatic checks and returns. Resolves when the
 * window has closed (or the automatic run finished); with `outFile`, the CommandResult JSON is written
 * there first. Exit code: 0 when no step failed (with `auto`, when every automatic check passed), else 1.
 */
export async function openDiagnostics(opts: { auto: boolean; outFile?: string }): Promise<void> {
  const env = await sharedEnv();
  if (opts.auto) {
    const rec = new DiagRecorder({ autoOnly: true });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueline-check-'));
    // A small visible window: offscreen keys must arrive while a visible window keeps focus (6.7).
    const visible = new BrowserWindow({ width: 480, height: 270, show: true, title: 'Blueline check', skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'check-visible' } });
    try {
      if (process.platform === 'darwin') app.focus({ steal: true });
      visible.focus();
      await runAutoChecks({
        rec,
        deckFile: deckFileOf(env),
        preload: path.join(env.dist, 'preload-deck.cjs'),
        capabilities: env.capabilities,
        blockPort: env.blockPort,
        visible,
        tmpDir,
        platform: process.platform,
        log,
      });
    } finally {
      if (!visible.isDestroyed()) visible.destroy();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    let savedTo: string | null = null;
    try {
      savedTo = await rec.save();
    } catch (e) {
      log(`check.json not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
    const ok = rec.steps.every((s) => s.result === 'pass');
    for (const s of rec.steps) log(`${s.result.toUpperCase()} ${s.id}: ${s.detail ?? ''}`);
    if (opts.outFile && !interrupted) await writeCommandResult(opts.outFile, { command: 'check', exitCode: ok ? 0 : 1, text: summaryText(rec, savedTo), json: { ...rec.checkJson(), savedTo } });
    return;
  }
  if (current) {
    current.focus();
    await current.closed;
    return;
  }
  const w = await DiagWindow.create(env);
  current = w;
  try {
    await w.closed;
  } finally {
    if (current === w) current = null;
  }
  let savedTo = w.rec.savedTo;
  if (w.rec.log.some((e) => e.event === 'step')) {
    try {
      savedTo = await w.rec.save();
    } catch (e) {
      log(`check.json not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (opts.outFile && !interrupted) {
    const failed = w.rec.steps.some((s) => s.result === 'fail');
    await writeCommandResult(opts.outFile, { command: 'check', exitCode: failed ? 1 : 0, text: summaryText(w.rec, savedTo), json: { ...w.rec.checkJson(), savedTo } });
  }
}

/**
 * When `blueline check` is interrupted (index.ts: a signal, or the command that started it is gone): from
 * now on openDiagnostics writes no CommandResult (the interrupt writes its own), and check.json is saved if
 * the open window has recorded guided steps, so Josh's results are not lost. Returns where check.json is
 * (null when there is none).
 */
export async function interruptDiagnostics(): Promise<string | null> {
  interrupted = true;
  const w = current;
  if (!w) return null;
  if (!w.rec.log.some((e) => e.event === 'step')) return w.rec.savedTo;
  try {
    return await w.rec.save();
  } catch (e) {
    log(`check.json not saved: ${e instanceof Error ? e.message : String(e)}`);
    return w.rec.savedTo;
  }
}

async function writeCommandResult(outFile: string, r: CommandResult): Promise<void> {
  await fs.promises.writeFile(outFile, JSON.stringify(r, null, 2) + '\n', { mode: 0o600 });
}
