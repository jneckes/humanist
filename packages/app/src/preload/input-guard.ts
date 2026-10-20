// The input guard (6.2 step 2, 6.5, 9.1 Preload; SPEC 4 principle 1): what the user types, pastes or
// dictates into the overlay is the overlay's alone.
//
// Events from the overlay's closed shadow root reach `window` retargeted to the host, and the input-event
// family is composed: beforeinput, input, textInput, composition*, paste/cut/copy carry the card's text
// (e.data, clipboardData) to every capture-phase page listener on window and document, which run before the
// shadow root's own bubble-phase listeners, and which could also cancel the insertion (a deck's capture
// paste handler that calls preventDefault would silently drop a Wispr Flow dictation, D2). So, like the key
// router, the guard registers capture-phase listeners on window synchronously at preload start (before any
// page script), through listen() so reinstall() re-adds them after document.open(). For a trusted event
// whose real target is in the overlay it runs the overlay's own handling there and then calls
// stopImmediatePropagation(), never preventDefault(): the default insertion still happens, and no page
// listener (capture or bubble, window or document) sees it. Because stopping at window also skips the
// textarea's own listeners, the guard drives the card (DeckUi.onOverlayEvent → NoteCard.beforeInput/input).
//
// The guard's key listeners are registered after the key router's, so they never change its decisions:
// they only stop the keys from the overlay that the router let through.
//
// Card text is accepted only after a trusted beforeinput for the textarea in the same task (CardInputGate).
// document.execCommand('insertText' | 'delete' | 'undo' | …) from the page edits the focused card textarea
// and fires a trusted `input` with no beforeinput, so a deck could otherwise write the user's note. Every
// real edit fires beforeinput first: typing, IME composition (insertCompositionText), paste and Wispr Flow's
// simulated Cmd+V (insertFromPaste), drop, cut, spellcheck replacement, native undo and redo.
//
// Phase 2 (P2-7): the Edit field is a page element made contenteditable, so its events reach window with their
// real target in the page, not the host. The guard treats them the same way: a trusted event whose real target is
// inside the active field (or, for selectionchange, a selection inside it) goes to the field's own handling
// (edit-input.ts filter and gate) and is then stopped at window capture, so page listeners neither see nor cancel
// what the author types, pastes or dictates there. The field's beforeinput filter may preventDefault; the guard
// itself never does.

import { listen } from './listeners';

/** Composed input-family events whose data the page must not see when they come from the overlay. */
export const GUARDED_EVENTS: readonly string[] = [
  'beforeinput',
  'input',
  'textInput',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'paste',
  'cut',
  'copy',
  // Not composed today (they stay inside the shadow root), listed in case that changes.
  'select',
  'selectionchange',
  // A drag out of the card carries its selected text; a drop into it could be cancelled by the page.
  'dragstart',
  'drop',
];

/** Key events: the router stops text-field keys; the guard stops any other key from the overlay. */
export const GUARDED_KEYS: readonly string[] = ['keydown', 'keypress', 'keyup'];

export interface InputGuardDeps {
  /** The overlay host, or null before the overlay exists. */
  host(): EventTarget | null;
  /** The overlay's own handling of a trusted event from inside it (runs before the event is stopped). */
  onOverlayEvent(e: Event): void;
  /** The deck element that is the open edit field (contenteditable), or null (P2-7). */
  field?(): Element | null;
  /** The field's own handling of a trusted event from inside it (runs before the event is stopped). */
  onFieldEvent?(e: Event): void;
  /** A native undo or redo aimed at an earlier edit field (P2-9): cancelled and stopped. */
  foreignHistory?(e: Event): boolean;
}

export class InputGuard {
  constructor(
    private readonly win: Window,
    private readonly deps: InputGuardDeps,
  ) {}

  /** Registers the capture-phase listeners. Must run synchronously at preload start, after the key router. */
  install(): void {
    for (const type of [...GUARDED_EVENTS, ...GUARDED_KEYS]) {
      listen(this.win, type as keyof WindowEventMap, (e: Event) => this.handle(e), true);
    }
  }

  handle(e: Event): void {
    // The page's own synthetic events are its business (9.1: the preload ignores untrusted input).
    if (!e.isTrusted) return;
    const path = e.composedPath();
    const real = path.length > 0 ? path[0] : e.target;
    const host = this.deps.host();
    // Seen from window, composedPath()[0] of an event inside the closed shadow root is the host itself.
    if (host && real === host) {
      try {
        this.deps.onOverlayEvent(e);
      } finally {
        e.stopImmediatePropagation();
      }
      return;
    }
    if (this.deps.foreignHistory?.(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const field = this.deps.field?.() ?? null;
    if (!field || !inField(field, real, e)) return;
    try {
      this.deps.onFieldEvent?.(e);
    } finally {
      e.stopImmediatePropagation();
    }
  }
}

/**
 * True when the event belongs to the open field: its real target is the field or inside it, or, for
 * selectionchange (fired at the document), the selection's anchor is inside it.
 */
function inField(field: Element, real: EventTarget | null, e: Event): boolean {
  if (e.type === 'selectionchange') {
    const doc = field.ownerDocument;
    const a = doc.defaultView?.getSelection()?.anchorNode ?? null;
    return !!a && (a === field || field.contains(a));
  }
  const n = real as Node | null;
  return !!n && typeof n.nodeType === 'number' && (n === field || field.contains(n));
}

// ------------------------------------------------------------------------------------------- card text

/** The textarea as the gate needs it (a real HTMLTextAreaElement in the preload; a fake in unit tests). */
export interface TextFieldLike {
  value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
}

/** The parts of an InputEvent the gate reads. */
export interface InputLike {
  readonly isTrusted: boolean;
  readonly inputType: string;
  readonly data: string | null;
}

/** Deletions that remove text before a collapsed caret, and after it. */
const DELETE_BACKWARD = new Set(['deleteContentBackward', 'deleteWordBackward', 'deleteSoftLineBackward', 'deleteHardLineBackward']);
const DELETE_FORWARD = new Set(['deleteContentForward', 'deleteWordForward', 'deleteSoftLineForward', 'deleteHardLineForward']);

/** The card's arm: the textarea's value and selection when the beforeinput fired (before the edit). */
type Armed = ArmedInput;

/**
 * Accepts a card edit only when a trusted beforeinput for the textarea came just before its input, in the
 * same task; anything else (execCommand from the page) is undone: the textarea goes back to the last
 * accepted value and the change is dropped. The card restores it in a fresh textarea (NoteCard): the old
 * element's undo history holds the refused edit, and Chromium's native undo and redo would bring it back
 * (a trusted historyRedo) if the value were only reset.
 *
 * "The same task": the arm is consumed by the next input and cleared by a zero-delay timer. Chromium fires a
 * beforeinput with no input for a deletion that has nothing to delete (Backspace at the start, Delete at the
 * end), which would leave an arm a page task could reach before that timer; such an arm is a deletion at a
 * collapsed caret that deleted nothing, so an input claiming it must remove text next to that caret, in its
 * direction, and insert nothing. A page can only select all (execCommand('selectAll')) and edit the
 * selection, which never passes that test, and insert-type arms must carry the same data.
 */
export class CardInputGate {
  private accepted = '';
  private armed: Armed | null = null;

  /**
   * @param field the textarea now (the card may replace it)
   * @param restore puts the last accepted text back with a collapsed caret
   * @param later runs a function once the current task has ended
   */
  constructor(
    private readonly field: () => TextFieldLike,
    private readonly restore: (value: string, caret: number) => void = (value, caret) => {
      const f = field();
      f.value = value;
      f.setSelectionRange(caret, caret);
    },
    private readonly later: (fn: () => void) => void = (fn) => {
      setTimeout(fn, 0);
    },
  ) {}

  /** The last accepted text. */
  get value(): string {
    return this.accepted;
  }

  /** The card opened with this text (it is the accepted value until the next accepted edit). */
  reset(value: string): void {
    this.accepted = value;
    this.armed = null;
  }

  /** A beforeinput for the textarea. Only a trusted one arms the gate. */
  beforeInput(e: InputLike): void {
    if (!e.isTrusted) return;
    const f = this.field();
    const v = f.value;
    const armed: Armed = {
      inputType: e.inputType,
      data: typeof e.data === 'string' ? e.data : null,
      value: v,
      start: f.selectionStart ?? v.length,
      end: f.selectionEnd ?? v.length,
    };
    this.armed = armed;
    this.later(() => {
      if (this.armed === armed) this.armed = null;
    });
  }

  /**
   * An input for the textarea, after its default action: true when the edit is accepted (the caller saves
   * the textarea's value); false when it was refused and the textarea restored.
   */
  input(e: InputLike): boolean {
    const a = this.armed;
    this.armed = null;
    const value = this.field().value;
    if (e.isTrusted && a && matchesArmed(a, e, value)) {
      this.accepted = value;
      return true;
    }
    const prev = this.accepted;
    if (value !== prev) this.restore(prev, restoredCaret(value, prev));
    return false;
  }
}

/**
 * Where the caret goes when `prev` replaces the refused text `cur`: the end of the text the refused edit
 * replaced. That is the caret the user had for an insertion at the caret, and the end of a page-made
 * selection otherwise (collapsed: never a selection the user's next key would replace).
 */
export function restoredCaret(cur: string, prev: string): number {
  const max = Math.min(cur.length, prev.length);
  let p = 0;
  while (p < max && cur.charCodeAt(p) === prev.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && cur.charCodeAt(cur.length - 1 - s) === prev.charCodeAt(prev.length - 1 - s)) s++;
  return prev.length - s;
}

/** A trusted beforeinput the gate armed with, and the text and selection at that moment. */
export interface ArmedInput {
  inputType: string;
  data: string | null;
  /** The field's text and selection when the beforeinput fired (before the edit). */
  value: string;
  start: number;
  end: number;
}

/**
 * Whether an input event is the edit its armed beforeinput announced: the same type, the same data for an
 * insertion, and for a deletion at a collapsed caret, text removed next to that caret in its direction and nothing
 * inserted. Shared by the card's gate and the Edit field's (edit-input.ts FieldInputGate).
 */
export function matchesArmed(a: ArmedInput, e: InputLike, value: string): boolean {
  if (a.inputType !== e.inputType) return false;
  if (a.data !== null && typeof e.data === 'string' && a.data !== e.data) return false;
  if (a.start !== a.end) return true;
  const c = a.start;
  const pre = a.value;
  const k = pre.length - value.length;
  if (DELETE_BACKWARD.has(a.inputType)) return k >= 1 && k <= c && value === pre.slice(0, c - k) + pre.slice(c);
  if (DELETE_FORWARD.has(a.inputType)) return k >= 1 && c + k <= pre.length && value === pre.slice(0, c) + pre.slice(c + k);
  // Cutting a collapsed selection removes nothing.
  if (a.inputType === 'deleteByCut') return value === pre;
  return true;
}
