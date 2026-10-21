import { describe, expect, it } from 'vitest';
import { classifyKey, type KeyContext, type KeyInput } from '../../../packages/app/src/preload/key-router';

const key = (code: string, o: Partial<KeyInput> = {}): KeyInput => ({
  code,
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  isTrusted: true,
  repeat: false,
  composing: false,
  ...o,
});
const ctx = (appMode: KeyContext['appMode'], textField: KeyContext['textField'] = null): KeyContext => ({ appMode, textField });

describe('classifyKey (6.2 single-letter keys)', () => {
  it('ignores untrusted events in every mode and context (9.1)', () => {
    for (const m of ['read', 'review', 'edit'] as const) {
      for (const tf of [null, 'card', 'edit'] as const) {
        expect(classifyKey(key('KeyN', { isTrusted: false }), ctx(m, tf))).toEqual({ kind: 'ignore' });
        expect(classifyKey(key('Escape', { isTrusted: false }), ctx(m, tf))).toEqual({ kind: 'ignore' });
      }
    }
  });

  it('in a text field runs no shortcut and keeps the key from the deck without preventing it', () => {
    for (const m of ['read', 'review', 'edit'] as const) {
      expect(classifyKey(key('KeyN'), ctx(m, 'card'))).toEqual({ kind: 'text', handle: null });
      expect(classifyKey(key('Digit1'), ctx(m, 'card'))).toEqual({ kind: 'text', handle: null });
      expect(classifyKey(key('ArrowRight'), ctx(m, 'card'))).toEqual({ kind: 'text', handle: null });
      // Wispr Flow's simulated Cmd+V: native paste must work, so it is a plain text-field key.
      expect(classifyKey(key('KeyV', { meta: true }), ctx(m, 'card'))).toEqual({ kind: 'text', handle: null });
      expect(classifyKey(key('KeyZ', { meta: true }), ctx(m, 'edit'))).toEqual({ kind: 'text', handle: null });
    }
  });

  it('handles only Esc and Cmd+Enter for cards', () => {
    expect(classifyKey(key('Escape'), ctx('review', 'card'))).toEqual({ kind: 'text', handle: 'close-card' });
    expect(classifyKey(key('Enter', { meta: true }), ctx('review', 'card'))).toEqual({ kind: 'text', handle: 'close-card' });
    expect(classifyKey(key('Enter', { ctrl: true }), ctx('edit', 'card'))).toEqual({ kind: 'text', handle: 'close-card' });
    expect(classifyKey(key('NumpadEnter', { meta: true }), ctx('review', 'card'))).toEqual({ kind: 'text', handle: 'close-card' });
    // Plain Enter types a newline in the card.
    expect(classifyKey(key('Enter'), ctx('review', 'card'))).toEqual({ kind: 'text', handle: null });
  });

  it('handles only Enter and Esc for the active edit', () => {
    expect(classifyKey(key('Enter'), ctx('edit', 'edit'))).toEqual({ kind: 'text', handle: 'commit-edit' });
    expect(classifyKey(key('Escape'), ctx('edit', 'edit'))).toEqual({ kind: 'text', handle: 'cancel-edit' });
    // Shift+Enter is ignored in v1 (6.3); Cmd+Enter is a card key, not an edit key.
    expect(classifyKey(key('Enter', { shift: true }), ctx('edit', 'edit'))).toEqual({ kind: 'text', handle: null });
    expect(classifyKey(key('Enter', { meta: true }), ctx('edit', 'edit'))).toEqual({ kind: 'text', handle: null });
  });

  it('hands a Space or Shift+Space in an edit field to the field, which types it itself on a <button> or <summary> (E-10)', () => {
    expect(classifyKey(key('Space'), ctx('edit', 'edit'))).toEqual({ kind: 'text', handle: 'edit-space' });
    // Shift+Space types a space too, and Chromium takes it as the button's activation all the same (finding 11,
    // re-verification: the space was lost and the commit wrote the text without it).
    expect(classifyKey(key('Space', { shift: true }), ctx('edit', 'edit'))).toEqual({ kind: 'text', handle: 'edit-space' });
    // With Cmd, Ctrl or Alt, in a card, or in an IME composition it is plain typing.
    for (const m of [{ meta: true }, { ctrl: true }, { alt: true }]) {
      expect(classifyKey(key('Space', m), ctx('edit', 'edit'))).toEqual({ kind: 'text', handle: null });
    }
    expect(classifyKey(key('Space'), ctx('review', 'card'))).toEqual({ kind: 'text', handle: null });
    expect(classifyKey(key('Space', { composing: true }), ctx('edit', 'edit'))).toEqual({ kind: 'text', handle: null });
  });

  it('keeps every key but a chord for the field that waits to open (E-1, finding 0 re-verification)', () => {
    const pending = { ...ctx('edit'), editPending: true };
    for (const code of ['KeyN', 'KeyJ', 'Space', 'ArrowRight', 'ArrowLeft', 'Enter', 'Backspace', 'Escape', 'Digit1', 'Slash']) {
      expect(classifyKey(key(code), pending), code).toEqual({ kind: 'pending' });
    }
    expect(classifyKey(key('KeyN', { shift: true }), pending)).toEqual({ kind: 'pending' });
    // Chords still pass (Cmd+Z, Wispr Flow's Cmd+V); a text field still has its keys; outside Edit it means nothing.
    expect(classifyKey(key('KeyZ', { meta: true }), pending)).toEqual({ kind: 'pass' });
    expect(classifyKey(key('KeyN'), { ...ctx('edit', 'card'), editPending: true })).toEqual({ kind: 'text', handle: null });
    expect(classifyKey(key('KeyN'), { ...ctx('review'), editPending: true })).toEqual({ kind: 'shortcut', action: 'new-note' });
    expect(classifyKey(key('KeyN', { isTrusted: false }), pending)).toEqual({ kind: 'ignore' });
  });

  it('leaves Esc and Enter to an IME composition', () => {
    expect(classifyKey(key('Escape', { composing: true }), ctx('review', 'card'))).toEqual({ kind: 'text', handle: null });
    expect(classifyKey(key('Enter', { composing: true }), ctx('edit', 'edit'))).toEqual({ kind: 'text', handle: null });
  });

  it('passes Meta, Ctrl and Alt chords through untouched outside text fields', () => {
    for (const m of ['read', 'review', 'edit'] as const) {
      expect(classifyKey(key('KeyV', { meta: true }), ctx(m))).toEqual({ kind: 'pass' });
      expect(classifyKey(key('KeyN', { ctrl: true }), ctx(m))).toEqual({ kind: 'pass' });
      expect(classifyKey(key('Digit1', { alt: true }), ctx(m))).toEqual({ kind: 'pass' });
      expect(classifyKey(key('Escape', { meta: true }), ctx(m))).toEqual({ kind: 'pass' });
    }
  });

  it('gives every key to the deck in Read mode', () => {
    for (const c of ['KeyV', 'KeyN', 'Digit1', 'Escape', 'Slash', 'ArrowRight', 'Space', 'KeyJ']) {
      expect(classifyKey(key(c), ctx('read'))).toEqual({ kind: 'pass' });
    }
    expect(classifyKey(key('Slash', { shift: true }), ctx('read'))).toEqual({ kind: 'pass' });
  });

  it('runs the Review shortcuts, matched on event.code', () => {
    const r = (c: string, o: Partial<KeyInput> = {}) => classifyKey(key(c, o), ctx('review'));
    expect(r('KeyV')).toEqual({ kind: 'shortcut', action: 'tool-select' });
    expect(r('Digit1')).toEqual({ kind: 'shortcut', action: 'tool-pen' });
    expect(r('Digit2')).toEqual({ kind: 'shortcut', action: 'tool-highlighter' });
    expect(r('Digit3')).toEqual({ kind: 'shortcut', action: 'tool-arrow' });
    expect(r('Digit4')).toEqual({ kind: 'shortcut', action: 'tool-pin' });
    expect(r('Digit5')).toEqual({ kind: 'shortcut', action: 'tool-box' });
    expect(r('KeyN')).toEqual({ kind: 'shortcut', action: 'new-note' });
    expect(r('KeyR')).toEqual({ kind: 'shortcut', action: 'suggest' });
    expect(r('KeyJ')).toEqual({ kind: 'shortcut', action: 'next-pin' });
    expect(r('KeyK')).toEqual({ kind: 'shortcut', action: 'prev-pin' });
    expect(r('Escape')).toEqual({ kind: 'shortcut', action: 'escape' });
    expect(r('Slash', { shift: true })).toEqual({ kind: 'shortcut', action: 'help' });
    // A shifted letter is the same physical key.
    expect(r('KeyN', { shift: true })).toEqual({ kind: 'shortcut', action: 'new-note' });
  });

  it('keeps V, 1–5 and R to Review; N, J, K, Esc and ? work in Edit too', () => {
    const e = (c: string, o: Partial<KeyInput> = {}) => classifyKey(key(c, o), ctx('edit'));
    expect(e('KeyV')).toEqual({ kind: 'swallow' });
    expect(e('Digit1')).toEqual({ kind: 'swallow' });
    expect(e('Digit5')).toEqual({ kind: 'swallow' });
    expect(e('KeyR')).toEqual({ kind: 'swallow' });
    expect(e('KeyN')).toEqual({ kind: 'shortcut', action: 'new-note' });
    expect(e('KeyJ')).toEqual({ kind: 'shortcut', action: 'next-pin' });
    expect(e('KeyK')).toEqual({ kind: 'shortcut', action: 'prev-pin' });
    expect(e('Escape')).toEqual({ kind: 'shortcut', action: 'escape' });
    expect(e('Slash', { shift: true })).toEqual({ kind: 'shortcut', action: 'help' });
  });

  it('forwards ← and → to the deck in Review and Edit, and keeps every other key from it', () => {
    for (const m of ['review', 'edit'] as const) {
      expect(classifyKey(key('ArrowLeft'), ctx(m))).toEqual({ kind: 'forward' });
      expect(classifyKey(key('ArrowRight', { shift: true }), ctx(m))).toEqual({ kind: 'forward' });
      for (const c of ['ArrowDown', 'ArrowUp', 'Space', 'PageDown', 'KeyA', 'Slash', 'Tab', 'Enter']) {
        expect(classifyKey(key(c), ctx(m))).toEqual({ kind: 'swallow' });
      }
    }
  });

  it('does not repeat N, R or Esc on auto-repeat (a held Esc is not a second Esc)', () => {
    expect(classifyKey(key('KeyN', { repeat: true }), ctx('review'))).toEqual({ kind: 'swallow' });
    expect(classifyKey(key('KeyR', { repeat: true }), ctx('review'))).toEqual({ kind: 'swallow' });
    expect(classifyKey(key('Escape', { repeat: true }), ctx('review'))).toEqual({ kind: 'swallow' });
    expect(classifyKey(key('KeyJ', { repeat: true }), ctx('review'))).toEqual({ kind: 'shortcut', action: 'next-pin' });
  });

  it('treats an unknown overlay field like a text field', () => {
    expect(classifyKey(key('KeyN'), ctx('review', 'other'))).toEqual({ kind: 'text', handle: null });
    expect(classifyKey(key('Escape'), ctx('review', 'other'))).toEqual({ kind: 'text', handle: null });
  });
});

describe("classifyKey: Edit's picker (P2-8)", () => {
  const picker = (textField: KeyContext['textField'] = null): KeyContext => ({ appMode: 'edit', textField, picker: true });

  it('takes the arrows, Tab, Enter, digits and Esc, and keeps every other key from the deck', () => {
    expect(classifyKey(key('ArrowDown'), picker())).toEqual({ kind: 'picker', key: { move: 1 } });
    expect(classifyKey(key('ArrowUp'), picker())).toEqual({ kind: 'picker', key: { move: -1 } });
    expect(classifyKey(key('Tab'), picker())).toEqual({ kind: 'picker', key: { move: 1 } });
    expect(classifyKey(key('Tab', { shift: true }), picker())).toEqual({ kind: 'picker', key: { move: -1 } });
    expect(classifyKey(key('Enter'), picker())).toEqual({ kind: 'picker', key: { choose: 'current' } });
    expect(classifyKey(key('NumpadEnter'), picker())).toEqual({ kind: 'picker', key: { choose: 'current' } });
    expect(classifyKey(key('Digit1'), picker())).toEqual({ kind: 'picker', key: { choose: 0 } });
    expect(classifyKey(key('Numpad9'), picker())).toEqual({ kind: 'picker', key: { choose: 8 } });
    expect(classifyKey(key('Escape'), picker())).toEqual({ kind: 'picker', key: 'cancel' });
    for (const code of ['KeyN', 'KeyJ', 'Slash', 'ArrowLeft', 'ArrowRight', 'Digit0', 'Space', 'PageDown']) {
      expect(classifyKey(key(code), picker()), code).toEqual({ kind: 'swallow' });
    }
  });

  it('a held Enter, Esc or digit does nothing more; modifier chords and untrusted keys are as everywhere', () => {
    expect(classifyKey(key('Enter', { repeat: true }), picker())).toEqual({ kind: 'swallow' });
    expect(classifyKey(key('Escape', { repeat: true }), picker())).toEqual({ kind: 'swallow' });
    expect(classifyKey(key('Digit2', { repeat: true }), picker())).toEqual({ kind: 'swallow' });
    expect(classifyKey(key('KeyV', { meta: true }), picker())).toEqual({ kind: 'pass' });
    expect(classifyKey(key('ArrowDown', { isTrusted: false }), picker())).toEqual({ kind: 'ignore' });
  });

  it("a text field keeps its keys, and the picker is only Edit's", () => {
    expect(classifyKey(key('Enter'), picker('edit'))).toEqual({ kind: 'text', handle: 'commit-edit' });
    expect(classifyKey(key('ArrowDown'), { appMode: 'review', textField: null, picker: true })).toEqual({ kind: 'swallow' });
  });
});
