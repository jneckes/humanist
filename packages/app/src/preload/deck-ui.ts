// The visible deck view's preload UI (deck and diagnostics modes): overlay, card, ink, notes, slide adapter,
// link and focus reports, mode switching, Edit mode (edit-controller.ts, Phase 2), and the diagnostics hooks.
// Built right after the key router.

import { DeckToMain, type AppMode, type DeckInit, type FocusState, type MapUpdate, type SlideState } from '@blueline/core/ipc';
import type { DeckBusy } from '@blueline/core/ipc-files';
import { slideIndexOf, type SlideModel } from '@blueline/core/slides';
import type { ScriptTouchTracker } from '@blueline/core/dom-walk';
import type { ClientMap, Note } from '@blueline/core/types';
import { NoteCard } from './card';
import { EditController } from './edit-controller';
import {
  KeyOrderProbe,
  diagSender,
  installDiagnosticsHeading,
  type ActiveEdit,
  type DiagSend,
} from './diagnostics-hooks';
import { InkLayer, type Tool } from './ink';
import type { KeyAction, PickerKey, ShortcutAction, TextFieldKind } from './key-router';
import { installLinkReporter } from './link-reporter';
import { NotesController } from './notes';
import { Overlay } from './overlay';
import { SlideWatcher } from './slide-watcher';
import { elementAt } from './targets';
import { listen, listenOn, reinstall } from './listeners';

const APP_MODES: readonly AppMode[] = ['read', 'review', 'edit'];

const TOOL_OF: Partial<Record<ShortcutAction, Tool>> = {
  'tool-select': 'select',
  'tool-pen': 'pen',
  'tool-highlighter': 'highlighter',
  'tool-arrow': 'arrow',
  'tool-pin': 'pin',
  'tool-box': 'box',
};

const TOOL_LABEL: Record<Tool, string> = {
  select: 'Select \u00b7 V',
  pen: 'Pen \u00b7 1',
  highlighter: 'Highlighter \u00b7 2',
  arrow: 'Arrow \u00b7 3',
  pin: 'Pin \u00b7 4',
  box: 'Box \u00b7 5',
};

/** The chrome is restored on its own if main never sends `hidden: false` (6.7: it reappears on the next frame). */
const CHROME_RESTORE_MS = 1500;
/** A user name main sends (first-run.ts cleanName keeps at most 200 characters). */
const USER_NAME_MAX = 200;

export interface DeckUiOptions {
  send(channel: string, payload?: unknown): void;
  diagnostics: boolean;
  /** The ScriptTouchTracker deck.ts started at preload start (P2-6: Edit matches as `blueline map` does). */
  tracker?: ScriptTouchTracker | null;
  /** The busy state changed (an edit field opened or closed, a commit was sent or answered): report it now (6.6). */
  onBusyChange?(): void;
}

export class DeckUi {
  private mode: AppMode = 'read';
  private tool: Tool = 'select';
  private init: DeckInit | null = null;
  private map: ClientMap | null = null;
  private activeEdit: ActiveEdit | null = null;
  private lastFocus: boolean | null = null;
  private pointer: { x: number; y: number } | null = null;
  private chromeTimer: ReturnType<typeof setTimeout> | null = null;
  /** When this view last asked main for Read with a second Esc (diagnostics: the mode change's cause). */
  private escReadAt = 0;

  readonly overlay: Overlay;
  private readonly card: NoteCard;
  private readonly ink: InkLayer;
  private readonly notes: NotesController;
  private readonly slides: SlideWatcher;
  private readonly diag: DiagSend | null;
  private readonly keyProbe: KeyOrderProbe | null;
  /** Edit mode (6.3): outlines, the field, the picker, the fit guard (Phase 2). */
  readonly edit: EditController;

  constructor(
    private readonly doc: Document,
    private readonly win: Window,
    private readonly opts: DeckUiOptions,
  ) {
    this.diag = opts.diagnostics ? diagSender((c, p) => opts.send(c, p)) : null;
    this.overlay = new Overlay(doc);
    const parts = this.overlay.parts;
    this.card = new NoteCard(doc, parts.cards, {
      onInput: (text) => this.notes.onInput(text),
      onHoverMark: (n) => this.notes.hoverMark(n),
    });
    this.ink = new InkLayer(doc, win, parts.ink, parts.capture, {
      onMark: (m) => this.notes.addMark(m),
      onMarkClick: (key) => {
        this.notes.openByKey(key);
        this.reportFocus();
      },
    });
    this.slides = new SlideWatcher(doc, win, {
      report: (s: SlideState) => opts.send(DeckToMain.slides, s),
      moved: (from, to) => {
        this.diag?.('deck-moved', { from, to });
        this.notes.refreshInk();
      },
      host: () => this.overlay.host,
    });
    this.notes = new NotesController(doc, win, this.overlay.host, this.card, this.ink, {
      send: (channel, op) => opts.send(channel, op),
      userName: () => this.userName(),
      currentSlide: () => this.slides.current,
      slideLabel: () => {
        const cur = this.slides.current;
        if (cur === null) return null;
        const title = this.slides.currentTitle;
        return title && title !== `Slide ${cur + 1}` ? `Slide ${cur + 1} \u203a ${title}` : `Slide ${cur + 1}`;
      },
      // Phase 0: a note's ink shows on its own slide when slides are detected (6.4 Ink visibility; the
      // target-based rules are Phase 3).
      inkFilter: (n: Note) => {
        const cur = this.slides.current;
        const idx = n.slide && typeof n.slide.index === 'number' ? n.slide.index : null;
        return cur === null || idx === null || idx === cur;
      },
      diag: this.diag ?? undefined,
      onCardChange: () => this.reportFocus(),
    });

    this.edit = new EditController(doc, win, this.overlay, {
      send: (channel, payload) => opts.send(channel, payload),
      tracker: opts.tracker ?? null,
      slideOf: (el) => {
        const m = this.slides.model;
        return m && m.kind !== 'single' ? slideIndexOf(m, el) : null;
      },
      onActiveChange: (edit) => {
        this.activeEdit = edit;
        this.reportFocus();
        opts.onBusyChange?.();
      },
      onBusyChange: () => opts.onBusyChange?.(),
      closeCard: () => {
        if (this.notes.cardOpen) {
          this.notes.closeCard();
          this.reportFocus();
        }
      },
      diag: this.diag ?? undefined,
    });

    this.overlay.mount();
    this.overlay.whenRootReplaced(() => {
      // document.open() erased every window listener (the key router's and the input guard's included) and
      // every listener in the overlay's shadow tree: the card, the ink layer, the focus reports (listeners.ts).
      reinstall(win);
      this.slides.rootReplaced();
    });
    this.slides.start();
    // Edit's window listeners come before the link reporter's: a press that opens a field on link text is
    // Blueline's, so the link reporter never reports it (and the click is prevented, P2-17).
    this.edit.install();
    installLinkReporter(win, (c, p) => opts.send(c, p));
    this.installFocusReports();
    this.installPointerTracking();
    this.keyProbe = this.diag ? new KeyOrderProbe(doc, this.diag, win) : null;
    if (this.diag) {
      const diag = this.diag;
      installDiagnosticsHeading(
        win,
        diag,
        (edit) => {
          this.activeEdit = edit;
          this.reportFocus();
          opts.onBusyChange?.();
        },
        // In Edit the real edit controller owns clicks on deck text (Phase 2), so the heading probe answers only
        // in Read and in Review's select tool.
        () => this.mode !== 'edit' && !(this.mode === 'review' && this.tool !== 'select'),
        (text) => this.overlay.setBadge(text),
      );
    }
    this.applyTool();
  }

  // ------------------------------------------------------------------------------------------- from main

  applyInit(p: DeckInit): void {
    if (!p || typeof p !== 'object') return;
    this.init = p;
    // Edit's per-page state (the page's version, the file name, smart punctuation) before its map and mode.
    this.edit.applyInit(p);
    this.applyMap(p.map ?? null);
    this.notes.setNotes(Array.isArray(p.notes) ? p.notes : []);
    this.applyAppMode(p, 'init');
  }

  /** MainToDeck.settings (Phase 2): the deck's settings changed after its init (6.3 Smart punctuation). */
  applySettings(p: unknown): void {
    this.edit.applySettings(p);
  }

  /** The user's name as the note card shows it (DeckInit, then MainToDeck.userName). */
  userName(): string {
    return this.init && typeof this.init.userName === 'string' ? this.init.userName : '';
  }

  /**
   * MainToDeck.userName (Phase 2): the name chip changed the user's name (6.8). The note card's author chip reads
   * it from the init, so the init takes the new name; a malformed one changes nothing.
   */
  applyUserName(p: unknown): void {
    const name = p && typeof p === 'object' ? (p as { userName?: unknown }).userName : undefined;
    if (!this.init || typeof name !== 'string' || name.length > USER_NAME_MAX) return;
    this.init = { ...this.init, userName: name };
  }

  /** MainToDeck.appMode: an AppModeUpdate (or DeckInit), or a bare AppMode. */
  applyAppMode(p: unknown, cause: 'main' | 'init'): void {
    const raw = typeof p === 'string' ? p : p && typeof p === 'object' ? ((p as { appMode?: unknown }).appMode ?? (p as { mode?: unknown }).mode) : null;
    if (typeof raw !== 'string' || !(APP_MODES as readonly string[]).includes(raw)) return;
    const next = raw as AppMode;
    const prev = this.mode;
    // AppModeUpdate.editingAllowed (and DeckInit's): Edit is available only while it holds (6.3, 6.10).
    const ea = p && typeof p === 'object' ? (p as { editingAllowed?: unknown }).editingAllowed : undefined;
    const editingAllowed = typeof ea === 'boolean' ? ea : undefined;
    if (next === prev && cause !== 'init') {
      if (editingAllowed !== undefined) this.edit.applyAppMode(next, editingAllowed);
      return;
    }
    this.mode = next;
    if (next !== prev) {
      // 6.4: a mode change closes the card; an active edit ends (blur commits, 6.3).
      this.notes.closeCard();
      this.activeEdit?.commit();
      this.overlay.toggleHelp(false);
      if (next !== 'review') this.tool = 'select';
      const esc = next === 'read' && Date.now() - this.escReadAt < 3000;
      this.diag?.('mode-change', { from: prev, to: next, cause: esc ? 'esc' : cause });
      this.escReadAt = 0;
    }
    this.edit.applyAppMode(next, editingAllowed);
    this.applyTool();
    this.reportFocus();
  }

  applyMap(p: MapUpdate): void {
    // It is always a complete map: while main finishes one (DeckInit.mapPending, D-9) the deck holds null, and the
    // edit controller (hover outlines, the matcher) waits.
    this.map = p && typeof p === 'object' && typeof (p as ClientMap).version === 'string' ? (p as ClientMap) : null;
    this.edit.applyMap(p);
  }

  applyNotes(p: unknown): void {
    this.notes.setNotes(p);
  }

  /** MainToDeck.chrome (6.7 Note screenshots): hide cards and outlines; the ink stays. */
  applyChrome(p: unknown): void {
    const hidden = !!(p && typeof p === 'object' && (p as { hidden?: unknown }).hidden === true);
    this.overlay.setChromeHidden(hidden);
    if (this.chromeTimer) clearTimeout(this.chromeTimer);
    this.chromeTimer = hidden
      ? setTimeout(() => {
          this.overlay.setChromeHidden(false);
          this.chromeTimer = null;
        }, CHROME_RESTORE_MS)
      : null;
  }

  closeCard(): void {
    this.notes.closeCard();
    this.reportFocus();
  }

  // ------------------------------------------------------------------------------------------- views (Phase 1)

  /** Added by views: the slide model this view detected (9.4: kind, design size, slides), or null. */
  slideModel(): SlideModel | null {
    return this.slides.model;
  }

  /**
   * Added by views (6.6 Reload): what holds a reload back. An active edit, or an edit whose commit main has not
   * answered yet (Phase 2: a reload then would lose it), and the open card's state.
   */
  busyState(): DeckBusy {
    const c = this.notes.cardState();
    return { edit: this.activeEdit !== null || this.edit.busy().committing, card: !c ? 'none' : c.dirty ? 'dirty' : 'open' };
  }

  /** Added by views (6.6 Reload): the open card's note and the text it shows, for the view state. */
  cardDraft(): { noteId: string; draft: string } | null {
    const c = this.notes.cardState();
    return c && c.id ? { noteId: c.id, draft: c.text } : null;
  }

  /** Added by views (6.6 Reload): reopens the card a reload closed. */
  restoreCard(noteId: string, draft: string): boolean {
    const ok = this.notes.restoreCard(noteId, draft);
    this.reportFocus();
    return ok;
  }

  // ------------------------------------------------------------------------------------------- key router bridge

  appMode(): AppMode {
    return this.mode;
  }

  /** 6.2 step 1: the overlay's textarea/input, or inside the deck element that is currently contenteditable. */
  textFieldOf(t: EventTarget | null): TextFieldKind | null {
    const host = this.overlay.host;
    let el: Element | null = null;
    if (t === host) {
      // Events from the closed shadow root reach window retargeted to the host, and composedPath() seen from
      // window stops there; the shadow root's focused element is the real target of a key.
      el = this.overlay.shadowRoot.activeElement;
      // Edit's input over SVG text is the active edit field (P2-17).
      if (el && this.activeEdit && el === this.activeEdit.element) return 'edit';
      if (el && (el.localName === 'textarea' || el.localName === 'input')) return el === this.card.textarea ? 'card' : 'other';
      return null;
    }
    const node = t as Node | null;
    if (!node || typeof (node as Node).nodeType !== 'number') return null;
    if (this.activeEdit && this.activeEdit.element.contains(node)) return 'edit';
    return null;
  }

  onAction(a: ShortcutAction | 'commit-edit' | 'cancel-edit' | 'close-card', e: KeyboardEvent): void {
    this.diag?.('shortcut', { key: e.key, code: e.code, action: a });
    switch (a) {
      case 'commit-edit':
        this.activeEdit?.commit();
        break;
      case 'cancel-edit':
        this.activeEdit?.cancel();
        break;
      case 'close-card':
        this.notes.closeCard();
        break;
      case 'escape':
        // 6.2: Esc closes the open card or edit; a second Esc (nothing left to close) returns to Read. The order:
        // help, Edit's picker, the card, the edit.
        if (this.overlay.helpOpen) this.overlay.toggleHelp(false);
        else if (this.edit.closePickerIfOpen()) break;
        else if (this.notes.cardOpen) this.notes.closeCard();
        else if (this.activeEdit) this.activeEdit.cancel();
        else {
          this.escReadAt = Date.now();
          this.opts.send(DeckToMain.mode, { mode: 'read' });
        }
        break;
      case 'help':
        this.overlay.toggleHelp(undefined, this.mode);
        break;
      case 'new-note':
        this.notes.newNoteAt(this.hovered());
        break;
      case 'suggest':
        // R: suggesting a change (6.8) arrives in Phase 5.
        this.overlay.showToast('Suggest a change (R) arrives in a later version.');
        break;
      case 'next-pin':
        this.notes.step(1);
        break;
      case 'prev-pin':
        this.notes.step(-1);
        break;
      default: {
        const tool = TOOL_OF[a];
        if (tool) {
          this.tool = tool;
          this.applyTool();
        }
      }
    }
    this.reportFocus();
  }

  onDeckKey(e: KeyboardEvent): void {
    this.slides.noteDeckKey(e.key);
  }

  onDecision(e: KeyboardEvent, action: KeyAction, consumed: boolean): void {
    this.keyProbe?.onDecision(e, action, consumed);
  }

  /** Edit's picker is open (the key router gives it the arrows, Enter, digits and Esc, P2-8). */
  pickerOpen(): boolean {
    return this.mode === 'edit' && this.edit.pickerOpen;
  }

  onPickerKey(k: PickerKey): void {
    this.edit.onPickerKey(k);
  }

  // ------------------------------------------------------------------------------------------- input guard bridge

  /** The overlay host: events from its closed shadow root reach window retargeted to it. */
  overlayHost(): EventTarget {
    return this.overlay.host;
  }

  /**
   * The deck element that is the open edit field (Edit's contenteditable element, or the Diagnostics heading),
   * whose input events the input guard routes here and stops (P2-7); never an element of the overlay.
   */
  fieldElement(): Element | null {
    const el = this.activeEdit?.element ?? null;
    return el && el.getRootNode() === this.doc ? el : null;
  }

  /** A trusted input-family event from inside the open field (input guard). */
  onFieldEvent(e: Event): void {
    this.activeEdit?.onInputEvent?.(e);
  }

  /** P2-9: a native undo or redo aimed at an earlier edit field (the input guard cancels it). */
  foreignHistory(e: Event): boolean {
    return this.edit.foreignHistory(e);
  }

  /**
   * A trusted event from inside the overlay, seen by the input guard at window capture before it stops the
   * event there (input-guard.ts). The card textarea's own handling runs here, since its listeners never see
   * the event: beforeinput arms the card's gate, input saves the text only if a trusted beforeinput announced
   * it (6.5, 9.1). In Diagnostics the card logs beforeinput and paste as the heading does (section 10:
   * Wispr pastes, so expect insertFromPaste and a paste event).
   */
  onOverlayEvent(e: Event): void {
    const active = this.overlay.shadowRoot.activeElement;
    // Edit's input over SVG text (P2-17): the field's own filter and gate.
    if (active && this.activeEdit && active === this.activeEdit.element) {
      this.activeEdit.onInputEvent?.(e);
      return;
    }
    if (active !== this.card.textarea) return;
    switch (e.type) {
      case 'beforeinput': {
        const ie = e as InputEvent;
        this.card.beforeInput(ie);
        this.diag?.('beforeinput', { inputType: ie.inputType, data: ie.data, trusted: ie.isTrusted, field: 'card' });
        break;
      }
      case 'input':
        this.card.input(e as InputEvent);
        break;
      case 'paste': {
        const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
        this.diag?.('paste', { length: text.length, field: 'card' });
        break;
      }
    }
  }

  // ------------------------------------------------------------------------------------------- internals

  private applyTool(): void {
    const review = this.mode === 'review';
    this.ink.configure(this.tool, review, this.mode !== 'read');
    this.overlay.setHud(review ? TOOL_LABEL[this.tool] : null);
  }

  private hovered(): Element | null {
    const p = this.pointer;
    return p ? elementAt(this.doc, p.x, p.y, this.overlay.host) : null;
  }

  private installPointerTracking(): void {
    listen(
      this.win,
      'pointermove',
      (e) => {
        if (e.isTrusted) this.pointer = { x: e.clientX, y: e.clientY };
      },
      { capture: true, passive: true },
    );
    // 6.4: in Edit mode a click on the deck closes the card (in Review, a stroke or click does not).
    listen(
      this.win,
      'pointerdown',
      (e) => {
        if (!e.isTrusted || this.mode !== 'edit' || !this.notes.cardOpen) return;
        if (e.composedPath()[0] === this.overlay.host) return;
        this.notes.closeCard();
        this.reportFocus();
      },
      true,
    );
  }

  /** DeckToMain.focus (6.2: main routes Cmd+Z to native undo only while a text field has focus). */
  private installFocusReports(): void {
    const schedule = () => queueMicrotask(() => this.reportFocus());
    listen(this.win, 'focusin', schedule, true);
    listen(this.win, 'focusout', schedule, true);
    listenOn(this.overlay.shadowRoot, 'focusin', schedule, true);
    listenOn(this.overlay.shadowRoot, 'focusout', schedule, true);
  }

  private textFieldFocused(): boolean {
    const a = this.overlay.shadowRoot.activeElement;
    if (a && (a.localName === 'textarea' || a.localName === 'input')) return true;
    const d = this.doc.activeElement;
    return !!(this.activeEdit && d && this.activeEdit.element.contains(d));
  }

  reportFocus(): void {
    const tf = this.textFieldFocused();
    if (tf === this.lastFocus) return;
    this.lastFocus = tf;
    const s: FocusState = { textField: tf };
    this.opts.send(DeckToMain.focus, s);
  }
}
