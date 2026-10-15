// The visible deck view's preload UI (deck and diagnostics modes): overlay, card, ink, notes, slide adapter,
// link and focus reports, mode switching, and the diagnostics hooks. Built right after the key router.

import { DeckToMain, type AppMode, type DeckInit, type FocusState, type MapUpdate, type SlideState } from '@blueline/core/ipc';
import type { ClientMap, Note } from '@blueline/core/types';
import { NoteCard } from './card';
import {
  KeyOrderProbe,
  diagSender,
  installDiagnosticsHeading,
  type ActiveEdit,
  type DiagSend,
} from './diagnostics-hooks';
import { InkLayer, type Tool } from './ink';
import type { KeyAction, ShortcutAction, TextFieldKind } from './key-router';
import { installLinkReporter } from './link-reporter';
import { NotesController } from './notes';
import { Overlay } from './overlay';
import { SlideWatcher } from './slide-watcher';
import { elementAt } from './targets';
import { listen, reinstall } from './listeners';

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

export interface DeckUiOptions {
  send(channel: string, payload?: unknown): void;
  diagnostics: boolean;
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
      userName: () => (this.init && typeof this.init.userName === 'string' ? this.init.userName : ''),
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

    this.overlay.mount();
    this.overlay.whenRootReplaced(() => {
      // document.open() erased every window listener, the key router's included (listeners.ts).
      reinstall(win);
      this.slides.rootReplaced();
    });
    this.slides.start();
    installLinkReporter(win, (c, p) => opts.send(c, p));
    this.installFocusReports();
    this.installPointerTracking();
    this.keyProbe = this.diag ? new KeyOrderProbe(doc, this.diag) : null;
    if (this.diag) {
      const diag = this.diag;
      installDiagnosticsHeading(
        win,
        diag,
        (edit) => {
          this.activeEdit = edit;
          this.reportFocus();
        },
        () => !(this.mode === 'review' && this.tool !== 'select'),
        (text) => this.overlay.setBadge(text),
      );
    }
    this.applyTool();
  }

  // ------------------------------------------------------------------------------------------- from main

  applyInit(p: DeckInit): void {
    if (!p || typeof p !== 'object') return;
    this.init = p;
    this.applyMap(p.map ?? null);
    this.notes.setNotes(Array.isArray(p.notes) ? p.notes : []);
    this.applyAppMode(p.appMode, 'init');
  }

  /** MainToDeck.appMode: an AppModeUpdate, or a bare AppMode. */
  applyAppMode(p: unknown, cause: 'main' | 'init'): void {
    const raw = typeof p === 'string' ? p : p && typeof p === 'object' ? ((p as { appMode?: unknown }).appMode ?? (p as { mode?: unknown }).mode) : null;
    if (typeof raw !== 'string' || !(APP_MODES as readonly string[]).includes(raw)) return;
    const next = raw as AppMode;
    const prev = this.mode;
    if (next === prev && cause !== 'init') return;
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
    this.applyTool();
    this.reportFocus();
  }

  applyMap(p: MapUpdate): void {
    // Kept for the edit controller (Phase 2: hover outlines and the matcher).
    this.map = p && typeof p === 'object' && typeof (p as ClientMap).version === 'string' ? (p as ClientMap) : null;
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
        // 6.2: Esc closes the open card or edit; a second Esc (nothing left to close) returns to Read.
        if (this.overlay.helpOpen) this.overlay.toggleHelp(false);
        else if (this.notes.cardOpen) this.notes.closeCard();
        else if (this.activeEdit) this.activeEdit.cancel();
        else {
          this.escReadAt = Date.now();
          this.opts.send(DeckToMain.mode, { mode: 'read' });
        }
        break;
      case 'help':
        this.overlay.toggleHelp();
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
    this.overlay.shadowRoot.addEventListener('focusin', schedule, true);
    this.overlay.shadowRoot.addEventListener('focusout', schedule, true);
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
