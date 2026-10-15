// The deck view's single-letter key router (6.2 "Single-letter keys inside the deck view"). One capture-phase
// keydown listener on `window`, registered before any deck script runs (9.1 Preload), so it is the first
// listener of every keydown in both worlds. The decision is a pure function of the key and the context
// (classifyKey), unit-tested; KeyRouter applies it to real events.

import type { AppMode } from '@blueline/core/ipc';
import { listen } from './listeners';

export interface KeyInput {
  /** KeyboardEvent.code: keys are matched on the physical key (6.2). */
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  isTrusted: boolean;
  repeat: boolean;
  /** An IME composition is in progress: Esc and Enter belong to the IME. */
  composing: boolean;
}

/** What kind of text field holds the key's real target (6.2 step 1), or null when it is not in one. */
export type TextFieldKind = 'card' | 'edit' | 'other';

export interface KeyContext {
  appMode: AppMode;
  textField: TextFieldKind | null;
}

export type ShortcutAction =
  | 'tool-select'
  | 'tool-pen'
  | 'tool-highlighter'
  | 'tool-arrow'
  | 'tool-pin'
  | 'tool-box'
  | 'new-note'
  | 'suggest'
  | 'next-pin'
  | 'prev-pin'
  | 'escape'
  | 'help';

export type KeyAction =
  /** isTrusted is false: the router does nothing at all (9.1: page scripts cannot drive it). */
  | { kind: 'ignore' }
  /** Untouched: the deck sees the key (Read mode, modifier chords). */
  | { kind: 'pass' }
  /** In a text field: stopImmediatePropagation, never preventDefault; maybe an edit or card action. */
  | { kind: 'text'; handle: 'commit-edit' | 'cancel-edit' | 'close-card' | null }
  /** Review/Edit shortcut: run it, then stopImmediatePropagation and preventDefault. */
  | { kind: 'shortcut'; action: ShortcutAction }
  /** Review/Edit: ArrowLeft and ArrowRight are forwarded to the deck untouched. */
  | { kind: 'forward' }
  /** Review/Edit: any other key is kept from the deck (stopImmediatePropagation and preventDefault). */
  | { kind: 'swallow' };

const TOOL_BY_CODE: Record<string, ShortcutAction> = {
  Digit1: 'tool-pen',
  Digit2: 'tool-highlighter',
  Digit3: 'tool-arrow',
  Digit4: 'tool-pin',
  Digit5: 'tool-box',
  Numpad1: 'tool-pen',
  Numpad2: 'tool-highlighter',
  Numpad3: 'tool-arrow',
  Numpad4: 'tool-pin',
  Numpad5: 'tool-box',
};

function isEnter(code: string): boolean {
  return code === 'Enter' || code === 'NumpadEnter';
}

/** The 6.2 rules, in the spec's order (steps 1-5 and the key table). */
export function classifyKey(k: KeyInput, ctx: KeyContext): KeyAction {
  if (!k.isTrusted) return { kind: 'ignore' };

  // Step 2: in a text field, no shortcut; only Enter/Esc for the active edit and Esc/Cmd+Enter for cards.
  // The key is kept from the deck (stopImmediatePropagation) but never prevented, so typing, native undo
  // and Wispr Flow's simulated Cmd+V keep working.
  if (ctx.textField) {
    let handle: 'commit-edit' | 'cancel-edit' | 'close-card' | null = null;
    if (!k.composing) {
      const plain = !k.meta && !k.ctrl && !k.alt && !k.shift;
      if (ctx.textField === 'edit') {
        if (isEnter(k.code) && plain) handle = 'commit-edit';
        else if (k.code === 'Escape' && plain) handle = 'cancel-edit';
      } else if (ctx.textField === 'card') {
        if (k.code === 'Escape' && plain) handle = 'close-card';
        else if (isEnter(k.code) && (k.meta || k.ctrl) && !k.alt) handle = 'close-card';
      }
    }
    return { kind: 'text', handle };
  }

  // Step 3: Meta, Ctrl or Alt chords pass through untouched (Wispr Flow's Cmd+V must never fire a shortcut).
  if (k.meta || k.ctrl || k.alt) return { kind: 'pass' };

  // Step 4: Read mode gives every key to the deck.
  if (ctx.appMode === 'read') return { kind: 'pass' };

  // Step 5: Review and Edit.
  if (k.code === 'ArrowLeft' || k.code === 'ArrowRight') return { kind: 'forward' };
  const review = ctx.appMode === 'review';
  const sc = (action: ShortcutAction): KeyAction => ({ kind: 'shortcut', action });
  switch (k.code) {
    case 'KeyV':
      return review ? sc('tool-select') : { kind: 'swallow' };
    case 'KeyN':
      // A held N would create a note per auto-repeat.
      return k.repeat ? { kind: 'swallow' } : sc('new-note');
    case 'KeyR':
      return review && !k.repeat ? sc('suggest') : { kind: 'swallow' };
    case 'KeyJ':
      return sc('next-pin');
    case 'KeyK':
      return sc('prev-pin');
    case 'Escape':
      // Never forwarded to the deck in Review or Edit; a held Esc must not count as the second Esc.
      return k.repeat ? { kind: 'swallow' } : sc('escape');
    case 'Slash':
      return k.shift ? sc('help') : { kind: 'swallow' };
  }
  const tool = TOOL_BY_CODE[k.code];
  if (tool) return review ? sc(tool) : { kind: 'swallow' };
  return { kind: 'swallow' };
}

export interface KeyRouterDeps {
  /** Current app mode (Read until main's init arrives). */
  appMode(): AppMode;
  /** The text field the real target belongs to (6.2 step 1), given `t = e.composedPath()[0]`. */
  textFieldOf(t: EventTarget | null): TextFieldKind | null;
  /** Runs a shortcut or a text-field action. */
  onAction(action: ShortcutAction | 'commit-edit' | 'cancel-edit' | 'close-card', e: KeyboardEvent): void;
  /** Diagnostics: called inside the listener, after the decision and before any action. */
  onDecision?(e: KeyboardEvent, action: KeyAction, consumed: boolean): void;
  /** A trusted key the deck was given in a mode where it may move the deck (6.7 Index replay). */
  onDeckKey?(e: KeyboardEvent): void;
}

/**
 * Applies classifyKey to real events. Besides the keydown listener the spec names, it keeps the matching
 * keypress and keyup of a consumed keydown from the deck too, so a deck that navigates on keyup cannot be
 * moved by typing in a card.
 */
export class KeyRouter {
  /** Codes whose keydown was kept from the deck; their keyup (and keypress) are kept too. */
  private readonly stopped = new Set<string>();
  private lastDownStopped = false;

  constructor(
    private readonly win: Window,
    private readonly deps: KeyRouterDeps,
  ) {}

  /** Registers the listeners. Must run synchronously at preload start (9.1). */
  install(): void {
    listen(this.win, 'keydown', (e) => this.onKeyDown(e), true);
    listen(this.win, 'keypress', (e) => this.onKeyPress(e), true);
    listen(this.win, 'keyup', (e) => this.onKeyUp(e), true);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const path = e.composedPath();
    const t = path.length > 0 ? path[0] : e.target;
    const action = classifyKey(
      {
        code: e.code,
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        isTrusted: e.isTrusted,
        repeat: e.repeat,
        composing: e.isComposing,
      },
      { appMode: this.deps.appMode(), textField: this.deps.textFieldOf(t) },
    );
    const consumed = action.kind === 'text' || action.kind === 'shortcut' || action.kind === 'swallow';
    if (action.kind !== 'ignore') this.lastDownStopped = consumed;
    if (consumed) {
      e.stopImmediatePropagation();
      if (action.kind !== 'text') e.preventDefault();
      this.stopped.add(e.code);
    }
    this.deps.onDecision?.(e, action, consumed);
    if (action.kind === 'text' && action.handle) this.deps.onAction(action.handle, e);
    else if (action.kind === 'shortcut') this.deps.onAction(action.action, e);
    else if ((action.kind === 'pass' || action.kind === 'forward') && e.isTrusted && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.deps.onDeckKey?.(e);
    }
  }

  private onKeyPress(e: KeyboardEvent): void {
    if (e.isTrusted && this.lastDownStopped) e.stopImmediatePropagation();
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (!e.isTrusted) return;
    if (this.stopped.delete(e.code)) e.stopImmediatePropagation();
  }
}
